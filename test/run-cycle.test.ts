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
          skipped: [{ sourceId: "blog", reason: "Blocked by robots.txt" }],
          errors: [
            { sourceId: "github-llm", reason: "GitHub search failed with 403", attempts: 3 },
            { sourceId: "feed", reason: "Feed fetch failed with 410", attempts: 1 },
          ],
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
    expect(report.skippedReasons).toEqual([
      { sourceId: "blog", reason: "Blocked by robots.txt" },
    ]);
    expect(report.errorReasons).toEqual([
      { sourceId: "github-llm", reason: "GitHub search failed with 403", attempts: 3 },
      { sourceId: "feed", reason: "Feed fetch failed with 410", attempts: 1 },
    ]);
  });

  it("reports an empty cycle without inventing counts", () => {
    const report = summarize(outcome());
    expect(report).toEqual({
      collected: 0,
      skipped: 0,
      errors: 0,
      outcomes: {},
      pendingRunIds: [],
      skippedReasons: [],
      errorReasons: [],
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
      skippedReasons: [],
      errorReasons: [],
    });
    expect(text).toContain("Thu thập: 2 mục");
    expect(text).toContain("chờ duyệt: 1");
    expect(text).toContain("vi phạm tiêu chuẩn/bản quyền: 1");
    expect(text).toContain("run-1");
  });

  it("prints why each source was skipped or failed", () => {
    // A cycle that collects nothing is unactionable unless the reason is on screen.
    const text = formatReport({
      collected: 0,
      skipped: 1,
      errors: 1,
      outcomes: {},
      pendingRunIds: [],
      skippedReasons: [{ sourceId: "blog", reason: "Blocked by robots.txt" }],
      errorReasons: [
        { sourceId: "github-llm", reason: "GitHub search failed with 403", attempts: 3 },
      ],
    });
    expect(text).toContain("bỏ qua blog: Blocked by robots.txt");
    expect(text).toContain("LỖI github-llm (đã thử 3 lần): GitHub search failed with 403");
  });

  it("says plainly when nothing reached review", () => {
    const text = formatReport({
      collected: 5,
      skipped: 5,
      errors: 0,
      outcomes: { BelowThreshold: 5 },
      pendingRunIds: [],
      skippedReasons: [],
      errorReasons: [],
    });
    expect(text).toContain("Không có bài nào tới bước duyệt");
  });
});
