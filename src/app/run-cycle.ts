import { bootstrap } from "./bootstrap.js";
import type { ServerEnvironment } from "./bootstrap.js";
import type { MvpCycleOutcome, MvpItemOutcome } from "./mvp-composition-root.js";

/**
 * Runs one production cycle: collect → score → research → generate → cross-verify →
 * compliance → pending review. Nothing is published; drafts that survive land in the
 * review dashboard for a person to approve.
 *
 * Kept out of the dashboard process so a slow model run never blocks review, and so the
 * cycle can be scheduled (cron, launchd, Task Scheduler) independently of uptime.
 */
export interface CycleReport {
  readonly collected: number;
  readonly skipped: number;
  readonly errors: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly pendingRunIds: readonly string[];
  /** Why each source was skipped or failed — without these a zero-item cycle is unactionable. */
  readonly skippedReasons: readonly SourceProblem[];
  readonly errorReasons: readonly SourceProblem[];
  /**
   * HTTP requests actually made per source. Rate limits are the main way a cycle fails,
   * and until this was printed the budget could only be estimated — badly.
   */
  readonly requestsBySource: Readonly<Record<string, number>>;
  /**
   * Why items stopped where they did, grouped by outcome.
   *
   * The counts alone read like a verdict when they are only a tally: three runs were spent
   * on `kiểm chứng chặn (có thể thử lại): 3` without knowing whether Model B timed out,
   * returned something unparseable, or was never reached.
   */
  readonly outcomeDetails: Readonly<Record<string, readonly string[]>>;
}

/** Reasons kept per outcome kind. Enough to see a pattern, not enough to bury the report. */
export const MAX_DETAILS_PER_OUTCOME = 3;

export interface SourceProblem {
  readonly sourceId: string;
  readonly reason: string;
  readonly attempts?: number;
}

export async function runCycle(env: ServerEnvironment = process.env): Promise<CycleReport> {
  const { app, sourceFetcher } = await bootstrap(env);
  try {
    sourceFetcher.resetRequestCounts();
    const outcome = await app.pipeline.runCycle();
    return summarize(outcome, sourceFetcher.requestCounts());
  } finally {
    app.close();
  }
}

export function summarize(
  outcome: MvpCycleOutcome,
  requests: ReadonlyMap<string, number> = new Map(),
): CycleReport {
  const outcomes: Record<string, number> = {};
  const pendingRunIds: string[] = [];
  const outcomeDetails: Record<string, string[]> = {};

  for (const item of outcome.items) {
    outcomes[item.kind] = (outcomes[item.kind] ?? 0) + 1;
    if (item.kind === "PendingReview") pendingRunIds.push(item.run.id);

    const detail = describeOutcome(item);
    if (detail !== undefined) {
      const kept = (outcomeDetails[item.kind] ??= []);
      if (kept.length < MAX_DETAILS_PER_OUTCOME && !kept.includes(detail)) kept.push(detail);
    }
  }

  return {
    collected: outcome.collection.items.length,
    skipped: outcome.collection.skipped.length,
    errors: outcome.collection.errors.length,
    outcomes,
    pendingRunIds,
    skippedReasons: outcome.collection.skipped.map((record) => ({
      sourceId: record.sourceId,
      reason: record.reason,
    })),
    errorReasons: outcome.collection.errors.map((record) => ({
      sourceId: record.sourceId,
      reason: record.reason,
      attempts: record.attempts,
    })),
    requestsBySource: Object.fromEntries(requests),
    outcomeDetails,
  };
}

/** Pulls the one sentence that says why, out of whichever shape the outcome carries. */
export function describeOutcome(item: MvpItemOutcome): string | undefined {
  switch (item.kind) {
    case "VerificationRetryableBlocked": {
      const { error } = item.verification;
      return `${error.dependency} ${error.code}: ${error.reason}`;
    }
    case "VerificationBlocked": {
      const failing = item.report.findings.filter(({ verdict }) => verdict !== "Pass");
      const first = failing[0];
      if (first === undefined) return undefined;
      return `${failing.length} claim không đạt, ví dụ ${first.verdict}: ${first.description ?? first.claimId}`;
    }
    case "GenerationFailed": {
      if (item.generation.kind !== "Failed") return undefined;
      const first = item.generation.errors[0];
      const where = first === undefined ? "" : ` (${first.path}: ${first.message})`;
      return `${item.generation.failureKind}${where}`;
    }
    case "ComplianceFailed": {
      const failing = item.results.filter((result) => !result.passed);
      const first = failing[0];
      if (first === undefined) return undefined;
      return `${failing.length} artifact vi phạm, ví dụ ${first.platform}`;
    }
    case "InsufficientResearch":
      return item.research.reason;
    default:
      return undefined;
  }
}

/** Human-readable labels for the reasons an item did not reach review. */
const OUTCOME_LABELS: Readonly<Record<MvpItemOutcome["kind"], string>> = {
  PendingReview: "chờ duyệt",
  BelowThreshold: "dưới ngưỡng điểm",
  Deferred: "để dành chu kỳ sau (vượt hạn mức mỗi chu kỳ)",
  InsufficientResearch: "không đủ research",
  GenerationFailed: "sinh nội dung lỗi",
  VerificationBlocked: "kiểm chứng chặn",
  VerificationRetryableBlocked: "kiểm chứng chặn (có thể thử lại)",
  ComplianceFailed: "vi phạm tiêu chuẩn/bản quyền",
};

export function formatReport(report: CycleReport): string {
  const lines = [
    `Thu thập: ${report.collected} mục (bỏ qua ${report.skipped}, lỗi ${report.errors})`,
  ];
  for (const problem of report.skippedReasons) {
    lines.push(`  bỏ qua ${problem.sourceId}: ${problem.reason}`);
  }
  for (const problem of report.errorReasons) {
    const attempts = problem.attempts === undefined ? "" : ` (đã thử ${problem.attempts} lần)`;
    lines.push(`  LỖI ${problem.sourceId}${attempts}: ${problem.reason}`);
  }
  for (const [kind, count] of Object.entries(report.outcomes)) {
    const label = OUTCOME_LABELS[kind as MvpItemOutcome["kind"]] ?? kind;
    lines.push(`  ${label}: ${count}`);
    for (const detail of report.outcomeDetails[kind] ?? []) {
      lines.push(`    ${detail}`);
    }
  }
  const requests = Object.entries(report.requestsBySource);
  if (requests.length > 0) {
    const total = requests.reduce((sum, [, count]) => sum + count, 0);
    const detail = requests.map(([id, count]) => `${id} ${count}`).join(", ");
    lines.push(`Request đã dùng: ${total} (${detail})`);
  }
  if (report.pendingRunIds.length > 0) {
    lines.push(`Sẵn sàng duyệt: ${report.pendingRunIds.join(", ")}`);
  } else {
    lines.push("Không có bài nào tới bước duyệt trong lần chạy này.");
  }
  return lines.join("\n");
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runCycle()
    .then((report) => {
      process.stdout.write(`${formatReport(report)}\n`);
      process.exit(0);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
