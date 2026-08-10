import type { SourceFetcher } from "../adapters/ports.js";
import type {
  RawItem,
  SourceConfig,
  SourceCursor,
  SourcePermission,
} from "../domain/source.js";
import { SourceRegistry } from "./source-registry.js";

export interface CollectionOptions {
  readonly windowHours?: number;
  readonly perRequestTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly baseRetryDelayMs?: number;
}

export interface CollectedSourceItem extends RawItem {
  readonly permission: SourcePermission;
  readonly collectedAt: string;
}

export interface CollectionSkipRecord {
  readonly sourceId: string;
  readonly reason: string;
  readonly termsVersion: string;
  readonly robotsCapturedAt: string;
  readonly skippedAt: string;
}

export interface CollectionErrorRecord {
  readonly sourceId: string;
  readonly reason: string;
  readonly attempts: number;
  readonly occurredAt: string;
}

export interface CollectionResult {
  readonly items: readonly CollectedSourceItem[];
  readonly skipped: readonly CollectionSkipRecord[];
  readonly errors: readonly CollectionErrorRecord[];
}

/**
 * Durable persistence boundary for collection checkpoints and item identity.
 * `acceptIfNew` must atomically persist accepted identity/fallback signals and
 * return false when any were previously accepted.
 */
export interface CollectionStateStore {
  getCursor(sourceId: string): Promise<SourceCursor | undefined>;
  saveCursor(cursor: SourceCursor): Promise<void>;
  acceptIfNew(item: CollectedSourceItem): Promise<boolean>;
}

export const DEFAULT_COLLECTION_OPTIONS = {
  windowHours: 24,
  perRequestTimeoutMs: 30_000,
  maxRetries: 3,
  baseRetryDelayMs: 100,
} as const;

export class SourceCollector {
  public constructor(
    private readonly registry: SourceRegistry,
    private readonly fetcher: SourceFetcher,
    private readonly state: CollectionStateStore,
  ) {}

  public async runCycle(
    options: CollectionOptions = {},
    now: Date = new Date(),
  ): Promise<CollectionResult> {
    const resolved = resolveOptions(options);
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new Error("now must be a valid Date");
    const earliestMs = nowMs - resolved.windowHours * 60 * 60 * 1_000;

    const items: CollectedSourceItem[] = [];
    const skipped: CollectionSkipRecord[] = [];
    const errors: CollectionErrorRecord[] = [];

    for (const source of this.registry.list({ activeOnly: true })) {
      let permission: SourcePermission;
      try {
        permission = await this.fetcher.isAllowed(source);
      } catch (error) {
        errors.push(errorRecord(source, error, 1, now));
        continue;
      }

      if (!permission.allowed) {
        skipped.push({
          sourceId: source.id,
          reason:
            permission.reason?.trim() ||
            "Collection prohibited by source terms or robots.txt",
          termsVersion: permission.termsVersion,
          robotsCapturedAt: permission.robotsCapturedAt,
          skippedAt: now.toISOString(),
        });
        continue;
      }

      try {
        await this.collectSource(
          source,
          permission,
          resolved,
          earliestMs,
          nowMs,
          now,
          items,
        );
      } catch (error) {
        const attempts =
          error instanceof FetchAttemptsExhaustedError
            ? error.attempts
            : 1;
        errors.push(errorRecord(source, error, attempts, now));
      }
    }

    return { items, skipped, errors };
  }

  private async collectSource(
    source: SourceConfig,
    permission: SourcePermission,
    options: ResolvedCollectionOptions,
    earliestMs: number,
    nowMs: number,
    now: Date,
    output: CollectedSourceItem[],
  ): Promise<void> {
    let cursor = await this.state.getCursor(source.id);
    const visitedCursors = new Set<string>();

    while (true) {
      const cursorKey = serializeCursor(cursor);
      if (visitedCursors.has(cursorKey)) {
        throw new Error(`Fetcher returned a cursor cycle for source ${source.id}`);
      }
      visitedCursors.add(cursorKey);

      const page = await fetchWithRetries(this.fetcher, source, cursor, options);
      for (const rawItem of page.items) {
        const timestamp = Date.parse(rawItem.publishedOrUpdatedAt);
        if (!Number.isFinite(timestamp) || timestamp < earliestMs || timestamp > nowMs) {
          continue;
        }

        const item: CollectedSourceItem = {
          ...rawItem,
          permission,
          collectedAt: now.toISOString(),
        };
        if (await this.state.acceptIfNew(item)) output.push(item);
      }

      if (page.nextCursor === undefined) return;
      if (page.nextCursor.sourceId !== source.id) {
        throw new Error(
          `Cursor source ${page.nextCursor.sourceId} does not match ${source.id}`,
        );
      }

      await this.state.saveCursor(page.nextCursor);
      cursor = page.nextCursor;
    }
  }
}

interface ResolvedCollectionOptions {
  readonly windowHours: number;
  readonly perRequestTimeoutMs: number;
  readonly maxRetries: number;
  readonly baseRetryDelayMs: number;
}

function resolveOptions(options: CollectionOptions): ResolvedCollectionOptions {
  const resolved = { ...DEFAULT_COLLECTION_OPTIONS, ...options };
  assertIntegerInRange(resolved.windowHours, 1, 720, "windowHours");
  assertIntegerInRange(
    resolved.perRequestTimeoutMs,
    1,
    30_000,
    "perRequestTimeoutMs",
  );
  assertIntegerInRange(resolved.maxRetries, 1, 5, "maxRetries");
  assertIntegerInRange(
    resolved.baseRetryDelayMs,
    0,
    30_000,
    "baseRetryDelayMs",
  );
  return resolved;
}

async function fetchWithRetries(
  fetcher: SourceFetcher,
  source: SourceConfig,
  cursor: SourceCursor | undefined,
  options: ResolvedCollectionOptions,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxRetries; attempt += 1) {
    try {
      return await fetchWithTimeout(
        fetcher,
        source,
        cursor,
        options.perRequestTimeoutMs,
      );
    } catch (error) {
      lastError = error;
      if (attempt < options.maxRetries) {
        await delay(options.baseRetryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  throw new FetchAttemptsExhaustedError(
    options.maxRetries,
    errorMessage(lastError),
  );
}

async function fetchWithTimeout(
  fetcher: SourceFetcher,
  source: SourceConfig,
  cursor: SourceCursor | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Fetch timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetcher.fetch(source, cursor, controller.signal),
      timeoutPromise,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

class FetchAttemptsExhaustedError extends Error {
  public constructor(
    public readonly attempts: number,
    reason: string,
  ) {
    super(`Fetch failed after ${attempts} attempt(s): ${reason}`);
    this.name = "FetchAttemptsExhaustedError";
  }
}

function errorRecord(
  source: SourceConfig,
  error: unknown,
  attempts: number,
  now: Date,
): CollectionErrorRecord {
  return {
    sourceId: source.id,
    reason: errorMessage(error),
    attempts,
    occurredAt: now.toISOString(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serializeCursor(cursor: SourceCursor | undefined): string {
  if (cursor === undefined) return "<initial>";
  return JSON.stringify([
    cursor.sourceId,
    cursor.cursor,
    cursor.etag,
    cursor.lastModified,
    cursor.updatedAt,
  ]);
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
