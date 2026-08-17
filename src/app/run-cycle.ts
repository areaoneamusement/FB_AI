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
}

export async function runCycle(env: ServerEnvironment = process.env): Promise<CycleReport> {
  const { app } = await bootstrap(env);
  try {
    return summarize(await app.pipeline.runCycle());
  } finally {
    app.close();
  }
}

export function summarize(outcome: MvpCycleOutcome): CycleReport {
  const outcomes: Record<string, number> = {};
  const pendingRunIds: string[] = [];

  for (const item of outcome.items) {
    outcomes[item.kind] = (outcomes[item.kind] ?? 0) + 1;
    if (item.kind === "PendingReview") pendingRunIds.push(item.run.id);
  }

  return {
    collected: outcome.collection.items.length,
    skipped: outcome.collection.skipped.length,
    errors: outcome.collection.errors.length,
    outcomes,
    pendingRunIds,
  };
}

/** Human-readable labels for the reasons an item did not reach review. */
const OUTCOME_LABELS: Readonly<Record<MvpItemOutcome["kind"], string>> = {
  PendingReview: "chờ duyệt",
  BelowThreshold: "dưới ngưỡng điểm",
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
  for (const [kind, count] of Object.entries(report.outcomes)) {
    const label = OUTCOME_LABELS[kind as MvpItemOutcome["kind"]] ?? kind;
    lines.push(`  ${label}: ${count}`);
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
