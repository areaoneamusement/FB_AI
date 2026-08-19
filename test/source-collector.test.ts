import { describe, expect, it } from "vitest";
import type { SourceFetcher } from "../src/adapters/ports.js";
import type {
  FetchPage,
  SourceConfig,
  SourceCursor,
  SourcePermission,
} from "../src/domain/source.js";
import {
  SourceCollector,
  type CollectedSourceItem,
  type CollectionStateStore,
} from "../src/pipeline/source-collector.js";
import {
  MAX_SOURCES_PER_TYPE,
  SourceRegistry,
} from "../src/pipeline/source-registry.js";

class MemoryCollectionState implements CollectionStateStore {
  readonly cursors = new Map<string, SourceCursor>();
  readonly primary = new Set<string>();
  readonly urls = new Set<string>();
  readonly hashes = new Set<string>();

  async getCursor(sourceId: string): Promise<SourceCursor | undefined> {
    return this.cursors.get(sourceId);
  }

  async saveCursor(cursor: SourceCursor): Promise<void> {
    this.cursors.set(cursor.sourceId, cursor);
  }

  async acceptIfNew(item: CollectedSourceItem): Promise<boolean> {
    const primary = `${item.sourceId}\u0000${item.externalId}`;
    if (
      this.primary.has(primary) ||
      (item.canonicalUrl !== undefined && this.urls.has(item.canonicalUrl)) ||
      (item.normalizedContentHash.length > 0 &&
        this.hashes.has(item.normalizedContentHash))
    ) {
      return false;
    }

    this.primary.add(primary);
    if (item.canonicalUrl !== undefined) this.urls.add(item.canonicalUrl);
    if (item.normalizedContentHash.length > 0) {
      this.hashes.add(item.normalizedContentHash);
    }
    return true;
  }
}

const allowed: SourcePermission = {
  allowed: true,
  termsVersion: "terms-v1",
  robotsCapturedAt: "2025-01-01T00:00:00.000Z",
};

function source(
  id: string,
  type: SourceConfig["type"],
  filterMode: SourceConfig["filterMode"] = "All",
  priority = 0,
): SourceConfig {
  return {
    id,
    type,
    url: `https://example.test/${id}`,
    active: true,
    priority,
    filterMode,
  };
}

describe("SourceRegistry", () => {
  it("supports all required source types and orders best sources by priority", () => {
    const registry = new SourceRegistry([
      source("all", "Forum", "All", 100),
      source("best-low", "GitHub", "Best", 1),
      source("high", "Website", "High", 100),
      source("best-high", "GitHub", "Best", 10),
    ]);

    expect(SourceRegistry.supportedTypes).toEqual([
      "GitHub",
      "Website",
      "Forum",
    ]);
    expect(registry.list().map(({ id }) => id)).toEqual([
      "best-high",
      "best-low",
      "high",
      "all",
    ]);
  });

  it("enforces the 500-source cap independently for each type", () => {
    const registry = new SourceRegistry();
    for (let index = 0; index < MAX_SOURCES_PER_TYPE; index += 1) {
      registry.add(source(`github-${index}`, "GitHub"));
    }

    expect(() => registry.add(source("github-overflow", "GitHub"))).toThrow(
      /cannot exceed 500/,
    );
    expect(() => registry.add(source("website-1", "Website"))).not.toThrow();
  });
});

describe("SourceCollector", () => {
  it("collects inclusive-window items, checkpoints pages, deduplicates fallback signals, and preserves GitHub metadata", async () => {
    const now = new Date("2025-02-01T12:00:00.000Z");
    const lowerBoundary = "2025-02-01T11:00:00.000Z";
    const nextCursor: SourceCursor = {
      sourceId: "github",
      cursor: "page-2",
      updatedAt: now.toISOString(),
    };
    const pages: FetchPage[] = [
      {
        items: [
          {
            sourceId: "github",
            externalId: "release-1",
            canonicalUrl: "https://github.test/repo/releases/1",
            normalizedContentHash: "hash-1",
            publishedOrUpdatedAt: lowerBoundary,
            title: "Release 1",
            body: "Details",
            github: {
              stars: 42,
              lastUpdatedAt: now.toISOString(),
              changelog: "Added durable collection",
            },
          },
        ],
        nextCursor,
      },
      {
        items: [
          {
            sourceId: "github",
            externalId: "renamed-release",
            canonicalUrl: "https://github.test/repo/releases/1",
            normalizedContentHash: "different-hash",
            publishedOrUpdatedAt: now.toISOString(),
            title: "Duplicate URL",
            body: "Duplicate",
          },
          {
            sourceId: "github",
            externalId: "future",
            normalizedContentHash: "future-hash",
            publishedOrUpdatedAt: "2025-02-01T12:00:00.001Z",
            title: "Future",
            body: "Future",
          },
        ],
      },
    ];
    const seenCursors: Array<SourceCursor | undefined> = [];
    const fetcher: SourceFetcher = {
      async isAllowed() {
        return allowed;
      },
      async fetch(_source, cursor) {
        seenCursors.push(cursor);
        const page = pages.shift();
        if (page === undefined) throw new Error("unexpected page");
        return page;
      },
    };
    const state = new MemoryCollectionState();
    const collector = new SourceCollector(
      new SourceRegistry([source("github", "GitHub", "Best", 10)]),
      fetcher,
      state,
    );

    const result = await collector.runCycle(
      { windowHours: 1, baseRetryDelayMs: 0 },
      now,
    );

    expect(result.errors).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.github).toEqual({
      stars: 42,
      lastUpdatedAt: now.toISOString(),
      changelog: "Added durable collection",
    });
    expect(result.items[0]?.permission).toEqual(allowed);
    expect(seenCursors).toEqual([undefined, nextCursor]);
    expect(state.cursors.get("github")).toEqual(nextCursor);
  });

  it("does not retry a rate-limit refusal", async () => {
    // Each retry spends the very budget the source is waiting to give back, and cannot
    // succeed before the window resets. A live run halved its own GitHub search allowance
    // by fetching every page twice: once to fail, once to fail again milliseconds later.
    const now = new Date("2025-02-01T12:00:00.000Z");
    let attempts = 0;
    const fetcher: SourceFetcher = {
      async isAllowed() {
        return allowed;
      },
      async fetch() {
        attempts += 1;
        throw Object.assign(new Error("API rate limit exceeded"), { status: 403 });
      },
    };
    const collector = new SourceCollector(
      new SourceRegistry([source("limited", "GitHub", "Best", 10)]),
      fetcher,
      new MemoryCollectionState(),
    );

    const result = await collector.runCycle({ maxRetries: 3, baseRetryDelayMs: 0 }, now);

    expect(attempts).toBe(1);
    expect(result.errors).toEqual([
      expect.objectContaining({
        sourceId: "limited",
        attempts: 1,
        reason: expect.stringContaining("rate limit"),
      }),
    ]);
  });

  it("still retries a failure that is not a rate limit", async () => {
    const now = new Date("2025-02-01T12:00:00.000Z");
    let attempts = 0;
    const fetcher: SourceFetcher = {
      async isAllowed() {
        return allowed;
      },
      async fetch() {
        attempts += 1;
        throw Object.assign(new Error("gateway timeout"), { status: 504 });
      },
    };
    const collector = new SourceCollector(
      new SourceRegistry([source("flaky", "GitHub", "Best", 10)]),
      fetcher,
      new MemoryCollectionState(),
    );

    await collector.runCycle({ maxRetries: 3, baseRetryDelayMs: 0 }, now);
    expect(attempts).toBe(3);
  });

  it("records terms skips and source failures without dropping successful items", async () => {
    const now = new Date("2025-02-01T12:00:00.000Z");
    const attempts = new Map<string, number>();
    const fetcher: SourceFetcher = {
      async isAllowed(config) {
        if (config.id === "blocked") {
          return { ...allowed, allowed: false, reason: "robots.txt blocks /news" };
        }
        return allowed;
      },
      async fetch(config) {
        attempts.set(config.id, (attempts.get(config.id) ?? 0) + 1);
        if (config.id === "failing") throw new Error("upstream unavailable");
        return {
          items: [
            {
              sourceId: config.id,
              externalId: "item-1",
              normalizedContentHash: `${config.id}-hash`,
              publishedOrUpdatedAt: now.toISOString(),
              title: "Successful item",
              body: "Body",
            },
          ],
        };
      },
    };
    const collector = new SourceCollector(
      new SourceRegistry([
        source("successful", "GitHub", "Best", 10),
        source("blocked", "Website", "High", 5),
        source("failing", "Forum", "All", 1),
      ]),
      fetcher,
      new MemoryCollectionState(),
    );

    const result = await collector.runCycle(
      { maxRetries: 2, baseRetryDelayMs: 0 },
      now,
    );

    expect(result.items.map(({ sourceId }) => sourceId)).toEqual(["successful"]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        sourceId: "blocked",
        reason: "robots.txt blocks /news",
        termsVersion: "terms-v1",
      }),
    ]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        sourceId: "failing",
        attempts: 2,
        reason: expect.stringContaining("upstream unavailable"),
      }),
    ]);
    expect(attempts.get("failing")).toBe(2);
  });

  it("aborts each timed-out request and retries only up to the configured limit", async () => {
    let attempts = 0;
    let aborts = 0;
    const fetcher: SourceFetcher = {
      async isAllowed() {
        return allowed;
      },
      async fetch(_source, _cursor, signal) {
        attempts += 1;
        return await new Promise<FetchPage>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborts += 1;
            reject(new Error("aborted"));
          });
        });
      },
    };
    const collector = new SourceCollector(
      new SourceRegistry([source("slow", "Website")]),
      fetcher,
      new MemoryCollectionState(),
    );

    const result = await collector.runCycle({
      perRequestTimeoutMs: 5,
      maxRetries: 2,
      baseRetryDelayMs: 0,
    });

    expect(attempts).toBe(2);
    expect(aborts).toBe(2);
    expect(result.errors).toEqual([
      expect.objectContaining({ sourceId: "slow", attempts: 2 }),
    ]);
  });
});
