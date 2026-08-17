import { describe, expect, it } from "vitest";

import {
  FakeModelAGenerationClient,
  FakeModelBCritiqueClient,
  FakeSourceFetcher,
} from "../src/adapters/fakes.js";
import {
  createMvpApplication,
  type MvpApplication,
  type MvpCompositionConfig,
} from "../src/app/mvp-composition-root.js";
import type { ContentDraft, ReproducibilityMetadata } from "../src/domain/content.js";
import type { SourceConfig } from "../src/domain/source.js";
import type { CollectedSourceItem } from "../src/pipeline/source-collector.js";
import type { ModelACorrectionPort } from "../src/pipeline/verification-engine.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");

const MODEL_A: ReproducibilityMetadata = {
  provider: "fake-a",
  model: "generator-a",
  promptVersion: "prompt-a-v1",
  configurationVersion: "config-a-v1",
};
const MODEL_B: ReproducibilityMetadata = {
  provider: "fake-b",
  model: "critic-b",
  promptVersion: "prompt-b-v1",
  configurationVersion: "config-b-v1",
};

const source: SourceConfig = {
  id: "github-main",
  type: "GitHub",
  url: "https://origin.test/repository",
  active: true,
  priority: 100,
  filterMode: "Best",
};

/** Item `n` scores lower than item `n - 1`, so ranking is observable in the outcome. */
const ITEM_COUNT = 5;

function generatedContent(topicId: string, originUrl: string): ContentDraft {
  return {
    topicId,
    facebookPost: "Bản tin AI hữu ích cho cộng đồng, có kiểm chứng và nguồn rõ ràng. ".repeat(2),
    guide: ["Khởi động", "Thực hành", "Đánh giá"].map((heading) => ({
      heading,
      body: `Nội dung hướng dẫn cho phần ${heading}.`,
      imageSuggestions: [{ description: `Minh họa chi tiết cho phần ${heading}` }],
    })),
    videoScript: {
      intro: "Giới thiệu cập nhật AI.",
      body: "Phân tích nội dung chính.",
      conclusion: "Tổng kết và khuyến nghị.",
    },
    originLinks: [originUrl],
    language: "vi",
  };
}

interface Harness {
  readonly app: MvpApplication;
  /** How many topics actually reached Model A — the cost the budget is there to bound. */
  readonly generateCalls: () => number;
}

function createHarness(maxTopicsPerCycle: number | undefined): Harness {
  const fetcher = new FakeSourceFetcher({
    fetch: (config) => ({
      items: Array.from({ length: ITEM_COUNT }, (_unused, index) => ({
        sourceId: config.id,
        externalId: `release-${index}`,
        canonicalUrl: `${config.url}/release-${index}`,
        normalizedContentHash: `capture-release-${index}`,
        publishedOrUpdatedAt: NOW.toISOString(),
        title: `AI release ${index}`,
        body: "Research evidence for the release.",
        github: { stars: 500, lastUpdatedAt: NOW.toISOString(), changelog: "v1" },
      })),
    }),
    isAllowed: () => ({
      allowed: true,
      termsVersion: "terms-v1",
      robotsCapturedAt: NOW.toISOString(),
    }),
  });

  let generateCalls = 0;
  const modelA = new FakeModelAGenerationClient(
    (request) => {
      generateCalls += 1;
      return {
        content: generatedContent(request.topic.id, request.topic.sourceRef.url),
        provenance: MODEL_A,
      };
    },
    () => NOW.getTime(),
  );
  const modelACorrection: ModelACorrectionPort = {
    correct: async () => {
      throw new Error("correction is not expected here");
    },
  };
  const modelB = new FakeModelBCritiqueClient(
    (request) => ({
      provenance: MODEL_B,
      findings: request.claims.map(({ id }) => ({
        claimId: id,
        verdict: "Pass" as const,
        evidenceRefs: [request.research.items[0]!.evidenceRefs[0]!],
      })),
    }),
    () => NOW.getTime(),
  );

  const config: MvpCompositionConfig = {
    sources: [source],
    collection: { windowHours: 24, maxRetries: 1 },
    scoring: {
      config: {
        version: "score-v1",
        criteria: [
          { id: "freshness", weightPercent: 40 },
          { id: "authority", weightPercent: 30 },
          { id: "relevance", weightPercent: 30 },
        ],
      },
      minScore: 70,
      valuesFor: (item: CollectedSourceItem) => ({
        freshness: 100 - 10 * rankOf(item),
        authority: 90,
        relevance: 100,
      }),
    },
    research: { minItems: 1 },
    ...(maxTopicsPerCycle === undefined ? {} : { maxTopicsPerCycle }),
    generation: { requestedModel: MODEL_A },
    verification: { requestedModel: MODEL_B, requestedCorrectionModel: MODEL_A },
    rendering: { rendererVersion: "renderer-v1", platforms: ["Facebook_Page"] },
    compliance: {
      evaluatorVersion: "compliance-v1",
      resolve: (artifact) => ({
        ruleSet: {
          version: "rules-v1",
          rules: [{
            id: `forbidden-${artifact.platform}`,
            platform: artifact.platform,
            version: "1",
            kind: "Keyword",
            parameters: { keywords: ["nội dung bị cấm tuyệt đối"] },
            effectiveFrom: "2020-01-01T00:00:00.000Z",
          }],
        },
        sourceTerms: [{
          sourceId: source.id,
          version: "terms-v1",
          attributionRequired: false,
        }],
        sourceCaptures: [{
          sourceId: source.id,
          captureId: "copyright-capture-1",
          termsVersion: "terms-v1",
          url: source.url,
          content: "completely unrelated vocabulary for copyright comparison",
        }],

      }),
    },
    categories: { allowed: ["AI News"], selectFor: () => ["AI News"] },
    dashboardHttp: {
      authenticate: async () => ({ id: "operator-1", role: "Operator" }),
      issueCsrfToken: async () => "csrf-test",
      validateCsrfToken: async (_request, _operator, token) => token === "csrf-test",
    },
    now: () => NOW,
  };

  const app = createMvpApplication(config, {
    sourceFetcher: fetcher,
    modelA,
    modelACorrection,
    modelB,
  });
  return { app, generateCalls: () => generateCalls };
}

function rankOf(item: CollectedSourceItem): number {
  return Number(item.externalId.replace("release-", ""));
}

describe("per-cycle topic budget", () => {
  it("processes only the highest-scoring topics and defers the rest", async () => {
    // Everything past scoring costs quota: research re-fetches every source per topic and
    // both model providers run per topic. Without a cap a busy collection spends the whole
    // rate limit before anything reaches review — the failure the first live run hit.
    const { app, generateCalls } = createHarness(2);
    try {
      const cycle = await app.pipeline.runCycle();

      expect(cycle.items).toHaveLength(ITEM_COUNT);
      expect(cycle.items.map((item) => item.kind)).toEqual([
        "PendingReview",
        "PendingReview",
        "Deferred",
        "Deferred",
        "Deferred",
      ]);
      expect(generateCalls()).toBe(2);
    } finally {
      app.close();
    }
  });

  it("defers the lowest-scoring topics, not whichever arrived last", async () => {
    const { app } = createHarness(2);
    try {
      const cycle = await app.pipeline.runCycle();
      const deferred = cycle.items.filter((item) => item.kind === "Deferred");
      expect(deferred.map((item) => (item as { topic: { score: { total: number } } }).topic.score.total))
        .toEqual([89, 85, 81]);
    } finally {
      app.close();
    }
  });

  it("falls back to the shipped default rather than processing everything", async () => {
    const { app, generateCalls } = createHarness(undefined);
    try {
      await app.pipeline.runCycle();
      expect(generateCalls()).toBe(3);
    } finally {
      app.close();
    }
  });
});
