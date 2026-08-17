import { describe, expect, it } from "vitest";

import { formatReport, summarize } from "../src/app/run-cycle.js";
import type { MvpCycleOutcome } from "../src/app/mvp-composition-root.js";
import type { PipelineRun } from "../src/domain/workflow.js";

function run(id: string): PipelineRun {
  return { id } as unknown as PipelineRun;
}

function outcome(overrides: Partial<MvpCycleOutcome> = {}): MvpCycleOutcome {
  return {
    collection: { items: [], skipped: [], errors: [] },
    items: [],
    ...overrides,
  } as MvpCycleOutcome;
}

describe("summarize", () => {
  it("counts each outcome kind and lists the runs ready for review", () => {
    const report = summarize(
      outcome({
        collection: {
          items: [{}, {}, {}],
          skipped: [{}],
          errors: [{}, {}],
        } as unknown as MvpCycleOutcome["collection"],
        items: [
          { kind: "PendingReview", run: run("run-1") },
          { kind: "PendingReview", run: run("run-2") },
          { kind: "BelowThreshold" },
        ] as unknown as MvpCycleOutcome["items"],
      }),
    );

    expect(report.collected).toBe(3);
    expect(report.skipped).toBe(1);
    expect(report.errors).toBe(2);
    expect(report.outcomes).toEqual({ PendingReview: 2, BelowThreshold: 1 });
    expect(report.pendingRunIds).toEqual(["run-1", "run-2"]);
  });

  it("reports an empty cycle without inventing counts", () => {
    const report = summarize(outcome());
    expect(report).toEqual({
      collected: 0,
      skipped: 0,
      errors: 0,
      outcomes: {},
      pendingRunIds: [],
    });
  });
});

describe("formatReport", () => {
  it("translates outcome kinds and names the runs to review", () => {
    const text = formatReport({
      collected: 2,
      skipped: 0,
      errors: 0,
      outcomes: { PendingReview: 1, ComplianceFailed: 1 },
      pendingRunIds: ["run-1"],
    });
    expect(text).toContain("Thu thập: 2 mục");
    expect(text).toContain("chờ duyệt: 1");
    expect(text).toContain("vi phạm tiêu chuẩn/bản quyền: 1");
    expect(text).toContain("run-1");
  });

  it("says plainly when nothing reached review", () => {
    const text = formatReport({
      collected: 5,
      skipped: 5,
      errors: 0,
      outcomes: { BelowThreshold: 5 },
      pendingRunIds: [],
    });
    expect(text).toContain("Không có bài nào tới bước duyệt");
  });
});
