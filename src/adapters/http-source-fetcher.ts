import { createHash } from "node:crypto";

import { XMLParser } from "fast-xml-parser";

import type { SourceFetcher } from "./ports.js";
import type {
  FetchPage,
  RawItem,
  SourceConfig,
  SourceCursor,
  SourceFilterMode,
  SourcePermission,
} from "../domain/source.js";

/**
 * Real `SourceFetcher` for Phase 1.
 *
 * - `GitHub` sources: `source.url` is a GitHub REST search URL, e.g.
 *   `https://api.github.com/search/repositories?q=topic:ai+stars:>200&sort=updated`.
 *   Paged with the `page` query parameter; the cursor carries the page number and the
 *   newest `pushed_at` already seen so later runs stop once they reach known items.
 * - `Website` / `Forum` sources: `source.url` is an RSS or Atom feed. Feeds are a single
 *   page, so the cursor carries `ETag` / `Last-Modified` for a conditional GET instead.
 */
export interface HttpSourceFetcherOptions {
  /** Injected for tests; defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  /** Sent as `User-Agent`; identifies the operator to the sources being read. */
  readonly userAgent?: string;
  /** Optional GitHub token. Raises the rate limit from 10 to 30 search requests/minute. */
  readonly githubToken?: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Maximum items returned per page. */
  readonly pageSize?: number;
  /**
   * Pages to walk per source per cycle. The collector keeps following `nextCursor` until
   * a page says stop, and GitHub search allows 1,000 results — without a cap the first
   * run walks the whole result set and exhausts the rate limit. Stopping early is safe:
   * the cursor records the newest item seen, so the next cycle resumes from there.
   */
  readonly maxPagesPerCycle?: number;
}

const DEFAULT_USER_AGENT = "FB_AI/0.1 (+https://github.com/areaoneamusement/FB_AI)";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_PAGE_SIZE = 30;
const DEFAULT_MAX_PAGES_PER_CYCLE = 3;
const TERMS_VERSION = "http-source-fetcher-2026-08";

/** Minimum stars a GitHub repository needs before it is worth scoring. */
const MIN_STARS_BY_FILTER: Record<SourceFilterMode, number> = {
  Best: 1_000,
  High: 200,
  All: 0,
};

interface GitHubRepository {
  readonly id: number;
  readonly full_name: string;
  readonly html_url: string;
  readonly description: string | null;
  readonly stargazers_count: number;
  readonly pushed_at: string;
  readonly updated_at: string;
  readonly topics?: readonly string[];
}

interface FeedEntry {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly url?: string;
  readonly publishedAt?: string;
}

/**
 * Status and status text alone are not actionable: GitHub answers a secondary rate limit,
 * a blocked User-Agent and a bad query all with `403 Forbidden`, and puts the difference in
 * the body. A live run stalled for an hour on three identical `403 Forbidden` lines that
 * carried no way to tell those apart. `Retry-After` is included because it says how long to
 * wait, which is usually the only decision left to make.
 */
export async function describeFailure(response: Response): Promise<string> {
  const parts = [`${response.status} ${response.statusText}`.trim()];

  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) parts.push(`retry-after: ${retryAfter}`);

  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  if (remaining !== null) {
    const resetsAt = reset === null ? "" : `, reset ${formatEpochSeconds(reset)}`;
    parts.push(`quota còn ${remaining}${resetsAt}`);
  }

  const detail = await readFailureBody(response);
  if (detail !== undefined) parts.push(detail);

  return parts.join(" | ");
}

/** Never lets diagnostics become the reason a cycle fails. */
async function readFailureBody(response: Response): Promise<string | undefined> {
  try {
    const raw = (await response.text()).trim();
    if (raw.length === 0) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
        const { message } = parsed as { message: unknown };
        if (typeof message === "string" && message.trim().length > 0) {
          return message.trim();
        }
      }
    } catch {
      // Not JSON; fall through to the raw snippet.
    }
    return `${raw.slice(0, 200).replace(/\s+/g, " ")}${raw.length > 200 ? "…" : ""}`;
  } catch {
    return undefined;
  }
}

function formatEpochSeconds(value: string): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return value;
  return new Date(seconds * 1_000).toISOString();
}

export class SourceFetchError extends Error {
  constructor(
    readonly sourceId: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SourceFetchError";
  }
}

export class HttpSourceFetcher implements SourceFetcher {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly pageSize: number;
  private readonly maxPagesPerCycle: number;
  private readonly robotsCache = new Map<string, Promise<RobotsSnapshot>>();

  constructor(private readonly options: HttpSourceFetcherOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    // A blank User-Agent is worse than none: Hugging Face answers it with 403.
    this.userAgent = options.userAgent?.trim() || DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxPagesPerCycle = options.maxPagesPerCycle ?? DEFAULT_MAX_PAGES_PER_CYCLE;
  }

  async isAllowed(source: SourceConfig): Promise<SourcePermission> {
    const capturedAt = this.now().toISOString();
    let target: URL;
    try {
      target = new URL(source.url);
    } catch {
      return {
        allowed: false,
        reason: `Invalid source URL: ${source.url}`,
        termsVersion: TERMS_VERSION,
        robotsCapturedAt: capturedAt,
      };
    }
    if (target.protocol !== "https:") {
      return {
        allowed: false,
        reason: "Only https sources are permitted",
        termsVersion: TERMS_VERSION,
        robotsCapturedAt: capturedAt,
      };
    }

    const robots = await this.loadRobots(target);
    const allowed = isPathAllowed(robots.disallowed, target.pathname);
    return {
      allowed,
      ...(allowed ? {} : { reason: `Blocked by robots.txt at ${robots.robotsUrl}` }),
      termsVersion: TERMS_VERSION,
      robotsCapturedAt: robots.capturedAt,
    };
  }

  async fetch(
    source: SourceConfig,
    cursor: SourceCursor | undefined,
    signal: AbortSignal,
  ): Promise<FetchPage> {
    if (source.type === "GitHub") {
      return await this.fetchGitHub(source, cursor, signal);
    }
    return await this.fetchFeed(source, cursor, signal);
  }

  // ---------------------------------------------------------------- GitHub

  private async fetchGitHub(
    source: SourceConfig,
    cursor: SourceCursor | undefined,
    signal: AbortSignal,
  ): Promise<FetchPage> {
    const page = parsePage(cursor?.cursor);
    const highWaterMark = cursor?.lastModified;

    const url = new URL(source.url);
    url.searchParams.set("per_page", String(this.pageSize));
    url.searchParams.set("page", String(page));

    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": this.userAgent,
    };
    if (this.options.githubToken) {
      headers.authorization = `Bearer ${this.options.githubToken}`;
    }

    const response = await this.request(source, url, { headers, signal });
    if (!response.ok) {
      throw new SourceFetchError(
        source.id,
        `GitHub search failed with ${await describeFailure(response)}`,
        response.status,
      );
    }

    const payload = (await response.json()) as { items?: readonly GitHubRepository[] };
    const repositories = payload.items ?? [];
    const minStars = MIN_STARS_BY_FILTER[source.filterMode];

    const items: RawItem[] = [];
    let newest = highWaterMark;
    let reachedKnownItems = false;

    for (const repository of repositories) {
      const updatedAt = repository.pushed_at || repository.updated_at;
      if (highWaterMark !== undefined && updatedAt <= highWaterMark) {
        // Results are sorted newest-first, so everything after this is already collected.
        reachedKnownItems = true;
        break;
      }
      if (newest === undefined || updatedAt > newest) newest = updatedAt;
      if (repository.stargazers_count < minStars) continue;

      const body = [
        repository.description ?? "",
        repository.topics?.length ? `Topics: ${repository.topics.join(", ")}` : "",
      ]
        .filter((part) => part.length > 0)
        .join("\n");

      items.push({
        sourceId: source.id,
        externalId: String(repository.id),
        canonicalUrl: repository.html_url,
        normalizedContentHash: hashContent(repository.full_name, body, updatedAt),
        publishedOrUpdatedAt: new Date(updatedAt).toISOString(),
        title: repository.full_name,
        body,
        github: {
          stars: repository.stargazers_count,
          lastUpdatedAt: new Date(updatedAt).toISOString(),
        },
      });
    }

    // Stop when the page was short, when we caught up with the previous run, or when
    // this cycle has walked as many pages as it is allowed to.
    const exhausted =
      reachedKnownItems || repositories.length < this.pageSize || page >= this.maxPagesPerCycle;
    if (exhausted) {
      return {
        items,
        // Reset to page 1 and remember the high-water mark for the next run.
        ...(newest === undefined
          ? {}
          : {
              nextCursor: {
                sourceId: source.id,
                cursor: "1",
                lastModified: newest,
                updatedAt: this.now().toISOString(),
              },
            }),
      };
    }

    return {
      items,
      nextCursor: {
        sourceId: source.id,
        cursor: String(page + 1),
        ...(highWaterMark === undefined ? {} : { lastModified: highWaterMark }),
        updatedAt: this.now().toISOString(),
      },
    };
  }

  // ------------------------------------------------------------- RSS / Atom

  private async fetchFeed(
    source: SourceConfig,
    cursor: SourceCursor | undefined,
    signal: AbortSignal,
  ): Promise<FetchPage> {
    const headers: Record<string, string> = {
      accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
      "user-agent": this.userAgent,
    };
    if (cursor?.etag) headers["if-none-match"] = cursor.etag;
    if (cursor?.lastModified) headers["if-modified-since"] = cursor.lastModified;

    const response = await this.request(source, new URL(source.url), { headers, signal });

    if (response.status === 304) {
      // Nothing changed since the last run; keep the cursor as-is.
      return { items: [] };
    }
    if (!response.ok) {
      throw new SourceFetchError(
        source.id,
        `Feed fetch failed with ${await describeFailure(response)}`,
        response.status,
      );
    }

    const body = await response.text();
    const entries = parseFeed(body);
    const items = entries.slice(0, this.pageSize).map((entry) => {
      const publishedAt = entry.publishedAt ?? this.now().toISOString();
      return {
        sourceId: source.id,
        externalId: entry.id,
        ...(entry.url === undefined ? {} : { canonicalUrl: entry.url }),
        normalizedContentHash: hashContent(entry.title, entry.body, publishedAt),
        publishedOrUpdatedAt: publishedAt,
        title: entry.title,
        body: entry.body,
      } satisfies RawItem;
    });

    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    if (etag === null && lastModified === null) {
      // No validators to store — a cursor would carry no information.
      return { items };
    }

    return {
      items,
      nextCursor: {
        sourceId: source.id,
        ...(etag === null ? {} : { etag }),
        ...(lastModified === null ? {} : { lastModified }),
        updatedAt: this.now().toISOString(),
      },
    };
  }

  // ------------------------------------------------------------------ HTTP

  private async request(
    source: SourceConfig,
    url: URL,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([init.signal, timeout]);
    try {
      return await this.fetchImpl(url, { headers: init.headers, signal, redirect: "follow" });
    } catch (error) {
      if (init.signal.aborted) throw error;
      throw new SourceFetchError(
        source.id,
        `Request to ${url.origin}${url.pathname} failed: ${describeError(error)}`,
      );
    }
  }

  private async loadRobots(target: URL): Promise<RobotsSnapshot> {
    const cached = this.robotsCache.get(target.origin);
    if (cached !== undefined) return await cached;

    const pending = this.fetchRobots(target);
    this.robotsCache.set(target.origin, pending);
    return await pending;
  }

  private async fetchRobots(target: URL): Promise<RobotsSnapshot> {
    const robotsUrl = `${target.origin}/robots.txt`;
    const capturedAt = this.now().toISOString();
    try {
      const response = await this.fetchImpl(robotsUrl, {
        headers: { "user-agent": this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Missing or server-error robots.txt is treated as "no restrictions", which is
      // how the major crawlers read it.
      if (!response.ok) return { disallowed: [], capturedAt, robotsUrl };
      return { disallowed: parseRobots(await response.text()), capturedAt, robotsUrl };
    } catch {
      return { disallowed: [], capturedAt, robotsUrl };
    }
  }
}

interface RobotsSnapshot {
  readonly disallowed: readonly string[];
  readonly capturedAt: string;
  readonly robotsUrl: string;
}

// --------------------------------------------------------------- utilities

function parsePage(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

function hashContent(title: string, body: string, timestamp: string): string {
  const normalized = `${title} ${body} ${timestamp}`.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Collects `Disallow` rules from the `*` user-agent group. Rules for other crawlers do
 * not apply to us, and `Allow` is only meaningful as an exception inside a group we do
 * not otherwise honour, so it is ignored.
 */
export function parseRobots(body: string): readonly string[] {
  const disallowed: string[] = [];
  let inWildcardGroup = false;
  let sawAgentInCurrentGroup = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (line.length === 0) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      // Consecutive user-agent lines form one group.
      if (!sawAgentInCurrentGroup) inWildcardGroup = false;
      sawAgentInCurrentGroup = true;
      if (value === "*") inWildcardGroup = true;
      continue;
    }

    sawAgentInCurrentGroup = false;
    if (field === "disallow" && inWildcardGroup && value.length > 0) {
      disallowed.push(value);
    }
  }
  return disallowed;
}

export function isPathAllowed(disallowed: readonly string[], pathname: string): boolean {
  return !disallowed.some((rule) => pathname.startsWith(rule));
}

/** Extracts entries from an RSS 2.0 or Atom feed. */
export function parseFeed(xml: string): readonly FeedEntry[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true,
  });
  const document = parser.parse(xml) as Record<string, unknown>;

  const rssChannel = readPath(document, ["rss", "channel"]);
  if (rssChannel !== undefined) {
    return toArray(readPath(rssChannel, ["item"])).map(readRssItem).filter(isEntry);
  }

  const feed = readPath(document, ["feed"]);
  if (feed !== undefined) {
    return toArray(readPath(feed, ["entry"])).map(readAtomEntry).filter(isEntry);
  }

  return [];
}

function readRssItem(node: unknown): FeedEntry | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const record = node as Record<string, unknown>;
  const title = readText(record.title);
  if (title === undefined) return undefined;
  const link = readText(record.link);
  const guid = readText(record.guid) ?? link ?? title;
  const published = readText(record.pubDate);
  return {
    id: guid,
    title,
    body: readText(record.description) ?? "",
    ...(link === undefined ? {} : { url: link }),
    ...(published === undefined ? {} : { publishedAt: toIso(published) }),
  };
}

function readAtomEntry(node: unknown): FeedEntry | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const record = node as Record<string, unknown>;
  const title = readText(record.title);
  if (title === undefined) return undefined;

  const linkNode = Array.isArray(record.link) ? record.link[0] : record.link;
  const link =
    typeof linkNode === "object" && linkNode !== null
      ? readText((linkNode as Record<string, unknown>)["@_href"])
      : readText(linkNode);

  const id = readText(record.id) ?? link ?? title;
  const published = readText(record.updated) ?? readText(record.published);
  const body = readText(record.summary) ?? readText(record.content) ?? "";

  return {
    id,
    title,
    body,
    ...(link === undefined ? {} : { url: link }),
    ...(published === undefined ? {} : { publishedAt: toIso(published) }),
  };
}

function isEntry(entry: FeedEntry | undefined): entry is FeedEntry {
  return entry !== undefined;
}

function readPath(node: unknown, path: readonly string[]): unknown {
  let current = node;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function toArray(node: unknown): readonly unknown[] {
  if (node === undefined || node === null) return [];
  return Array.isArray(node) ? node : [node];
}

function readText(node: unknown): string | undefined {
  if (typeof node === "string") return node.length > 0 ? node : undefined;
  if (typeof node === "number") return String(node);
  if (typeof node === "object" && node !== null) {
    const text = (node as Record<string, unknown>)["#text"];
    if (typeof text === "string" && text.length > 0) return text;
  }
  return undefined;
}

function toIso(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}
