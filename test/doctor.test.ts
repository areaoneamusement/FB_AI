import { describe, expect, it } from "vitest";

import { HttpSourceFetcher } from "../src/adapters/http-source-fetcher.js";
import {
  diagnoseSource,
  formatDoctorReport,
  readGitHubQuota,
  type DoctorReport,
} from "../src/app/doctor.js";
import type { SourceConfig } from "../src/domain/source.js";

const source: SourceConfig = {
  id: "github-llm",
  type: "GitHub",
  url: "https://api.github.com/search/repositories?q=topic:llm",
  active: true,
  priority: 100,
  filterMode: "All",
};

function fetchStub(
  handler: (url: URL) => Response,
): { impl: typeof globalThis.fetch; seen: string[] } {
  const seen: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    seen.push(url.toString());
    return handler(url);
  }) as unknown as typeof globalThis.fetch;
  return { impl, seen };
}

describe("readGitHubQuota", () => {
  it("reports core and search separately, because they are separate budgets", async () => {
    // A cycle that fails on search learns nothing from a healthy core figure, and the
    // reverse is what makes `API rate limit exceeded` so hard to act on.
    const { impl } = fetchStub(
      () =>
        new Response(
          JSON.stringify({
            resources: {
              core: { limit: 5_000, remaining: 4_999, reset: 1_800_000_000 },
              search: { limit: 30, remaining: 0, reset: 1_800_000_060 },
              graphql: { limit: 5_000, remaining: 5_000, reset: 1_800_000_000 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const { quotas, error } = await readGitHubQuota("ghp_test", impl);

    expect(error).toBeUndefined();
    expect(quotas.map(({ resource }) => resource)).toEqual(["core", "search"]);
    expect(quotas[1]).toMatchObject({ resource: "search", remaining: 0, limit: 30 });
    expect(quotas[1]?.resetAt).toBe(new Date(1_800_000_060_000).toISOString());
  });

  it("sends the token when there is one, and omits it when there is not", async () => {
    let authorization: string | null = null;
    const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ resources: {} }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await readGitHubQuota("ghp_test", impl);
    expect(authorization).toBe("Bearer ghp_test");

    await readGitHubQuota(undefined, impl);
    expect(authorization).toBeNull();
  });

  it("says why rather than throwing when the endpoint refuses", async () => {
    const { impl } = fetchStub(() => new Response("nope", { status: 401, statusText: "Unauthorized" }));
    const { quotas, error } = await readGitHubQuota("bad", impl);
    expect(quotas).toEqual([]);
    expect(error).toContain("401");
  });

  it("survives a network failure", async () => {
    const impl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof globalThis.fetch;
    const { error } = await readGitHubQuota(undefined, impl);
    expect(error).toContain("ENOTFOUND");
  });
});

describe("diagnoseSource", () => {
  it("counts what one request returns", async () => {
    const { impl } = fetchStub((url) => {
      if (url.pathname === "/robots.txt") return new Response("", { status: 200 });
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 1,
              full_name: "acme/agent",
              html_url: "https://github.com/acme/agent",
              description: "An agent",
              stargazers_count: 10,
              pushed_at: "2026-08-16T00:00:00Z",
              updated_at: "2026-08-16T00:00:00Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await diagnoseSource(new HttpSourceFetcher({ fetch: impl }), source);
    expect(result).toMatchObject({ sourceId: "github-llm", ok: true, items: 1 });
  });

  it("reports a refusal as a diagnosis, not an exception", async () => {
    const { impl } = fetchStub((url) => {
      if (url.pathname === "/robots.txt") return new Response("", { status: 200 });
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        statusText: "Forbidden",
      });
    });

    const result = await diagnoseSource(new HttpSourceFetcher({ fetch: impl }), source);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("API rate limit exceeded");
  });

  it("names robots.txt when that is the reason", async () => {
    const { impl } = fetchStub(() => new Response("User-agent: *\nDisallow: /\n", { status: 200 }));
    const result = await diagnoseSource(new HttpSourceFetcher({ fetch: impl }), source);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("robots.txt");
  });

  it("makes exactly one search request, so diagnosing costs almost nothing", async () => {
    const { impl, seen } = fetchStub((url) => {
      if (url.pathname === "/robots.txt") return new Response("", { status: 200 });
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await diagnoseSource(new HttpSourceFetcher({ fetch: impl }), source);
    expect(seen.filter((url) => url.includes("/search/"))).toHaveLength(1);
  });
});

describe("formatDoctorReport", () => {
  const base: DoctorReport = {
    tokenPresent: true,
    quotas: [
      { resource: "core", limit: 5_000, remaining: 4_999, resetAt: "2026-08-19T07:00:00.000Z" },
      { resource: "search", limit: 30, remaining: 0, resetAt: "2026-08-19T06:03:00.000Z" },
    ],
    sources: [
      { sourceId: "github-llm", ok: false, detail: "403 Forbidden" },
      { sourceId: "google-ai-blog", ok: true, detail: "8 mục", items: 8 },
    ],
  };

  it("flags an exhausted budget and names its reset", () => {
    const text = formatDoctorReport(base);
    expect(text).toContain("HẾT search");
    expect(text).toContain("2026-08-19T06:03:00.000Z");
    expect(text).not.toContain("HẾT core");
  });

  it("warns when too few sources work for research to succeed", () => {
    expect(formatDoctorReport(base)).toContain("ít nhất 2 nguồn");
  });

  it("stays quiet about the minimum once enough sources work", () => {
    const text = formatDoctorReport({
      ...base,
      sources: [
        { sourceId: "a", ok: true, detail: "3 mục", items: 3 },
        { sourceId: "b", ok: true, detail: "4 mục", items: 4 },
      ],
    });
    expect(text).toContain("2/2 nguồn đọc được");
    expect(text).not.toContain("ít nhất 2 nguồn");
  });

  it("says plainly when there is no token", () => {
    expect(formatDoctorReport({ ...base, tokenPresent: false })).toContain("KHÔNG có");
  });
});
