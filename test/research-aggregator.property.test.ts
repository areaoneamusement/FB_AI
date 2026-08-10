import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SourceFetcher } from "../src/adapters/ports.js";
import type { ResearchItem, ResearchResult, Topic } from "../src/domain/content.js";
import type {
  FetchPage,
  RawItem,
  SourceConfig,
  SourcePermission,
  SourceType,
} from "../src/domain/source.js";
import {
  DEFAULT_RESEARCH_AGGREGATION_OPTIONS,
  ResearchAggregator,
} from "../src/pipeline/research-aggregator.js";

const NOW = new Date("2025-04-01T12:00:00.000Z");
const ORIGIN_ID = "origin";
const TERMS_VERSION = "terms-v2";
const RESEARCH_KINDS: readonly ResearchItem["kind"][] = [
  "Quoted",
  "Summarized",
  "Inferred",
];
/** Keys the design allows on a ResearchResult artifact; workflow state is excluded. */
const RESULT_KEYS = new Set([
  "id",
  "topicId",
  "items",
  "status",
  "reason",
  "unreachableSources",
]);
const WORKFLOW_KEYS = ["stage", "workStatus", "version", "blockedReason"];

const permitted: SourcePermission = {
  allowed: true,
  termsVersion: TERMS_VERSION,
  robotsCapturedAt: NOW.toISOString(),
};

afterEach(() => vi.useRealTimers());

function source(
  id: string,
  active: boolean,
  type: SourceType = "Website",
): SourceConfig {
  return {
    id,
    type,
    url: `https://example.test/${id}`,
    active,
    priority: 1,
    filterMode: "Best",
  };
}

function topicFor(origin: SourceConfig | undefined): Topic {
  const sourceId = origin?.id ?? ORIGIN_ID;
  return {
    id: "topic-1",
    sourceRef: {
      sourceId,
      captureId: "selected-origin-capture",
      url: `https://example.test/${sourceId}`,
      capturedAt: "2025-03-31T12:00:00.000Z",
      termsVersion: "terms-v1",
    },
    externalId: "topic-external-1",
    title: "Công cụ AI mới",
    createdAt: "2025-03-31T12:00:00.000Z",
    score: { total: 90, breakdown: [], scoringConfigVersion: "score-v1" },
    categories: ["AI Tools"],
  };
}

function aggregator(fetcher: SourceFetcher): ResearchAggregator {
  let sequence = 0;
  return new ResearchAggregator(fetcher, {
    now: () => NOW,
    createId: (kind) => `${kind}-${++sequence}`,
  });
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

type RelatedBehavior = "ok" | "fail" | "disallowed" | "inactive";
type OriginMode = "reachable" | "failing" | "inactive" | "absent";

interface Scenario {
  readonly configuredMinItems: number | undefined;
  readonly originMode: OriginMode;
  /** Distance of the collected total from minItems: -1 / 0 / +1 boundaries. */
  readonly itemOffset: number;
  readonly related: readonly RelatedBehavior[];
  readonly text: string;
  readonly emptyBody: boolean;
  readonly pagedOrigin: boolean;
  readonly sourceType: SourceType;
}

/** Vietnamese and other non-ASCII payloads alongside plain ASCII. */
const textArb = fc.constantFrom(
  "Bản cập nhật mới của công cụ AI được phát hành hôm nay",
  "Hướng dẫn sử dụng mô hình ngôn ngữ 🇻🇳",
  "Đánh giá chi tiết: hiệu năng & chi phí — kèm ví dụ",
  "plain ascii research body",
  "混合内容 カタカナ and ASCII",
  "  khoảng trắng đầu cuối  ",
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  configuredMinItems: fc.constantFrom<number | undefined>(
    undefined,
    1,
    2,
    3,
    4,
    5,
  ),
  originMode: fc.constantFrom<OriginMode>(
    "reachable",
    "reachable",
    "reachable",
    "failing",
    "inactive",
    "absent",
  ),
  itemOffset: fc.constantFrom(-1, 0, 1, 3),
  related: fc.array(
    fc.constantFrom<RelatedBehavior>("ok", "fail", "disallowed", "inactive"),
    { maxLength: 4 },
  ),
  text: textArb,
  emptyBody: fc.boolean(),
  pagedOrigin: fc.boolean(),
  sourceType: fc.constantFrom<SourceType>("GitHub", "Website", "Forum"),
});

interface Plan {
  readonly minItems: number;
  readonly sources: readonly SourceConfig[];
  readonly topic: Topic;
  readonly origin: SourceConfig | undefined;
  readonly originUsable: boolean;
  /** sourceId -> number of items the source will return. */
  readonly itemCounts: ReadonlyMap<string, number>;
  readonly failingRelatedIds: readonly string[];
  readonly contributingIds: readonly string[];
  readonly expectedItemCount: number;
  readonly fetcher: SourceFetcher;
}

function planFor(scenario: Scenario): Plan {
  const minItems =
    scenario.configuredMinItems ?? DEFAULT_RESEARCH_AGGREGATION_OPTIONS.minItems;
  const origin =
    scenario.originMode === "absent"
      ? undefined
      : source(ORIGIN_ID, scenario.originMode !== "inactive", scenario.sourceType);
  const relatedSources = scenario.related.map((behavior, index) =>
    source(`related-${index}`, behavior !== "inactive", scenario.sourceType),
  );
  const behaviorById = new Map<string, RelatedBehavior>(
    scenario.related.map((behavior, index) => [`related-${index}`, behavior]),
  );

  const okRelatedIds = relatedSources
    .map(({ id }) => id)
    .filter((id) => behaviorById.get(id) === "ok");
  const total = Math.max(0, minItems + scenario.itemOffset);
  const contributors = [ORIGIN_ID, ...okRelatedIds];
  const itemCounts = new Map<string, number>(
    contributors.map((id) => [id, 0] as const),
  );
  for (let index = 0; index < total; index += 1) {
    const id = contributors[index % contributors.length] as string;
    itemCounts.set(id, (itemCounts.get(id) ?? 0) + 1);
  }
  // Failing / disallowed / inactive related sources still get item counts so a
  // "would have contributed" source is distinguishable from an empty one.
  for (const { id } of relatedSources) {
    if (!itemCounts.has(id)) itemCounts.set(id, 2);
  }

  const originUsable = scenario.originMode === "reachable";
  const failingRelatedIds = originUsable
    ? relatedSources
        .map(({ id }) => id)
        .filter((id) => behaviorById.get(id) === "fail")
    : [];

  const fetcher: SourceFetcher = {
    async isAllowed(config) {
      return behaviorById.get(config.id) === "disallowed"
        ? {
            ...permitted,
            allowed: false,
            reason: "robots.txt cấm truy cập",
          }
        : permitted;
    },
    async fetch(config, cursor): Promise<FetchPage> {
      const behavior = behaviorById.get(config.id);
      if (config.id === ORIGIN_ID) {
        if (scenario.originMode === "failing") {
          throw new Error("origin offline");
        }
        return originPage(config, scenario, itemCounts.get(config.id) ?? 0, cursor);
      }
      if (behavior === "fail") throw new Error(`related ${config.id} offline`);
      return {
        items: itemsFor(config.id, itemCounts.get(config.id) ?? 0, scenario),
      };
    },
  };

  const expectedItemCount = originUsable
    ? contributors.reduce((sum, id) => sum + (itemCounts.get(id) ?? 0), 0)
    : 0;

  return {
    minItems,
    sources: origin === undefined ? relatedSources : [origin, ...relatedSources],
    topic: topicFor(origin),
    origin,
    originUsable,
    itemCounts,
    failingRelatedIds,
    contributingIds: originUsable ? contributors : [],
    expectedItemCount,
    fetcher,
  };
}

function originPage(
  config: SourceConfig,
  scenario: Scenario,
  count: number,
  cursor: { readonly cursor?: string } | undefined,
): FetchPage {
  const all = itemsFor(config.id, count, scenario);
  if (!scenario.pagedOrigin || all.length < 2) return { items: all };
  if (cursor === undefined) {
    return {
      items: all.slice(0, 1),
      nextCursor: {
        sourceId: config.id,
        cursor: "page-2",
        updatedAt: NOW.toISOString(),
      },
    };
  }
  return { items: all.slice(1) };
}

function itemsFor(
  sourceId: string,
  count: number,
  scenario: Scenario,
): readonly RawItem[] {
  return Array.from({ length: count }, (_unused, index) => {
    const externalId = `${sourceId}-item-${index}`;
    const raw: RawItem = {
      sourceId,
      externalId,
      canonicalUrl: `https://example.test/${sourceId}/${externalId}`,
      normalizedContentHash: `hash-${externalId}`,
      publishedOrUpdatedAt: NOW.toISOString(),
      title: `${scenario.text} #${index}`,
      body: scenario.emptyBody ? "" : `${scenario.text} — nội dung ${index}`,
    };
    return raw;
  });
}

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

/**
 * Authoritative design rule: processors return artifacts and never mutate
 * workflow state.
 */
function expectArtifactOnly(
  result: ResearchResult,
  before: { readonly topic: Topic; readonly sources: readonly SourceConfig[] },
  after: { readonly topic: Topic; readonly sources: readonly SourceConfig[] },
): void {
  for (const key of Object.keys(result)) {
    expect(RESULT_KEYS.has(key), `unexpected result key ${key}`).toBe(true);
  }
  for (const key of WORKFLOW_KEYS) {
    expect(result).not.toHaveProperty(key);
  }
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.items)).toBe(true);
  expect(Object.isFrozen(result.unreachableSources)).toBe(true);
  expect(after.topic).toEqual(before.topic);
  expect(after.sources).toEqual(before.sources);
}

async function run(
  plan: Plan,
  scenario: Scenario,
): Promise<ResearchResult> {
  const before = structuredClone({ topic: plan.topic, sources: plan.sources });
  const result = await aggregator(plan.fetcher).aggregate(
    plan.topic,
    plan.sources,
    scenario.configuredMinItems === undefined
      ? {}
      : { minItems: scenario.configuredMinItems },
  );
  expectArtifactOnly(result, before, { topic: plan.topic, sources: plan.sources });
  return result;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("ResearchAggregator properties", () => {
  it(
    "Property 11: every research item has provenance",
    async () => {
      // Feature: fb-ai, Property 11: Every research item has provenance — a source reference and a kind label distinguishing source-derived (Quoted/Summarized) from Inferred; inferred items additionally carry model provenance
      // **Validates: Requirements 3.2, 3.3**
      await fc.assert(
        fc.asyncProperty(scenarioArb, async (scenario) => {
          const plan = planFor(scenario);
          const result = await run(plan, scenario);
          const configuredIds = new Set(plan.sources.map(({ id }) => id));

          for (const item of result.items) {
            expect(item.id.length).toBeGreaterThan(0);
            expect(item.content.length).toBeGreaterThan(0);
            expect(RESEARCH_KINDS).toContain(item.kind);
            expect(item.evidenceRefs.length).toBeGreaterThanOrEqual(1);

            for (const ref of item.evidenceRefs) {
              expect(configuredIds.has(ref.sourceId)).toBe(true);
              expect(ref.captureId.length).toBeGreaterThan(0);
              expect(ref.url.length).toBeGreaterThan(0);
              expect(ref.termsVersion).toBe(TERMS_VERSION);
              expect(Number.isFinite(Date.parse(ref.capturedAt))).toBe(true);
            }

            if (item.kind === "Inferred") {
              const provenance = item.modelProvenance;
              expect(provenance).toBeDefined();
              expect(provenance?.provider.length ?? 0).toBeGreaterThan(0);
              expect(provenance?.model.length ?? 0).toBeGreaterThan(0);
              expect(provenance?.promptVersion.length ?? 0).toBeGreaterThan(0);
            }
          }
        }),
        { numRuns: 100 },
      );
    },
    30_000,
  );

  it(
    "Property 12: insufficient data excludes a topic from generation",
    async () => {
      // Feature: fb-ai, Property 12: Insufficient data excludes a topic from generation — fewer than minItems (default 3), or an unreachable origin source, yields status InsufficientData with a recorded reason and no advanceable result
      // **Validates: Requirements 3.4, 3.6**
      const seen = new Set<string>();
      await fc.assert(
        fc.asyncProperty(scenarioArb, async (scenario) => {
          const plan = planFor(scenario);
          seen.add(`origin:${scenario.originMode}`);
          seen.add(`offset:${scenario.itemOffset}`);
          for (const behavior of scenario.related) seen.add(`related:${behavior}`);
          const result = await run(plan, scenario);

          // Expected counts come from the scenario, not from the result.
          const originUnavailable = !plan.originUsable;
          const tooFewItems = plan.expectedItemCount < plan.minItems;
          const expectInsufficient = originUnavailable || tooFewItems;
          expect(result.items).toHaveLength(plan.expectedItemCount);

          expect(result.status).toBe(
            expectInsufficient ? "InsufficientData" : "Ok",
          );
          if (expectInsufficient) {
            expect((result.reason ?? "").trim().length).toBeGreaterThan(0);
            if (originUnavailable) {
              expect(result.reason).toContain(plan.topic.sourceRef.sourceId);
              expect(result.items).toEqual([]);
              expect(
                result.unreachableSources.map(({ sourceId }) => sourceId),
              ).toEqual([plan.topic.sourceRef.sourceId]);
            } else {
              expect(result.reason).toContain(String(plan.minItems));
            }
          } else {
            expect(result.reason).toBeUndefined();
            expect(result.items.length).toBeGreaterThanOrEqual(plan.minItems);
          }
          expect(result.topicId).toBe(plan.topic.id);
        }),
        { numRuns: 100 },
      );

      // The mandated edge cases really were generated.
      for (const required of [
        "origin:reachable",
        "origin:failing",
        "origin:inactive",
        "origin:absent",
        "offset:-1",
        "offset:0",
        "offset:1",
        "related:ok",
        "related:fail",
        "related:disallowed",
        "related:inactive",
      ]) {
        expect([...seen]).toContain(required);
      }
    },
    30_000,
  );

  it(
    "Property 13: an unreachable related source does not abort aggregation",
    async () => {
      // Feature: fb-ai, Property 13: An unreachable related source does not abort aggregation; it is recorded in unreachableSources while remaining sources still contribute
      // **Validates: Requirements 3.5**
      await fc.assert(
        fc.asyncProperty(
          scenarioArb.filter(({ originMode }) => originMode === "reachable"),
          async (scenario) => {
            const plan = planFor(scenario);
            const result = await run(plan, scenario);

            expect(
              [...result.unreachableSources].map(({ sourceId }) => sourceId).sort(),
            ).toEqual([...plan.failingRelatedIds].sort());
            for (const ref of result.unreachableSources) {
              expect(ref.captureId).toBe(`unreachable:${ref.sourceId}`);
              expect(ref.termsVersion).toBe(TERMS_VERSION);
            }

            // Every reachable, permitted source still contributed its items.
            const contributed = new Map<string, number>();
            for (const item of result.items) {
              const id = item.evidenceRefs[0]?.sourceId ?? "";
              contributed.set(id, (contributed.get(id) ?? 0) + 1);
            }
            for (const id of plan.contributingIds) {
              expect(contributed.get(id) ?? 0).toBe(plan.itemCounts.get(id) ?? 0);
            }
            expect(result.items.length).toBe(plan.expectedItemCount);
            for (const id of result.unreachableSources.map((r) => r.sourceId)) {
              expect(contributed.has(id)).toBe(false);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    30_000,
  );
});

describe("ResearchAggregator per-source timeout", () => {
  it("skips and records a related source that exceeds the 15s per-source timeout", async () => {
    // _Requirements: 3.5_
    expect(DEFAULT_RESEARCH_AGGREGATION_OPTIONS.perSourceTimeoutMs).toBe(15_000);
    vi.useFakeTimers();

    const origin = source(ORIGIN_ID, true);
    const slow = source("slow", true);
    const fast = source("fast", true);
    const topic = topicFor(origin);
    let slowSignal: AbortSignal | undefined;

    const fetcher: SourceFetcher = {
      async isAllowed() {
        return permitted;
      },
      async fetch(config, _cursor, signal): Promise<FetchPage> {
        if (config.id === slow.id) {
          slowSignal = signal;
          return await new Promise<FetchPage>(() => undefined);
        }
        const scenario: Scenario = {
          configuredMinItems: 3,
          originMode: "reachable",
          itemOffset: 0,
          related: [],
          text: "Nội dung nghiên cứu tiếng Việt",
          emptyBody: false,
          pagedOrigin: false,
          sourceType: "Website",
        };
        return {
          items: itemsFor(config.id, config.id === origin.id ? 3 : 1, scenario),
        };
      },
    };

    const pending = aggregator(fetcher).aggregate(topic, [origin, slow, fast]);
    // Default per-source timeout, advanced instantly instead of waiting 15s.
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;

    expect(slowSignal?.aborted).toBe(true);
    expect(result.status).toBe("Ok");
    expect(result.unreachableSources).toEqual([
      {
        sourceId: slow.id,
        captureId: "unreachable:slow",
        url: slow.url,
        capturedAt: NOW.toISOString(),
        termsVersion: TERMS_VERSION,
      },
    ]);
    // Aggregation continued: origin (3) plus the reachable related source (1).
    expect(result.items).toHaveLength(4);
    expect(
      result.items.map(({ evidenceRefs }) => evidenceRefs[0]?.sourceId),
    ).toEqual([origin.id, origin.id, origin.id, fast.id]);
    expect(result.reason).toBeUndefined();
    expect(result).not.toHaveProperty("stage");
  });
});
