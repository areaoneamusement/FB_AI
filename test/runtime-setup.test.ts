import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import { createOperatorAuth } from "../src/app/operator-auth.js";
import {
  ConfigError,
  RESEARCH_OVERALL_DEADLINE_MAX_MS,
  RESEARCH_PER_SOURCE_TIMEOUT_MAX_MS,
  buildCompositionConfig,
  categorize,
  resolveCompliance,
  scoreItem,
  validateRuntimeConfig,
} from "../src/app/runtime-config.js";
import type { RuntimeFileConfig } from "../src/app/runtime-config.js";
import type { AuthenticatedOperator } from "../src/dashboard/review-dashboard-api.js";
import type {
  DraftRevision,
  PlatformArtifact,
  ReproducibilityMetadata,
  ResearchResult,
} from "../src/domain/content.js";
import type { SourceReference } from "../src/domain/source.js";
import { DEFAULT_RESEARCH_AGGREGATION_OPTIONS } from "../src/pipeline/research-aggregator.js";
import type { CollectedSourceItem } from "../src/pipeline/source-collector.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");
const TOKEN = "0123456789abcdef0123";
const OPERATOR: AuthenticatedOperator = { id: "operator", role: "Admin" };

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const baseConfig: RuntimeFileConfig = {
  language: "vi",
  sources: [
    {
      id: "github-llm",
      type: "GitHub",
      url: "https://api.github.com/search/repositories?q=topic:llm",
      active: true,
      priority: 100,
      filterMode: "High",
    },
    {
      id: "blog",
      type: "Website",
      url: "https://example.test/feed.xml",
      active: false,
      priority: 40,
      filterMode: "All",
    },
  ],
  scoring: {
    version: "score-v1",
    minScore: 60,
    freshnessHorizonHours: 168,
    authorityStarTarget: 20_000,
    relevanceKeywords: ["ai", "llm", "agent"],
  },
  categories: {
    allowed: ["AI Tools", "AI News"],
    keywords: { "AI Tools": ["framework", "sdk"], "AI News": ["release"] },
    fallback: "AI News",
  },
  rendering: { rendererVersion: "renderer-v1", platforms: ["Facebook_Page"] },
  compliance: {
    evaluatorVersion: "compliance-v1",
    ruleSetVersion: "rules-v1",
    bannedKeywords: ["cam kết lợi nhuận"],
    termsVersion: "terms-v1",
    attributionRequiredSourceIds: ["github-llm"],
  },
};

function collected(overrides: Partial<CollectedSourceItem> = {}): CollectedSourceItem {
  return {
    sourceId: "github-llm",
    externalId: "1",
    normalizedContentHash: "hash",
    publishedOrUpdatedAt: NOW.toISOString(),
    title: "acme/agent",
    body: "An LLM agent framework",
    permission: {
      allowed: true,
      termsVersion: "terms-v1",
      robotsCapturedAt: NOW.toISOString(),
    },
    collectedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("createOperatorAuth", () => {
  it("rejects a token shorter than the minimum at construction time", () => {
    expect(() => createOperatorAuth({ token: "short" })).toThrow(/16 ký tự/);
  });

  it("accepts the operator token from an Authorization header", async () => {
    const auth = createOperatorAuth({ token: TOKEN });
    await expect(auth.authenticate(request({ authorization: `Bearer ${TOKEN}` }))).resolves.toEqual({
      id: "operator",
      role: "Admin",
    });
  });

  it("accepts the token from the x-operator-token header", async () => {
    const auth = createOperatorAuth({ token: TOKEN });
    await expect(auth.authenticate(request({ "x-operator-token": TOKEN }))).resolves.toMatchObject({
      role: "Admin",
    });
  });

  it("rejects a missing token", async () => {
    const auth = createOperatorAuth({ token: TOKEN });
    await expect(auth.authenticate(request())).rejects.toThrow(/operator token/);
  });

  it("rejects a wrong token of the same length", async () => {
    const auth = createOperatorAuth({ token: TOKEN });
    await expect(
      auth.authenticate(request({ authorization: `Bearer ${"f".repeat(TOKEN.length)}` })),
    ).rejects.toThrow(/operator token/);
  });

  it("issues a CSRF token that validates", async () => {
    const auth = createOperatorAuth({ token: TOKEN, csrfSecret: "secret", now: () => NOW });
    const token = await auth.issueCsrfToken(request(), OPERATOR);
    await expect(auth.validateCsrfToken(request(), OPERATOR, token)).resolves.toBe(true);
  });

  it("rejects a CSRF token issued for a different operator", async () => {
    const auth = createOperatorAuth({ token: TOKEN, csrfSecret: "secret", now: () => NOW });
    const token = await auth.issueCsrfToken(request(), OPERATOR);
    await expect(
      auth.validateCsrfToken(request(), { id: "someone-else", role: "Admin" }, token),
    ).resolves.toBe(false);
  });

  it("rejects an expired CSRF token", async () => {
    let clock = NOW.getTime();
    const auth = createOperatorAuth({
      token: TOKEN,
      csrfSecret: "secret",
      csrfTtlMs: 1_000,
      now: () => new Date(clock),
    });
    const token = await auth.issueCsrfToken(request(), OPERATOR);
    clock += 2_000;
    await expect(auth.validateCsrfToken(request(), OPERATOR, token)).resolves.toBe(false);
  });

  it("rejects a tampered CSRF signature", async () => {
    const auth = createOperatorAuth({ token: TOKEN, csrfSecret: "secret", now: () => NOW });
    const token = await auth.issueCsrfToken(request(), OPERATOR);
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    await expect(auth.validateCsrfToken(request(), OPERATOR, tampered)).resolves.toBe(false);
  });

  it("rejects a malformed CSRF token", async () => {
    const auth = createOperatorAuth({ token: TOKEN, csrfSecret: "secret", now: () => NOW });
    await expect(auth.validateCsrfToken(request(), OPERATOR, "garbage")).resolves.toBe(false);
  });
});

describe("validateRuntimeConfig", () => {
  it("accepts the shipped shape", () => {
    expect(validateRuntimeConfig(baseConfig)).toBe(baseConfig);
  });

  it("rejects duplicate source ids", () => {
    const sources = [baseConfig.sources[0]!, { ...baseConfig.sources[0]! }];
    expect(() => validateRuntimeConfig({ ...baseConfig, sources })).toThrow(ConfigError);
  });

  it("rejects a non-https source", () => {
    const sources = [{ ...baseConfig.sources[0]!, url: "http://insecure.test" }];
    expect(() => validateRuntimeConfig({ ...baseConfig, sources })).toThrow(/https/);
  });

  it("rejects a config with no active source", () => {
    const sources = baseConfig.sources.map((source) => ({ ...source, active: false }));
    expect(() => validateRuntimeConfig({ ...baseConfig, sources })).toThrow(/active/);
  });

  it("rejects a fallback category outside the allowed list", () => {
    expect(() =>
      validateRuntimeConfig({
        ...baseConfig,
        categories: { ...baseConfig.categories, fallback: "Không có" },
      }),
    ).toThrow(/fallback/);
  });

  it("rejects a config with no render targets", () => {
    expect(() =>
      validateRuntimeConfig({ ...baseConfig, rendering: { rendererVersion: "v1", platforms: [] } }),
    ).toThrow(/platforms/);
  });

  it("rejects research timeouts above what ResearchAggregator accepts", () => {
    expect(() =>
      validateRuntimeConfig({
        ...baseConfig,
        research: { perSourceTimeoutMs: RESEARCH_PER_SOURCE_TIMEOUT_MAX_MS + 1 },
      }),
    ).toThrow(/perSourceTimeoutMs/);

    expect(() =>
      validateRuntimeConfig({
        ...baseConfig,
        research: { overallDeadlineMs: RESEARCH_OVERALL_DEADLINE_MAX_MS + 1 },
      }),
    ).toThrow(/overallDeadlineMs/);
  });

  it("accepts research timeouts at the ceiling", () => {
    expect(() =>
      validateRuntimeConfig({
        ...baseConfig,
        research: {
          perSourceTimeoutMs: RESEARCH_PER_SOURCE_TIMEOUT_MAX_MS,
          overallDeadlineMs: RESEARCH_OVERALL_DEADLINE_MAX_MS,
        },
      }),
    ).not.toThrow();
  });
});

describe("the shipped config file", () => {
  it("passes validation", async () => {
    // The first live run failed because config/fb-ai.config.json set research timeouts
    // above ResearchAggregator's ceiling. Nothing checked the shipped file until then.
    const raw = await readFile(
      new URL("../config/fb-ai.config.json", import.meta.url),
      "utf8",
    );
    expect(() => validateRuntimeConfig(JSON.parse(raw), "config/fb-ai.config.json")).not.toThrow();
  });
});

describe("research ceilings", () => {
  it("match the values ResearchAggregator enforces", () => {
    // These are duplicated so the config can be rejected at startup rather than mid-cycle.
    // If the aggregator's limits move, this fails instead of drifting silently.
    expect(RESEARCH_PER_SOURCE_TIMEOUT_MAX_MS).toBe(
      DEFAULT_RESEARCH_AGGREGATION_OPTIONS.perSourceTimeoutMs,
    );
    expect(RESEARCH_OVERALL_DEADLINE_MAX_MS).toBe(
      DEFAULT_RESEARCH_AGGREGATION_OPTIONS.overallDeadlineMs,
    );
  });
});

describe("scoreItem", () => {
  it("scores a brand-new item's freshness at 100 and an expired one at 0", () => {
    expect(scoreItem(collected(), baseConfig, NOW).freshness).toBe(100);
    const stale = collected({ publishedOrUpdatedAt: "2026-01-01T00:00:00.000Z" });
    expect(scoreItem(stale, baseConfig, NOW).freshness).toBe(0);
  });

  it("keeps every criterion inside [0, 100]", () => {
    const values = scoreItem(
      collected({ github: { stars: 5_000_000, lastUpdatedAt: NOW.toISOString() } }),
      baseConfig,
      NOW,
    );
    for (const value of Object.values(values)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("ranks a more-starred repository above a less-starred one", () => {
    const many = scoreItem(
      collected({ github: { stars: 10_000, lastUpdatedAt: NOW.toISOString() } }),
      baseConfig,
      NOW,
    ).authority!;
    const few = scoreItem(
      collected({ github: { stars: 100, lastUpdatedAt: NOW.toISOString() } }),
      baseConfig,
      NOW,
    ).authority!;
    expect(many).toBeGreaterThan(few);
  });

  it("falls back to the configured source priority when there are no stars", () => {
    const values = scoreItem(collected({ sourceId: "blog" }), baseConfig, NOW);
    expect(values.authority).toBe(40);
  });

  it("raises relevance with each distinct keyword hit", () => {
    const offTopic = scoreItem(
      collected({ title: "recipe book", body: "cooking instructions" }),
      baseConfig,
      NOW,
    ).relevance!;
    const onTopic = scoreItem(
      collected({ title: "ai llm agent", body: "" }),
      baseConfig,
      NOW,
    ).relevance!;
    expect(offTopic).toBe(0);
    expect(onTopic).toBe(100);
  });
});

describe("categorize", () => {
  it("assigns every category whose keywords match", () => {
    expect(categorize(collected({ title: "framework release" }), baseConfig)).toEqual([
      "AI Tools",
      "AI News",
    ]);
  });

  it("falls back when nothing matches", () => {
    expect(categorize(collected({ title: "xyz", body: "" }), baseConfig)).toEqual(["AI News"]);
  });

  it("only ever returns allowed categories", () => {
    for (const category of categorize(collected(), baseConfig)) {
      expect(baseConfig.categories.allowed).toContain(category);
    }
  });
});

describe("resolveCompliance", () => {
  const sourceRef: SourceReference = {
    sourceId: "github-llm",
    captureId: "capture-1",
    url: "https://github.com/acme/agent",
    capturedAt: NOW.toISOString(),
    termsVersion: "terms-v1",
  };
  const research: ResearchResult = {
    id: "research-1",
    topicId: "topic-1",
    items: [
      { id: "item-1", content: "Nội dung nguồn", kind: "Summarized", evidenceRefs: [sourceRef] },
    ],
    status: "Ok",
    unreachableSources: [],
    skippedSources: [],
  };
  const artifact = { platform: "Facebook_Page" } as unknown as PlatformArtifact;
  const revision = {} as unknown as DraftRevision;

  it("builds one banned-keyword rule per configured phrase, scoped to the artifact's platform", () => {
    const resolved = resolveCompliance(artifact, revision, research, baseConfig);
    expect(resolved.ruleSet?.rules).toHaveLength(1);
    expect(resolved.ruleSet?.rules[0]?.platform).toBe("Facebook_Page");
    expect(resolved.ruleSet?.rules[0]?.parameters).toEqual({ keywords: ["cam kết lợi nhuận"] });
  });

  it("turns research evidence into copyright captures", () => {
    const resolved = resolveCompliance(artifact, revision, research, baseConfig);
    expect(resolved.sourceCaptures).toEqual([
      {
        sourceId: "github-llm",
        captureId: "capture-1",
        termsVersion: "terms-v1",
        url: "https://github.com/acme/agent",
        content: "Nội dung nguồn",
      },
    ]);
  });

  it("requires attribution for the configured sources", () => {
    const resolved = resolveCompliance(artifact, revision, research, baseConfig);
    expect(resolved.sourceTerms).toEqual([
      {
        sourceId: "github-llm",
        version: "terms-v1",
        attributionRequired: true,
        requiredAttributionUrl: "https://api.github.com/search/repositories?q=topic:llm",
      },
    ]);
  });
});

describe("buildCompositionConfig", () => {
  const modelA: ReproducibilityMetadata = {
    provider: "anthropic",
    model: "claude-opus-5",
    promptVersion: "a",
    configurationVersion: "a",
  };
  const modelB: ReproducibilityMetadata = {
    provider: "google",
    model: "gemini-2.5-pro",
    promptVersion: "b",
    configurationVersion: "b",
  };

  it("carries the operator's settings into the composition root's shape", () => {
    const config = buildCompositionConfig({
      file: baseConfig,
      sqlitePath: "/tmp/db.sqlite",
      staticDirectory: "/tmp/static",
      modelA,
      modelB,
      dashboardHttp: {
        authenticate: async () => OPERATOR,
        issueCsrfToken: async () => "token",
        validateCsrfToken: async () => true,
      },
      now: () => NOW,
    });

    expect(config.sqlitePath).toBe("/tmp/db.sqlite");
    expect(config.sources).toBe(baseConfig.sources);
    expect(config.scoring.minScore).toBe(60);
    expect(config.generation.language).toBe("vi");
    expect(config.verification.requestedModel).toBe(modelB);
    // Corrections are Model A's job — Model B never rewrites content.
    expect(config.verification.requestedCorrectionModel).toBe(modelA);
    expect(config.dashboardHttp.staticDirectory).toBe("/tmp/static");
  });

  it("weights the scoring criteria to exactly 100 percent", () => {
    const config = buildCompositionConfig({
      file: baseConfig,
      sqlitePath: ":memory:",
      staticDirectory: "/tmp/static",
      modelA,
      modelB,
      dashboardHttp: {
        authenticate: async () => OPERATOR,
        issueCsrfToken: async () => "token",
        validateCsrfToken: async () => true,
      },
    });
    const total = config.scoring.config.criteria.reduce(
      (sum, criterion) => sum + criterion.weightPercent,
      0,
    );
    expect(total).toBe(100);
  });
});
