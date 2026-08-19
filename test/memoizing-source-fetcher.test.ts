import { describe, expect, it } from "vitest";

import { MemoizingSourceFetcher } from "../src/adapters/memoizing-source-fetcher.js";
import type { SourceFetcher } from "../src/adapters/ports.js";
import type { FetchPage, SourceConfig, SourcePermission } from "../src/domain/source.js";

const source: SourceConfig = {
  id: "github-llm",
  type: "GitHub",
  url: "https://api.github.com/search/repositories?q=topic:llm",
  active: true,
  priority: 100,
  filterMode: "High",
};

const other: SourceConfig = { ...source, id: "blog", url: "https://example.test/feed.xml" };

const permission: SourcePermission = {
  allowed: true,
  termsVersion: "terms-v1",
  robotsCapturedAt: "2026-08-17T00:00:00.000Z",
};

function page(items: number): FetchPage {
  return { items: Array.from({ length: items }, () => ({}) as FetchPage["items"][number]) };
}

interface Spy extends SourceFetcher {
  readonly fetchCalls: string[];
  readonly permissionCalls: string[];
}

function spy(behaviour: { failFirst?: boolean } = {}): Spy {
  const fetchCalls: string[] = [];
  const permissionCalls: string[] = [];
  let failures = behaviour.failFirst === true ? 1 : 0;

  return {
    fetchCalls,
    permissionCalls,
    fetch: async (config) => {
      fetchCalls.push(config.id);
      if (failures > 0) {
        failures -= 1;
        throw new Error("upstream timed out");
      }
      return page(2);
    },
    isAllowed: async (config) => {
      permissionCalls.push(config.id);
      return permission;
    },
  };
}

const signal = new AbortController().signal;

describe("MemoizingSourceFetcher", () => {
  it("fetches a source once however many topics ask for it", async () => {
    // ResearchAggregator runs per topic and always starts from cursor undefined, so
    // without this every topic in a cycle re-downloads identical pages.
    const inner = spy();
    const fetcher = new MemoizingSourceFetcher(inner);

    const pages = await Promise.all([
      fetcher.fetch(source, undefined, signal),
      fetcher.fetch(source, undefined, signal),
      fetcher.fetch(source, undefined, signal),
    ]);

    expect(inner.fetchCalls).toEqual(["github-llm"]);
    expect(pages[0]).toBe(pages[1]);
    expect(pages[1]).toBe(pages[2]);
  });

  it("keeps sources and cursors apart", async () => {
    const inner = spy();
    const fetcher = new MemoizingSourceFetcher(inner);

    await fetcher.fetch(source, undefined, signal);
    await fetcher.fetch(other, undefined, signal);
    await fetcher.fetch(source, { sourceId: source.id, cursor: "2", updatedAt: "2026-08-17T00:00:00.000Z" }, signal);

    expect(inner.fetchCalls).toEqual(["github-llm", "blog", "github-llm"]);
  });

  it("memoises permission checks per source", async () => {
    const inner = spy();
    const fetcher = new MemoizingSourceFetcher(inner);

    await fetcher.isAllowed(source);
    await fetcher.isAllowed(source);
    await fetcher.isAllowed(other);

    expect(inner.permissionCalls).toEqual(["github-llm", "blog"]);
  });

  it("does not cache a failure, so the next topic retries", async () => {
    // A timeout belongs to the deadline of the topic that hit it. Caching the rejection
    // would fail every remaining topic in the cycle for someone else's reason.
    const inner = spy({ failFirst: true });
    const fetcher = new MemoizingSourceFetcher(inner);

    await expect(fetcher.fetch(source, undefined, signal)).rejects.toThrow("upstream timed out");
    await expect(fetcher.fetch(source, undefined, signal)).resolves.toMatchObject({
      items: expect.any(Array),
    });
    expect(inner.fetchCalls).toEqual(["github-llm", "github-llm"]);
  });

  it("serves fresh pages after reset so cycles never share captures", async () => {
    const inner = spy();
    const fetcher = new MemoizingSourceFetcher(inner);

    await fetcher.fetch(source, undefined, signal);
    await fetcher.isAllowed(source);
    fetcher.reset();
    await fetcher.fetch(source, undefined, signal);
    await fetcher.isAllowed(source);

    expect(inner.fetchCalls).toEqual(["github-llm", "github-llm"]);
    expect(inner.permissionCalls).toEqual(["github-llm", "github-llm"]);
  });
});
