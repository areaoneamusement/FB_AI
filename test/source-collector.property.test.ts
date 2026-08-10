import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceFetcher } from "../src/adapters/ports.js";
import type {
  FetchPage,
  RawItem,
  SourceConfig,
  SourceCursor,
  SourceFilterMode,
  SourcePermission,
  SourceType,
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

const NUM_RUNS = 100;
const HOUR_MS = 60 * 60 * 1_000;
const NOW = new Date("2025-03-15T08:30:00.000Z");
const NOW_MS = NOW.getTime();
const SOURCE_TYPES: readonly SourceType[] = ["GitHub", "Website", "Forum"];
const FILTER_MODES: readonly SourceFilterMode[] = ["Best", "High", "All"];
const FILTER_RANK: Readonly<Record<SourceFilterMode, number>> = {
  Best: 0,
  High: 1,
  All: 2,
};

/** Durable-identity store: `(sourceId, externalId)` primary, URL/hash fallbacks. */
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

interface SourceBehavior {
  readonly permission?: SourcePermission;
  readonly permissionThrows?: boolean;
  readonly fetchThrows?: boolean;
  readonly page?: FetchPage;
}

const ALLOWED: SourcePermission = {
  allowed: true,
  termsVersion: "terms-v1",
  robotsCapturedAt: "2025-03-01T00:00:00.000Z",
};

function sourceConfig(
  id: string,
  type: SourceType,
  filterMode: SourceFilterMode = "All",
  priority = 0,
  active = true,
): SourceConfig {
  return { id, type, url: `https://example.test/${id}`, active, priority, filterMode };
}

function behaviorFetcher(
  behaviors: ReadonlyMap<string, SourceBehavior>,
  onFetch?: (sourceId: string) => void,
): SourceFetcher {
  return {
    async isAllowed(source) {
      const behavior = behaviors.get(source.id);
      if (behavior?.permissionThrows === true) {
        throw new Error(`permission lookup failed for ${source.id}`);
      }
      return behavior?.permission ?? ALLOWED;
    },
    async fetch(source) {
      onFetch?.(source.id);
      const behavior = behaviors.get(source.id);
      if (behavior?.fetchThrows === true) {
        throw new Error(`upstream unavailable for ${source.id}`);
      }
      return behavior?.page ?? { items: [] };
    },
  };
}

function singleSourceFetcher(sourceId: string, items: readonly RawItem[]): SourceFetcher {
  return behaviorFetcher(new Map([[sourceId, { page: { items } }]]));
}

const textArb = fc.oneof(
  fc.constant(""),
  fc.constant("   "),
  fc.constant("Cập nhật công cụ AI mới nhất"),
  fc.constant("Trí tuệ nhân tạo — bản phát hành tháng Ba 🇻🇳"),
  fc.constant("日本語のリリースノート"),
  fc.string({ maxLength: 24 }),
);

interface ItemSeed {
  readonly timestampMs: number;
  readonly title: string;
  readonly body: string;
}

/** Includes window boundaries: exactly `now - windowHours`, exactly `now`, and ±1ms. */
function timestampMsArb(windowHours: number): fc.Arbitrary<number> {
  const earliestMs = NOW_MS - windowHours * HOUR_MS;
  return fc.oneof(
    fc.constant(earliestMs),
    fc.constant(earliestMs - 1),
    fc.constant(earliestMs + 1),
    fc.constant(NOW_MS),
    fc.constant(NOW_MS - 1),
    fc.constant(NOW_MS + 1),
    fc.constant(earliestMs - HOUR_MS),
    fc.constant(NOW_MS + 24 * HOUR_MS),
    fc.integer({ min: earliestMs - HOUR_MS, max: NOW_MS + HOUR_MS }),
  );
}

function itemSeedArb(windowHours: number): fc.Arbitrary<ItemSeed> {
  return fc.record({
    timestampMs: timestampMsArb(windowHours),
    title: textArb,
    body: textArb,
  });
}

function buildItem(sourceId: string, externalId: string, seed: ItemSeed): RawItem {
  return {
    sourceId,
    externalId,
    canonicalUrl: `https://example.test/${sourceId}/${encodeURIComponent(externalId)}`,
    normalizedContentHash: `hash-${sourceId}-${externalId}`,
    publishedOrUpdatedAt: new Date(seed.timestampMs).toISOString(),
    title: seed.title,
    body: seed.body,
  };
}

function inWindow(timestampMs: number, windowHours: number): boolean {
  return timestampMs >= NOW_MS - windowHours * HOUR_MS && timestampMs <= NOW_MS;
}

describe("SourceCollector properties", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps every collected item inside the configured collection window", async () => {
    // Feature: fb-ai, Property 1: Collected items fall within the configured time window
    // Validates: Requirements 1.2
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 720 }).chain((windowHours) =>
          fc.record({
            windowHours: fc.constant(windowHours),
            seeds: fc.array(itemSeedArb(windowHours), {
              minLength: 1,
              maxLength: 12,
            }),
          }),
        ),
        async ({ windowHours, seeds }) => {
          const sourceId = "window-source";
          const items = seeds.map((seed, index) =>
            buildItem(sourceId, `item-${index}`, seed),
          );
          const collector = new SourceCollector(
            new SourceRegistry([sourceConfig(sourceId, "Website")]),
            singleSourceFetcher(sourceId, items),
            new MemoryCollectionState(),
          );

          const result = await collector.runCycle(
            { windowHours, baseRetryDelayMs: 0 },
            NOW,
          );

          expect(result.errors).toEqual([]);
          const earliestMs = NOW_MS - windowHours * HOUR_MS;
          for (const collected of result.items) {
            const timestampMs = Date.parse(collected.publishedOrUpdatedAt);
            expect(timestampMs).toBeGreaterThanOrEqual(earliestMs);
            expect(timestampMs).toBeLessThanOrEqual(NOW_MS);
          }

          const expected = seeds
            .map((seed, index) => ({ seed, index }))
            .filter(({ seed }) => inWindow(seed.timestampMs, windowHours))
            .map(({ index }) => `item-${index}`);
          expect([...result.items.map((item) => item.externalId)].sort()).toEqual(
            [...expected].sort(),
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("deduplicates by source identity and stays idempotent on replay", async () => {
    // Feature: fb-ai, Property 2: Collection is deduplicated by source identifier, and replay creates no additional topic
    // Validates: Requirements 1.5
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            externalId: fc.constantFrom("a", "b", "c", "công-cụ", "リリース"),
            seed: fc.record({
              timestampMs: fc.integer({ min: NOW_MS - 12 * HOUR_MS, max: NOW_MS }),
              title: textArb,
              body: textArb,
            }),
          }),
          { minLength: 1, maxLength: 14 },
        ),
        fc.boolean(),
        async (entries, replayPageInSameCycle) => {
          const sourceId = "dedup-source";
          const base = entries.map(({ externalId, seed }) =>
            buildItem(sourceId, externalId, seed),
          );
          const items = replayPageInSameCycle ? [...base, ...base] : base;
          const state = new MemoryCollectionState();
          const collector = new SourceCollector(
            new SourceRegistry([sourceConfig(sourceId, "Forum")]),
            singleSourceFetcher(sourceId, items),
            state,
          );

          const first = await collector.runCycle(
            { windowHours: 24, baseRetryDelayMs: 0 },
            NOW,
          );

          const keys = first.items.map((item) => `${item.sourceId}\u0000${item.externalId}`);
          expect(new Set(keys).size).toBe(keys.length);

          const distinctIds = new Set(base.map((item) => item.externalId));
          expect(new Set(first.items.map((item) => item.externalId))).toEqual(
            distinctIds,
          );

          const replay = await collector.runCycle(
            { windowHours: 24, baseRetryDelayMs: 0 },
            NOW,
          );
          expect(replay.items).toEqual([]);
          expect(replay.errors).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("preserves GitHub stars, last-updated time, and changelog on collected records", async () => {
    // Feature: fb-ai, Property 3: GitHub metadata (stars, lastUpdatedAt, changelog/release) is preserved
    // Validates: Requirements 1.4
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            stars: fc.integer({ min: 0, max: 500_000 }),
            offsetMs: fc.integer({ min: 0, max: 24 * HOUR_MS }),
            changelog: fc.option(textArb, { nil: undefined }),
            omitGithub: fc.boolean(),
            seed: fc.record({
              timestampMs: fc.integer({ min: NOW_MS - 24 * HOUR_MS, max: NOW_MS }),
              title: textArb,
              body: textArb,
            }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (entries) => {
          const sourceId = "github-source";
          const items: RawItem[] = entries.map((entry, index) => {
            const item = buildItem(sourceId, `repo-${index}`, entry.seed);
            if (entry.omitGithub) return item;
            return {
              ...item,
              github: {
                stars: entry.stars,
                lastUpdatedAt: new Date(NOW_MS - entry.offsetMs).toISOString(),
                ...(entry.changelog === undefined
                  ? {}
                  : { changelog: entry.changelog }),
              },
            };
          });
          const collector = new SourceCollector(
            new SourceRegistry([sourceConfig(sourceId, "GitHub", "Best", 10)]),
            singleSourceFetcher(sourceId, items),
            new MemoryCollectionState(),
          );

          const result = await collector.runCycle(
            { windowHours: 24, baseRetryDelayMs: 0 },
            NOW,
          );

          expect(result.items).toHaveLength(items.length);
          const byExternalId = new Map(
            items.map((item) => [item.externalId, item] as const),
          );
          for (const collected of result.items) {
            const original = byExternalId.get(collected.externalId);
            expect(original).toBeDefined();
            expect(collected.github).toEqual(original?.github);
          }
          const withMetadata = result.items.filter(
            (item) => item.github !== undefined,
          ).length;
          expect(withMetadata).toBe(
            entries.filter((entry) => !entry.omitGithub).length,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("skips disallowed sources with a reason and the effective terms/robots version", async () => {
    // Feature: fb-ai, Property 4: Disallowed sources are skipped with a reason and effective terms/robots version
    // Validates: Requirements 1.6
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            allowed: fc.boolean(),
            reason: fc.oneof(
              fc.constant(undefined),
              fc.constant(""),
              fc.constant("   "),
              fc.constant("robots.txt chặn đường dẫn /tin-tức"),
              fc.constant("Source_Terms cấm thu thập tự động"),
            ),
            termsVersion: fc.constantFrom("terms-v1", "terms-v2", "điều-khoản-v3"),
            robotsCapturedAt: fc.constantFrom(
              "2025-03-01T00:00:00.000Z",
              "2025-03-14T23:59:59.999Z",
            ),
            type: fc.constantFrom(...SOURCE_TYPES),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (entries) => {
          const behaviors = new Map<string, SourceBehavior>();
          const configs: SourceConfig[] = [];
          entries.forEach((entry, index) => {
            const id = `source-${index}`;
            configs.push(sourceConfig(id, entry.type));
            behaviors.set(id, {
              permission: {
                allowed: entry.allowed,
                ...(entry.reason === undefined ? {} : { reason: entry.reason }),
                termsVersion: entry.termsVersion,
                robotsCapturedAt: entry.robotsCapturedAt,
              },
              page: {
                items: [
                  buildItem(id, "item-0", {
                    timestampMs: NOW_MS - HOUR_MS,
                    title: "Nội dung",
                    body: "Thân bài",
                  }),
                ],
              },
            });
          });

          const collector = new SourceCollector(
            new SourceRegistry(configs),
            behaviorFetcher(behaviors),
            new MemoryCollectionState(),
          );

          const result = await collector.runCycle(
            { windowHours: 24, baseRetryDelayMs: 0 },
            NOW,
          );

          expect(result.errors).toEqual([]);
          const skippedById = new Map(
            result.skipped.map((record) => [record.sourceId, record] as const),
          );
          const collectedSourceIds = new Set(
            result.items.map((item) => item.sourceId),
          );

          entries.forEach((entry, index) => {
            const id = `source-${index}`;
            if (entry.allowed) {
              expect(skippedById.has(id)).toBe(false);
              expect(collectedSourceIds.has(id)).toBe(true);
              return;
            }

            const record = skippedById.get(id);
            expect(record).toBeDefined();
            expect(collectedSourceIds.has(id)).toBe(false);
            expect(record?.reason.trim().length ?? 0).toBeGreaterThan(0);
            if ((entry.reason ?? "").trim().length > 0) {
              expect(record?.reason).toBe(entry.reason?.trim());
            }
            expect(record?.termsVersion).toBe(entry.termsVersion);
            expect(record?.robotsCapturedAt).toBe(entry.robotsCapturedAt);
            expect(Number.isFinite(Date.parse(record?.skippedAt ?? ""))).toBe(true);
          });
          expect(result.skipped).toHaveLength(
            entries.filter((entry) => !entry.allowed).length,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("never lets one failing source drop or block the successful ones", async () => {
    // Feature: fb-ai, Property 5: One failing source never drops or blocks successful sources
    // Validates: Requirements 1.7
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.constantFrom<"ok" | "fetchError" | "permissionError">(
            "ok",
            "fetchError",
            "permissionError",
          ),
          { minLength: 1, maxLength: 6 },
        ),
        fc.integer({ min: 1, max: 5 }),
        async (behaviorKinds, maxRetries) => {
          const kinds: readonly ("ok" | "fetchError" | "permissionError")[] =
            behaviorKinds.includes("ok") ? behaviorKinds : ["ok", ...behaviorKinds];
          const behaviors = new Map<string, SourceBehavior>();
          const configs: SourceConfig[] = [];
          kinds.forEach((kind, index) => {
            const id = `source-${index}`;
            configs.push(
              sourceConfig(id, SOURCE_TYPES[index % SOURCE_TYPES.length]!),
            );
            behaviors.set(id, {
              fetchThrows: kind === "fetchError",
              permissionThrows: kind === "permissionError",
              page: {
                items: [
                  buildItem(id, "item-0", {
                    timestampMs: NOW_MS - HOUR_MS,
                    title: "Bài viết hợp lệ",
                    body: "Nội dung",
                  }),
                ],
              },
            });
          });

          const collector = new SourceCollector(
            new SourceRegistry(configs),
            behaviorFetcher(behaviors),
            new MemoryCollectionState(),
          );

          const result = await collector.runCycle(
            { windowHours: 24, maxRetries, baseRetryDelayMs: 0 },
            NOW,
          );

          const okIds = kinds
            .map((kind, index) => ({ kind, id: `source-${index}` }))
            .filter(({ kind }) => kind === "ok")
            .map(({ id }) => id);
          expect([...result.items.map((item) => item.sourceId)].sort()).toEqual(
            [...okIds].sort(),
          );
          expect(result.skipped).toEqual([]);

          const errorsById = new Map(
            result.errors.map((record) => [record.sourceId, record] as const),
          );
          kinds.forEach((kind, index) => {
            const id = `source-${index}`;
            if (kind === "ok") {
              expect(errorsById.has(id)).toBe(false);
              return;
            }
            const record = errorsById.get(id);
            expect(record).toBeDefined();
            expect(record?.reason.trim().length ?? 0).toBeGreaterThan(0);
            expect(record?.attempts).toBe(kind === "fetchError" ? maxRetries : 1);
          });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("enforces per-type caps and processes highest-focus sources first", async () => {
    // Feature: fb-ai, Property 6: Registry respects per-type caps (<=500) and priority/filterMode focus ordering
    // Validates: Requirements 1.1
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            label: fc.constantFrom("alpha", "bêta", "công-cụ", "zulu", "リリース"),
            type: fc.constantFrom(...SOURCE_TYPES),
            filterMode: fc.constantFrom(...FILTER_MODES),
            priority: fc.integer({ min: -20, max: 20 }),
            active: fc.boolean(),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        fc.constantFrom(...SOURCE_TYPES),
        async (entries, cappedType) => {
          const configs = entries.map((entry, index) =>
            sourceConfig(
              `${entry.label}-${index}`,
              entry.type,
              entry.filterMode,
              entry.priority,
              entry.active,
            ),
          );
          const registry = new SourceRegistry(configs);

          const expectedOrder = [...configs]
            .sort(
              (left, right) =>
                FILTER_RANK[left.filterMode] - FILTER_RANK[right.filterMode] ||
                right.priority - left.priority ||
                left.id.localeCompare(right.id),
            )
            .map((config) => config.id);
          expect(registry.list().map((config) => config.id)).toEqual(expectedOrder);

          const expectedActive = expectedOrder.filter(
            (id) => configs.find((config) => config.id === id)?.active === true,
          );
          expect(
            registry.list({ activeOnly: true }).map((config) => config.id),
          ).toEqual(expectedActive);

          for (const type of SOURCE_TYPES) {
            expect(registry.count(type)).toBeLessThanOrEqual(MAX_SOURCES_PER_TYPE);
          }

          const fetchOrder: string[] = [];
          const collector = new SourceCollector(
            registry,
            behaviorFetcher(new Map(), (id) => fetchOrder.push(id)),
            new MemoryCollectionState(),
          );
          await collector.runCycle({ windowHours: 24, baseRetryDelayMs: 0 }, NOW);
          expect(fetchOrder).toEqual(expectedActive);

          const capped = new SourceRegistry();
          for (let index = 0; index < MAX_SOURCES_PER_TYPE; index += 1) {
            capped.add(sourceConfig(`${cappedType}-${index}`, cappedType));
          }
          expect(capped.count(cappedType)).toBe(MAX_SOURCES_PER_TYPE);
          expect(() =>
            capped.add(sourceConfig(`${cappedType}-overflow`, cappedType)),
          ).toThrow(/cannot exceed 500/);
          for (const otherType of SOURCE_TYPES.filter((t) => t !== cappedType)) {
            expect(() =>
              capped.add(sourceConfig(`${otherType}-extra`, otherType)),
            ).not.toThrow();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("aborts a fetch that exceeds the 30 second per-request timeout and records a source failure", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetcher: SourceFetcher = {
      async isAllowed() {
        return ALLOWED;
      },
      async fetch(_source, _cursor, signal) {
        return await new Promise<FetchPage>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted by collector"));
          });
        });
      },
    };
    const collector = new SourceCollector(
      new SourceRegistry([sourceConfig("slow-source", "Website")]),
      fetcher,
      new MemoryCollectionState(),
    );

    const cycle = collector.runCycle(
      { perRequestTimeoutMs: 30_000, maxRetries: 1, baseRetryDelayMs: 0 },
      NOW,
    );

    await vi.advanceTimersByTimeAsync(29_999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = await cycle;

    expect(aborted).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.sourceId).toBe("slow-source");
    expect(result.errors[0]?.attempts).toBe(1);
    expect(result.errors[0]?.reason).toContain("30000ms");
  });
});
