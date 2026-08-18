import { describe, expect, it } from "vitest";

import {
  HttpSourceFetcher,
  SourceFetchError,
  describeFailure,
  isPathAllowed,
  parseFeed,
  parseRobots,
} from "../src/adapters/http-source-fetcher.js";
import type { SourceConfig } from "../src/domain/source.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");

const githubSource: SourceConfig = {
  id: "github-llm",
  type: "GitHub",
  url: "https://api.github.com/search/repositories?q=topic:llm&sort=updated",
  active: true,
  priority: 100,
  filterMode: "High",
};

const feedSource: SourceConfig = {
  id: "blog",
  type: "Website",
  url: "https://example.test/feed.xml",
  active: true,
  priority: 50,
  filterMode: "All",
};

function repository(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    full_name: "acme/agent",
    html_url: "https://github.com/acme/agent",
    description: "An agent framework",
    stargazers_count: 1_200,
    pushed_at: "2026-08-16T00:00:00Z",
    updated_at: "2026-08-16T00:00:00Z",
    topics: ["llm", "agents"],
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Answers robots.txt permissively and delegates everything else to `handler`. */
function fetcherWith(
  handler: (url: URL, init: RequestInit | undefined) => Response,
  options: { robots?: string } = {},
): { fetcher: HttpSourceFetcher; calls: URL[] } {
  const calls: URL[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === "/robots.txt") {
      return new Response(options.robots ?? "User-agent: *\nDisallow: /private\n", { status: 200 });
    }
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;

  return {
    fetcher: new HttpSourceFetcher({ fetch: fetchImpl, now: () => NOW, pageSize: 2 }),
    calls,
  };
}

describe("parseRobots", () => {
  it("collects Disallow rules from the wildcard group only", () => {
    const rules = parseRobots(
      [
        "User-agent: BadBot",
        "Disallow: /",
        "",
        "User-agent: *",
        "Disallow: /private",
        "Disallow: /admin   # comment",
        "Allow: /public",
      ].join("\n"),
    );
    expect(rules).toEqual(["/private", "/admin"]);
  });

  it("treats consecutive user-agent lines as one group", () => {
    const rules = parseRobots(["User-agent: Foo", "User-agent: *", "Disallow: /x"].join("\n"));
    expect(rules).toEqual(["/x"]);
  });

  it("returns no rules for an empty file", () => {
    expect(parseRobots("")).toEqual([]);
  });
});

describe("isPathAllowed", () => {
  it("blocks paths under a disallowed prefix and allows the rest", () => {
    expect(isPathAllowed(["/private"], "/private/data")).toBe(false);
    expect(isPathAllowed(["/private"], "/public/data")).toBe(true);
  });
});

describe("HttpSourceFetcher.isAllowed", () => {
  it("allows a path robots.txt does not disallow, and records the capture time", async () => {
    const { fetcher } = fetcherWith(() => jsonResponse({}));
    const permission = await fetcher.isAllowed(feedSource);
    expect(permission.allowed).toBe(true);
    expect(permission.robotsCapturedAt).toBe(NOW.toISOString());
    expect(permission.termsVersion).not.toHaveLength(0);
  });

  it("denies a path robots.txt disallows, and says why", async () => {
    const { fetcher } = fetcherWith(() => jsonResponse({}), {
      robots: "User-agent: *\nDisallow: /feed.xml\n",
    });
    const permission = await fetcher.isAllowed(feedSource);
    expect(permission.allowed).toBe(false);
    expect(permission.reason).toContain("robots.txt");
  });

  it("rejects non-https sources without making a request", async () => {
    const { fetcher, calls } = fetcherWith(() => jsonResponse({}));
    const permission = await fetcher.isAllowed({ ...feedSource, url: "http://example.test/feed" });
    expect(permission.allowed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("caches robots.txt per origin", async () => {
    const { fetcher, calls } = fetcherWith(() => jsonResponse({}));
    await fetcher.isAllowed(feedSource);
    await fetcher.isAllowed({ ...feedSource, id: "other", url: "https://example.test/other.xml" });
    expect(calls.filter((url) => url.pathname === "/robots.txt")).toHaveLength(1);
  });
});

describe("HttpSourceFetcher GitHub", () => {
  it("maps repositories to raw items and carries stars through", async () => {
    const { fetcher } = fetcherWith(() => jsonResponse({ items: [repository()] }));
    const page = await fetcher.fetch(githubSource, undefined, new AbortController().signal);

    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item.sourceId).toBe("github-llm");
    expect(item.externalId).toBe("1");
    expect(item.title).toBe("acme/agent");
    expect(item.canonicalUrl).toBe("https://github.com/acme/agent");
    expect(item.github?.stars).toBe(1_200);
    expect(item.publishedOrUpdatedAt).toBe("2026-08-16T00:00:00.000Z");
    expect(item.normalizedContentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("drops repositories below the filter mode's star floor", async () => {
    const { fetcher } = fetcherWith(() =>
      jsonResponse({
        items: [repository({ id: 1, stargazers_count: 1_200 }), repository({ id: 2, stargazers_count: 5 })],
      }),
    );
    const page = await fetcher.fetch(githubSource, undefined, new AbortController().signal);
    expect(page.items.map((item) => item.externalId)).toEqual(["1"]);
  });

  it("advances the page cursor while a full page comes back", async () => {
    const { fetcher, calls } = fetcherWith(() =>
      jsonResponse({ items: [repository({ id: 1 }), repository({ id: 2 })] }),
    );
    const page = await fetcher.fetch(githubSource, undefined, new AbortController().signal);
    expect(page.nextCursor?.cursor).toBe("2");
    expect(page.nextCursor?.sourceId).toBe("github-llm");
    expect(calls.at(-1)?.searchParams.get("page")).toBe("1");
  });

  it("stops paging once the per-cycle page cap is reached", async () => {
    // The collector follows nextCursor until a page says stop. GitHub search allows 1,000
    // results, so without this cap the first run walks the whole set and gets rate-limited.
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/robots.txt") return new Response("", { status: 200 });
      return jsonResponse({ items: [repository({ id: 1 }), repository({ id: 2 })] });
    }) as unknown as typeof globalThis.fetch;

    const fetcher = new HttpSourceFetcher({
      fetch: fetchImpl,
      now: () => NOW,
      pageSize: 2,
      maxPagesPerCycle: 2,
    });

    const first = await fetcher.fetch(githubSource, undefined, new AbortController().signal);
    expect(first.nextCursor?.cursor).toBe("2");

    const second = await fetcher.fetch(githubSource, first.nextCursor, new AbortController().signal);
    // Cap reached: reset to page 1 and remember how far we got instead of walking on.
    expect(second.nextCursor?.cursor).toBe("1");
    expect(second.nextCursor?.lastModified).toBe("2026-08-16T00:00:00Z");
  });

  it("resets to page 1 and records a high-water mark once the page is short", async () => {
    const { fetcher } = fetcherWith(() => jsonResponse({ items: [repository()] }));
    const page = await fetcher.fetch(githubSource, undefined, new AbortController().signal);
    expect(page.nextCursor?.cursor).toBe("1");
    expect(page.nextCursor?.lastModified).toBe("2026-08-16T00:00:00Z");
  });

  it("stops at items already collected on a previous run", async () => {
    const { fetcher } = fetcherWith(() =>
      jsonResponse({
        items: [
          repository({ id: 1, pushed_at: "2026-08-16T00:00:00Z" }),
          repository({ id: 2, pushed_at: "2026-08-10T00:00:00Z" }),
        ],
      }),
    );
    const page = await fetcher.fetch(
      githubSource,
      {
        sourceId: "github-llm",
        cursor: "1",
        lastModified: "2026-08-12T00:00:00Z",
        updatedAt: NOW.toISOString(),
      },
      new AbortController().signal,
    );
    expect(page.items.map((item) => item.externalId)).toEqual(["1"]);
    expect(page.nextCursor?.lastModified).toBe("2026-08-16T00:00:00Z");
  });

  it("reports a failed search rather than returning an empty page", async () => {
    const { fetcher } = fetcherWith(() => new Response("rate limited", { status: 403 }));
    await expect(
      fetcher.fetch(githubSource, undefined, new AbortController().signal),
    ).rejects.toBeInstanceOf(SourceFetchError);
  });

  it("carries GitHub's own explanation into the error", async () => {
    // A live run stalled for an hour on three identical `403 Forbidden` lines. GitHub
    // answers a secondary rate limit, a blocked User-Agent and a bad query the same way;
    // only the body tells them apart.
    const { fetcher } = fetcherWith(
      () =>
        new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
          status: 403,
          headers: { "retry-after": "60", "x-ratelimit-remaining": "0" },
        }),
    );

    await expect(
      fetcher.fetch(githubSource, undefined, new AbortController().signal),
    ).rejects.toThrow(/secondary rate limit.*|.*retry-after: 60/);
  });

  it("sends the default User-Agent when the configured one is blank", async () => {
    // An empty FB_AI_USER_AGENT in .env used to reach the wire verbatim; Hugging Face
    // answers a blank User-Agent with 403.
    let seen: Record<string, string> = {};
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/robots.txt") return new Response("", { status: 200 });
      seen = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse({ items: [] });
    }) as unknown as typeof globalThis.fetch;

    const fetcher = new HttpSourceFetcher({ fetch: fetchImpl, now: () => NOW, userAgent: "  " });
    await fetcher.fetch(githubSource, undefined, new AbortController().signal);

    expect(seen["user-agent"]).toMatch(/FB_AI/);
  });
});

describe("HttpSourceFetcher feeds", () => {
  const rss = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>Blog</title>
      <item>
        <title>Model released</title>
        <link>https://example.test/a</link>
        <guid>post-a</guid>
        <description>A new open model.</description>
        <pubDate>Sat, 16 Aug 2026 00:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;

  it("parses RSS items into raw items", async () => {
    const { fetcher } = fetcherWith(
      () => new Response(rss, { status: 200, headers: { etag: 'W/"abc"' } }),
    );
    const page = await fetcher.fetch(feedSource, undefined, new AbortController().signal);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.title).toBe("Model released");
    expect(page.items[0]!.externalId).toBe("post-a");
    expect(page.items[0]!.canonicalUrl).toBe("https://example.test/a");
    expect(page.items[0]!.publishedOrUpdatedAt).toBe("2026-08-16T00:00:00.000Z");
    expect(page.nextCursor?.etag).toBe('W/"abc"');
  });

  it("sends conditional headers and returns nothing on 304", async () => {
    let seen: Record<string, string> = {};
    const { fetcher } = fetcherWith((_url, init) => {
      seen = (init?.headers ?? {}) as Record<string, string>;
      return new Response(null, { status: 304 });
    });

    const page = await fetcher.fetch(
      feedSource,
      { sourceId: "blog", etag: 'W/"abc"', updatedAt: NOW.toISOString() },
      new AbortController().signal,
    );
    expect(seen["if-none-match"]).toBe('W/"abc"');
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("reports a failed feed fetch", async () => {
    const { fetcher } = fetcherWith(() => new Response("gone", { status: 410 }));
    await expect(
      fetcher.fetch(feedSource, undefined, new AbortController().signal),
    ).rejects.toBeInstanceOf(SourceFetchError);
  });
});

describe("describeFailure", () => {
  it("prefers the JSON message and names the wait", async () => {
    const text = await describeFailure(
      new Response(JSON.stringify({ message: "Rate limit exceeded" }), {
        status: 403,
        headers: { "retry-after": "120" },
      }),
    );
    expect(text).toContain("403");
    expect(text).toContain("retry-after: 120");
    expect(text).toContain("Rate limit exceeded");
  });

  it("falls back to a bounded snippet when the body is not JSON", async () => {
    const text = await describeFailure(new Response("x".repeat(400), { status: 500 }));
    expect(text).toContain("500");
    expect(text.length).toBeLessThan(300);
  });

  it("says only what it knows when the body is empty", async () => {
    const text = await describeFailure(new Response(null, { status: 404 }));
    expect(text).toContain("404");
  });
});

describe("parseFeed", () => {
  it("reads Atom entries including the link href attribute", () => {
    const entries = parseFeed(`<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>urn:a</id>
          <title>Atom post</title>
          <link href="https://example.test/atom-a"/>
          <updated>2026-08-15T10:00:00Z</updated>
          <summary>Summary text</summary>
        </entry>
      </feed>`);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "urn:a",
      title: "Atom post",
      url: "https://example.test/atom-a",
      body: "Summary text",
    });
  });

  it("returns nothing for markup that is neither RSS nor Atom", () => {
    expect(parseFeed("<html><body>not a feed</body></html>")).toEqual([]);
  });
});
