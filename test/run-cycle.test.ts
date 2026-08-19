import { describe, expect, it } from "vitest";

import { describeOutcome, formatReport, summarize } from "../src/app/run-cycle.js";
import type { MvpCycleOutcome, MvpItemOutcome } from "../src/app/mvp-composition-root.js";
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
      requestsBySource: {},
      outcomeDetails: {},
    });
  });
});

describe("describeOutcome", () => {
  it("names the dependency and failure code behind a retryable block", () => {
    const detail = describeOutcome({
      kind: "VerificationRetryableBlocked",
      run: run("run-1"),
      verification: {
        error: {
          dependency: "ModelB",
          code: "DeadlineExceeded",
          reason: "Model B không trả lời trong 120000ms",
        },
      },
    } as unknown as MvpItemOutcome);
    expect(detail).toBe("ModelB DeadlineExceeded: Model B không trả lời trong 120000ms");
  });

  it("counts failing claims and shows one", () => {
    const detail = describeOutcome({
      kind: "VerificationBlocked",
      run: run("run-1"),
      report: {
        findings: [
          { claimId: "c1", verdict: "Pass" },
          { claimId: "c2", verdict: "Contradiction", description: "Số liệu không có nguồn" },
          { claimId: "c3", verdict: "Unsupported" },
        ],
      },
    } as unknown as MvpItemOutcome);
    expect(detail).toContain("2 claim không đạt");
    expect(detail).toContain("Số liệu không có nguồn");
  });

  it("names where generation broke", () => {
    const detail = describeOutcome({
      kind: "GenerationFailed",
      run: run("run-1"),
      generation: {
        kind: "Failed",
        failureKind: "Validation",
        errors: [{ format: "facebookPost", path: "facebookPost", message: "quá ngắn" }],
      },
    } as unknown as MvpItemOutcome);
    expect(detail).toBe("Validation (facebookPost: quá ngắn)");
  });

  it("passes the research reason through unchanged", () => {
    const detail = describeOutcome({
      kind: "InsufficientResearch",
      run: run("run-1"),
      research: { reason: "Chỉ gom được 1/2 nguồn" },
    } as unknown as MvpItemOutcome);
    expect(detail).toBe("Chỉ gom được 1/2 nguồn");
  });

  it("says nothing for outcomes that carry no reason", () => {
    expect(describeOutcome({ kind: "Deferred" } as unknown as MvpItemOutcome)).toBeUndefined();
    expect(describeOutcome({ kind: "PendingReview" } as unknown as MvpItemOutcome)).toBeUndefined();
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
      requestsBySource: {},
      outcomeDetails: {},
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
      requestsBySource: {},
      outcomeDetails: {},
    });
    expect(text).toContain("bỏ qua blog: Blocked by robots.txt");
    expect(text).toContain("LỖI github-llm (đã thử 3 lần): GitHub search failed with 403");
  });

  it("prints why an outcome happened, not just how many", () => {
    // Three live runs read `kiểm chứng chặn (có thể thử lại): 3` without saying whether
    // Model B timed out, answered with something unparseable, or was never reached.
    const text = formatReport({
      collected: 4,
      skipped: 0,
      errors: 0,
      outcomes: { VerificationRetryableBlocked: 3 },
      pendingRunIds: [],
      skippedReasons: [],
      errorReasons: [],
      requestsBySource: {},
      outcomeDetails: {
        VerificationRetryableBlocked: ["ModelB DeadlineExceeded: quá 120000ms"],
      },
    });
    expect(text).toContain("kiểm chứng chặn (có thể thử lại): 3");
    expect(text).toContain("ModelB DeadlineExceeded: quá 120000ms");
  });

  it("prints how many requests each source cost", () => {
    // Rate limits are the main way a cycle fails. Four live runs were spent arguing about
    // the budget because nothing measured it.
    const text = formatReport({
      collected: 4,
      skipped: 0,
      errors: 0,
      outcomes: {},
      pendingRunIds: [],
      skippedReasons: [],
      errorReasons: [],
      requestsBySource: { "github-llm": 14, "google-ai-blog": 2 },
      outcomeDetails: {},
    });
    expect(text).toContain("Request đã dùng: 16");
    expect(text).toContain("github-llm 14");
  });

  it("says nothing about requests when none were counted", () => {
    const text = formatReport({
      collected: 0,
      skipped: 0,
      errors: 0,
      outcomes: {},
      pendingRunIds: [],
      skippedReasons: [],
      errorReasons: [],
      requestsBySource: {},
      outcomeDetails: {},
    });
    expect(text).not.toContain("Request đã dùng");
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
      requestsBySource: {},
      outcomeDetails: {},
    });
    expect(text).toContain("Không có bài nào tới bước duyệt");
  });
});
