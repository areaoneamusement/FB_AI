import { afterEach, describe, expect, it, vi } from "vitest";

import type { SourceFetcher } from "../src/adapters/ports.js";
import type { Topic } from "../src/domain/content.js";
import type {
  FetchPage,
  SourceConfig,
  SourcePermission,
} from "../src/domain/source.js";
import { ResearchAggregator } from "../src/pipeline/research-aggregator.js";

const NOW = new Date("2025-04-01T12:00:00.000Z");
const allowed: SourcePermission = {
  allowed: true,
  termsVersion: "terms-v2",
  robotsCapturedAt: NOW.toISOString(),
};

function source(id: string, active = true): SourceConfig {
  return {
    id,
    type: "Website",
    url: `https://example.test/${id}`,
    active,
    priority: 1,
    filterMode: "Best",
  };
}

const origin = source("origin");
const topic: Topic = {
  id: "topic-1",
  sourceRef: {
    sourceId: origin.id,
    captureId: "selected-origin-capture",
    url: origin.url,
    capturedAt: "2025-03-31T12:00:00.000Z",
    termsVersion: "terms-v1",
  },
  externalId: "topic-external-1",
  title: "AI release",
  createdAt: "2025-03-31T12:00:00.000Z",
  score: { total: 90, breakdown: [], scoringConfigVersion: "score-v1" },
  categories: ["AI Tools"],
};

afterEach(() => vi.useRealTimers());

function rawItem(sourceId: string, externalId: string) {
  return {
    sourceId,
    externalId,
    canonicalUrl: `https://example.test/${sourceId}/${externalId}`,
    normalizedContentHash: `hash-${sourceId}-${externalId}`,
    publishedOrUpdatedAt: NOW.toISOString(),
    title: `Title ${externalId}`,
    body: `Source-backed content ${externalId}`,
  };
}

function aggregator(fetcher: SourceFetcher): ResearchAggregator {
  let sequence = 0;
  return new ResearchAggregator(fetcher, {
    now: () => NOW,
    createId: (kind) => `${kind}-${++sequence}`,
  });
}

describe("ResearchAggregator", () => {
  it("aggregates paged origin and permitted related captures with provenance", async () => {
    const related = source("related");
    const blocked = source("blocked");
    const fetcher: SourceFetcher = {
      async isAllowed(config) {
        return config.id === blocked.id
          ? { ...allowed, allowed: false, reason: "robots.txt" }
          : allowed;
      },
      async fetch(config, cursor): Promise<FetchPage> {
        if (config.id === origin.id && cursor === undefined) {
          return {
            items: [rawItem(config.id, "one")],
            nextCursor: {
              sourceId: config.id,
              cursor: "page-2",
              updatedAt: NOW.toISOString(),
            },
          };
        }
        if (config.id === origin.id) {
          return { items: [rawItem(config.id, "two")] };
        }
        return { items: [rawItem(config.id, "three")] };
      },
    };

    const result = await aggregator(fetcher).aggregate(topic, [
      origin,
      related,
      blocked,
    ]);

    expect(result.status).toBe("Ok");
    expect(result.items).toHaveLength(3);
    expect(result.items.map(({ kind }) => kind)).toEqual([
      "Quoted",
      "Quoted",
      "Quoted",
    ]);
    expect(result.items.every((item) => item.modelProvenance === undefined))
      .toBe(true);
    expect(result.items.map(({ evidenceRefs }) => evidenceRefs[0])).toEqual([
      {
        sourceId: origin.id,
        captureId: "hash-origin-one",
        url: "https://example.test/origin/one",
        capturedAt: NOW.toISOString(),
        termsVersion: "terms-v2",
      },
      {
        sourceId: origin.id,
        captureId: "hash-origin-two",
        url: "https://example.test/origin/two",
        capturedAt: NOW.toISOString(),
        termsVersion: "terms-v2",
      },
      {
        sourceId: related.id,
        captureId: "hash-related-three",
        url: "https://example.test/related/three",
        capturedAt: NOW.toISOString(),
        termsVersion: "terms-v2",
      },
    ]);
    expect(result.unreachableSources).toEqual([]);
    expect(result).not.toHaveProperty("stage");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("uses the default minimum of three and returns explained insufficient data", async () => {
    const fetcher: SourceFetcher = {
      async isAllowed() {
        return allowed;
      },
      async fetch(config) {
        return {
          items: [rawItem(config.id, "one"), rawItem(config.id, "two")],
        };
      },
    };

    const result = await aggregator(fetcher).aggregate(topic, [origin]);

    expect(result.status).toBe("InsufficientData");
    expect(result.reason).toBe("Collected 2 research item(s); minimum is 3");
    expect(result.items).toHaveLength(2);
  });

  it("skips failed and timed-out related sources while preserving sufficient origin research", async () => {
    vi.useFakeTimers();
    const failing = source("failing");
    const slow = source("slow");
    let slowSignal: AbortSignal | undefined;
    const fetcher: SourceFetcher = {
      async isAllowed() {
        return allowed;
      },
      async fetch(config, _cursor, signal) {
        if (config.id === failing.id) throw new Error("upstream unavailable");
        if (config.id === slow.id) {
          slowSignal = signal;
          return await new Promise<FetchPage>(() => undefined);
        }
        return {
          items: [
            rawItem(config.id, "one"),
            rawItem(config.id, "two"),
            rawItem(config.id, "three"),
          ],
        };
      },
    };

    const pending = aggregator(fetcher).aggregate(
      topic,
      [origin, failing, slow],
      { perSourceTimeoutMs: 15 },
    );
    await vi.advanceTimersByTimeAsync(15);
    const result = await pending;

    expect(result.status).toBe("Ok");
    expect(result.items).toHaveLength(3);
    expect(slowSignal?.aborted).toBe(true);
    expect(result.unreachableSources.map(({ sourceId }) => sourceId)).toEqual([
      "failing",
      "slow",
    ]);
    expect(result.unreachableSources[0]?.termsVersion).toBe("terms-v2");
    expect(result.unreachableSources[1]?.captureId).toBe("unreachable:slow");
  });

  it("marks the result insufficient and does not fetch related sources when origin is unreachable", async () => {
    const related = source("related");
    const fetched: string[] = [];
    const fetcher: SourceFetcher = {
      async isAllowed() {
        return allowed;
      },
      async fetch(config) {
        fetched.push(config.id);
        if (config.id === origin.id) throw new Error("origin offline");
        return { items: [rawItem(config.id, "related")] };
      },
    };

    const result = await aggregator(fetcher).aggregate(topic, [origin, related]);

    expect(result.status).toBe("InsufficientData");
    expect(result.reason).toContain("Origin source origin is unavailable");
    expect(result.unreachableSources).toEqual([
      { ...topic.sourceRef, termsVersion: allowed.termsVersion },
    ]);
    expect(result.items).toEqual([]);
    expect(fetched).toEqual([origin.id]);
  });

  it("enforces the overall deadline independently of the source timeout", async () => {
    vi.useFakeTimers();
    const fetcher: SourceFetcher = {
      async isAllowed() {
        return allowed;
      },
      async fetch() {
        return await new Promise<FetchPage>(() => undefined);
      },
    };

    const pending = aggregator(fetcher).aggregate(topic, [origin], {
      perSourceTimeoutMs: 15,
      overallDeadlineMs: 5,
    });
    await vi.advanceTimersByTimeAsync(5);
    const result = await pending;

    expect(result.status).toBe("InsufficientData");
    expect(result.reason).toContain("Overall research deadline exceeded");
    expect(result.unreachableSources).toEqual([
      { ...topic.sourceRef, termsVersion: allowed.termsVersion },
    ]);
  });

  it("rejects timeout values above the requirement maxima", async () => {
    const fetcher: SourceFetcher = {
      async isAllowed() {
        return allowed;
      },
      async fetch() {
        return { items: [] };
      },
    };
    const researchAggregator = aggregator(fetcher);

    await expect(
      researchAggregator.aggregate(topic, [origin], {
        perSourceTimeoutMs: 15_001,
      }),
    ).rejects.toThrow(/perSourceTimeoutMs/);
    await expect(
      researchAggregator.aggregate(topic, [origin], {
        overallDeadlineMs: 60_001,
      }),
    ).rejects.toThrow(/overallDeadlineMs/);
  });
});
