import type { SourceFetcher } from "./ports.js";
import type {
  FetchPage,
  SourceConfig,
  SourceCursor,
  SourcePermission,
} from "../domain/source.js";

/**
 * Serves one fetch per (source, cursor) per cycle instead of one per topic.
 *
 * `ResearchAggregator.aggregate` runs once per topic and always walks a source from
 * cursor `undefined`, so every topic in a cycle asks for byte-identical pages. With four
 * sources, three topics and three pages per source that is 36 requests where 12 would do —
 * enough to trip GitHub's secondary rate limit and Hugging Face's 429 inside one cycle.
 *
 * Only successful calls are memoised: a rejection is evicted so the next topic retries
 * rather than inheriting a timeout that belonged to another topic's deadline. Call `reset`
 * between cycles, otherwise a later cycle would serve pages captured by an earlier one.
 */
export class MemoizingSourceFetcher implements SourceFetcher {
  readonly #pages = new Map<string, Promise<FetchPage>>();
  readonly #permissions = new Map<string, Promise<SourcePermission>>();

  public constructor(private readonly inner: SourceFetcher) {}

  public async fetch(
    source: SourceConfig,
    cursor: SourceCursor | undefined,
    signal: AbortSignal,
  ): Promise<FetchPage> {
    const key = `${source.id} ${cursor === undefined ? "" : JSON.stringify(cursor)}`;
    return await this.#memoize(this.#pages, key, () =>
      this.inner.fetch(source, cursor, signal),
    );
  }

  public async isAllowed(source: SourceConfig): Promise<SourcePermission> {
    return await this.#memoize(this.#permissions, source.id, () =>
      this.inner.isAllowed(source),
    );
  }

  /** Drops everything captured so far. Call at the start of each cycle. */
  public reset(): void {
    this.#pages.clear();
    this.#permissions.clear();
  }

  async #memoize<T>(
    cache: Map<string, Promise<T>>,
    key: string,
    call: () => Promise<T>,
  ): Promise<T> {
    const cached = cache.get(key);
    if (cached !== undefined) return await cached;

    const pending = call();
    cache.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      // A failure belongs to the caller whose deadline expired, not to the cycle.
      if (cache.get(key) === pending) cache.delete(key);
      throw error;
    }
  }
}
