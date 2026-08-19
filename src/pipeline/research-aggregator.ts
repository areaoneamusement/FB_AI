import { randomUUID } from "node:crypto";

import type { SourceFetcher } from "../adapters/ports.js";
import type {
  ResearchItem,
  ResearchResult,
  SkippedSource,
  Topic,
} from "../domain/content.js";
import type {
  FetchPage,
  RawItem,
  SourceConfig,
  SourceCursor,
  SourceReference,
} from "../domain/source.js";

export interface ResearchAggregationOptions {
  readonly minItems?: number;
  readonly perSourceTimeoutMs?: number;
  readonly overallDeadlineMs?: number;
}

export interface ResearchAggregatorDependencies {
  readonly now?: () => Date;
  readonly createId?: (kind: "research-result" | "research-item") => string;
}

export const DEFAULT_RESEARCH_AGGREGATION_OPTIONS = {
  minItems: 3,
  perSourceTimeoutMs: 15_000,
  overallDeadlineMs: 60_000,
} as const;

interface ResolvedOptions {
  readonly minItems: number;
  readonly perSourceTimeoutMs: number;
  readonly overallDeadlineMs: number;
}

type SourceOutcome =
  | { readonly kind: "Fetched"; readonly items: readonly ResearchItem[] }
  | {
      readonly kind: "Disallowed";
      readonly reason: string;
      /** Terms version in effect when access was refused. */
      readonly termsVersion: string;
    }
  | {
      readonly kind: "Unreachable";
      readonly reason: string;
      readonly reference: SourceReference;
    };

/**
 * Builds immutable, source-backed research artifacts. Workflow transitions are
 * intentionally left to ContentPipeline.
 */
export class ResearchAggregator {
  readonly #now: () => Date;
  readonly #createId: ResearchAggregatorDependencies["createId"];

  public constructor(
    private readonly fetcher: SourceFetcher,
    dependencies: ResearchAggregatorDependencies = {},
  ) {
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId =
      dependencies.createId ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  public async aggregate(
    topic: Topic,
    sources: readonly SourceConfig[],
    options: ResearchAggregationOptions = {},
  ): Promise<ResearchResult> {
    const resolved = resolveOptions(options);
    const capturedAt = this.#now();
    if (!Number.isFinite(capturedAt.getTime())) {
      throw new Error("Research aggregation clock returned an invalid Date");
    }
    assertUniqueSourceIds(sources);

    const resultId = this.makeId("research-result");
    const origin = sources.find(({ id }) => id === topic.sourceRef.sourceId);
    if (origin === undefined || !origin.active) {
      return freezeResult({
        id: resultId,
        topicId: topic.id,
        items: [],
        status: "InsufficientData",
        reason: `Origin source ${topic.sourceRef.sourceId} is unavailable`,
        unreachableSources: [topic.sourceRef],
        skippedSources: [],
      });
    }

    const overallController = new AbortController();
    const overallTimer = setTimeout(
      () =>
        overallController.abort(
          new DeadlineExceededError("overall", resolved.overallDeadlineMs),
        ),
      resolved.overallDeadlineMs,
    );

    try {
      const originOutcome = await this.fetchSource(
        origin,
        topic.sourceRef,
        capturedAt,
        resolved.perSourceTimeoutMs,
        overallController.signal,
      );
      if (originOutcome.kind !== "Fetched") {
        // A permission refusal is recorded as skipped, never as unreachable
        // (CR-0002); the status and reason are unchanged either way.
        return freezeResult({
          id: resultId,
          topicId: topic.id,
          items: [],
          status: "InsufficientData",
          reason: `Origin source ${origin.id} is unavailable: ${originOutcome.reason}`,
          unreachableSources:
            originOutcome.kind === "Unreachable" ? [originOutcome.reference] : [],
          skippedSources:
            originOutcome.kind === "Disallowed"
              ? [
                  skippedSource(
                    Object.freeze({
                      ...topic.sourceRef,
                      termsVersion: originOutcome.termsVersion,
                    }),
                    originOutcome,
                  ),
                ]
              : [],
        });
      }

      const related = sources.filter(
        (source) => source.active && source.id !== origin.id,
      );
      const relatedOutcomes = await Promise.all(
        related.map((source) =>
          this.fetchSource(
            source,
            diagnosticReference(source, capturedAt.toISOString()),
            capturedAt,
            resolved.perSourceTimeoutMs,
            overallController.signal,
          ),
        ),
      );

      const items = [...originOutcome.items];
      const unreachableSources: SourceReference[] = [];
      const skippedSources: SkippedSource[] = [];
      for (const [index, outcome] of relatedOutcomes.entries()) {
        if (outcome.kind === "Fetched") items.push(...outcome.items);
        if (outcome.kind === "Unreachable") {
          unreachableSources.push(outcome.reference);
        }
        if (outcome.kind === "Disallowed") {
          // Recorded so an Operator can see the source was excluded on
          // permission grounds rather than lost to a failure (CR-0002).
          const source = related[index] as SourceConfig;
          skippedSources.push(
            skippedSource(
              skippedReference(
                source,
                capturedAt.toISOString(),
                outcome.termsVersion,
              ),
              outcome,
            ),
          );
        }
      }

      const status = items.length >= resolved.minItems ? "Ok" : "InsufficientData";
      return freezeResult({
        id: resultId,
        topicId: topic.id,
        items,
        status,
        ...(status === "InsufficientData"
          ? {
              reason: `Collected ${items.length} research item(s); minimum is ${resolved.minItems}`,
            }
          : {}),
        unreachableSources,
        skippedSources,
      });
    } finally {
      clearTimeout(overallTimer);
    }
  }

  private async fetchSource(
    source: SourceConfig,
    fallbackReference: SourceReference,
    capturedAt: Date,
    timeoutMs: number,
    overallSignal: AbortSignal,
  ): Promise<SourceOutcome> {
    const controller = new AbortController();
    const onOverallAbort = (): void => controller.abort(overallSignal.reason);
    if (overallSignal.aborted) controller.abort(overallSignal.reason);
    else overallSignal.addEventListener("abort", onOverallAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new DeadlineExceededError("source", timeoutMs)),
      timeoutMs,
    );
    let termsVersion = fallbackReference.termsVersion;

    try {
      const permission = await raceWithAbort(
        this.fetcher.isAllowed(source),
        controller.signal,
      );
      termsVersion = permission.termsVersion;
      if (!permission.allowed) {
        return {
          kind: "Disallowed",
          reason:
            permission.reason?.trim() ||
            "Source terms or robots.txt prohibit research access",
          termsVersion,
        };
      }

      const rawItems = await this.fetchAllPages(source, controller.signal);
      const items = rawItems
        .map((item) =>
          this.toResearchItem(item, source, capturedAt, permission.termsVersion),
        )
        .filter((item): item is ResearchItem => item !== undefined);
      return { kind: "Fetched", items: Object.freeze(items) };
    } catch (error) {
      const reason = deadlineReason(error, source.id, timeoutMs);
      return {
        kind: "Unreachable",
        reason,
        reference: Object.freeze({
          ...fallbackReference,
          termsVersion,
        }),
      };
    } finally {
      clearTimeout(timer);
      overallSignal.removeEventListener("abort", onOverallAbort);
    }
  }

  private async fetchAllPages(
    source: SourceConfig,
    signal: AbortSignal,
  ): Promise<readonly RawItem[]> {
    const items: RawItem[] = [];
    const identities = new Set<string>();
    const visitedCursors = new Set<string>();
    let cursor: SourceCursor | undefined;

    while (true) {
      const cursorKey = serializeCursor(cursor);
      if (visitedCursors.has(cursorKey)) {
        throw new Error(`Fetcher returned a cursor cycle for source ${source.id}`);
      }
      visitedCursors.add(cursorKey);

      const page: FetchPage = await raceWithAbort(
        this.fetcher.fetch(source, cursor, signal),
        signal,
      );
      for (const item of page.items) {
        if (item.sourceId !== source.id) {
          throw new Error(
            `Fetched item source ${item.sourceId} does not match ${source.id}`,
          );
        }
        const identity = `${item.sourceId}\u0000${item.externalId}`;
        if (!identities.has(identity)) {
          identities.add(identity);
          items.push(item);
        }
      }

      if (page.nextCursor === undefined) return items;
      if (page.nextCursor.sourceId !== source.id) {
        throw new Error(
          `Cursor source ${page.nextCursor.sourceId} does not match ${source.id}`,
        );
      }
      if (page.exhausted === true) return items;
      cursor = page.nextCursor;
    }
  }

  private toResearchItem(
    raw: RawItem,
    source: SourceConfig,
    capturedAt: Date,
    termsVersion: string,
  ): ResearchItem | undefined {
    const content = raw.body.length > 0 ? raw.body : raw.title;
    if (content.length === 0) return undefined;

    const reference: SourceReference = Object.freeze({
      sourceId: source.id,
      captureId: raw.normalizedContentHash || raw.externalId,
      url: raw.canonicalUrl ?? source.url,
      capturedAt: capturedAt.toISOString(),
      termsVersion,
    });
    return Object.freeze({
      id: this.makeId("research-item"),
      content,
      // Raw fetches are direct captures. Inferred items require model provenance
      // and therefore cannot be created by this source-only processor.
      kind: "Quoted",
      evidenceRefs: Object.freeze([reference]),
    });
  }

  private makeId(kind: "research-result" | "research-item"): string {
    const id = this.#createId?.(kind);
    if (id === undefined || id.trim().length === 0) {
      throw new Error(`ID factory returned an empty ${kind} id`);
    }
    return id;
  }
}

class DeadlineExceededError extends Error {
  public constructor(
    public readonly scope: "source" | "overall",
    public readonly timeoutMs: number,
  ) {
    super(`${scope} deadline exceeded after ${timeoutMs}ms`);
    this.name = "DeadlineExceededError";
  }
}

function resolveOptions(options: ResearchAggregationOptions): ResolvedOptions {
  const resolved = { ...DEFAULT_RESEARCH_AGGREGATION_OPTIONS, ...options };
  assertIntegerInRange(resolved.minItems, 1, Number.MAX_SAFE_INTEGER, "minItems");
  assertIntegerInRange(
    resolved.perSourceTimeoutMs,
    1,
    DEFAULT_RESEARCH_AGGREGATION_OPTIONS.perSourceTimeoutMs,
    "perSourceTimeoutMs",
  );
  assertIntegerInRange(
    resolved.overallDeadlineMs,
    1,
    DEFAULT_RESEARCH_AGGREGATION_OPTIONS.overallDeadlineMs,
    "overallDeadlineMs",
  );
  return resolved;
}

function assertUniqueSourceIds(sources: readonly SourceConfig[]): void {
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) throw new Error(`Duplicate research source: ${source.id}`);
    ids.add(source.id);
  }
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function deadlineReason(
  error: unknown,
  sourceId: string,
  timeoutMs: number,
): string {
  if (error instanceof DeadlineExceededError) {
    return error.scope === "overall"
      ? `Overall research deadline exceeded while fetching source ${sourceId}`
      : `Source ${sourceId} timed out after ${timeoutMs}ms`;
  }
  return error instanceof Error ? error.message : String(error);
}

function diagnosticReference(
  source: SourceConfig,
  capturedAt: string,
): SourceReference {
  return Object.freeze({
    sourceId: source.id,
    captureId: `unreachable:${source.id}`,
    url: source.url,
    capturedAt,
    termsVersion: "unavailable",
  });
}

function skippedReference(
  source: SourceConfig,
  capturedAt: string,
  termsVersion: string,
): SourceReference {
  return Object.freeze({
    sourceId: source.id,
    captureId: `skipped:${source.id}`,
    url: source.url,
    capturedAt,
    termsVersion,
  });
}

function skippedSource(
  sourceRef: SourceReference,
  outcome: { readonly reason: string; readonly termsVersion: string },
): SkippedSource {
  return Object.freeze({
    sourceRef,
    reason: outcome.reason,
    termsVersion: outcome.termsVersion,
  });
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

function freezeResult(result: ResearchResult): ResearchResult {
  return Object.freeze({
    ...result,
    items: Object.freeze([...result.items]),
    unreachableSources: Object.freeze([...result.unreachableSources]),
    skippedSources: Object.freeze([...result.skippedSources]),
  });
}
