// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/dashboard/web/App.js";
import type {
  ApprovalDto,
  ContentDraftDto,
  PendingReviewDto,
  ReviewDashboardClient,
} from "../src/dashboard/web/api-client.js";

/**
 * Requirement 8.1: when a Content_Draft reaches PendingApproval the Review_Dashboard shows,
 * within 5 seconds, that draft together with its verification report and compliance results.
 * Design: superseded reports are labelled and never presented as valid evidence for the
 * active revision, and all source-derived content is output-encoded.
 */

const REVIEW_LOAD_DEADLINE_MS = 5_000;

const HOSTILE_FINDING_DESCRIPTION =
  'Mâu thuẫn với nguồn gốc: <script>alert("xss")</script> & <img src=x onerror="alert(1)"> — <b>đậm</b> \'trích\' "dẫn"';
const HOSTILE_COMPLIANCE_REASON =
  'Thiếu ghi công bắt buộc: <script>fetch("//evil.test")</script> <iframe src="//evil.test"></iframe> & <b>bản quyền</b>';

function pendingReview(): PendingReviewDto {
  return {
    pipelineRunId: "run-42",
    stage: "PendingApproval",
    status: "Ready",
    version: 7,
    reviewPackage: {
      run: { id: "run-42", stage: "PendingApproval", workStatus: "Ready", version: 7 },
      revision: {
        id: "revision-3",
        revision: 3,
        contentHash: "content-hash-3",
        content: {
          topicId: "chủ-đề-trợ-lý-AI",
          facebookPost: "Bản nháp đã kiểm chứng cho cộng đồng AI Việt Nam.",
          guide: [{
            heading: "Bước một — cài đặt",
            body: "Hướng dẫn chi tiết bằng tiếng Việt.",
            imageSuggestions: [{ description: "Ảnh minh họa giao diện" }],
          }],
          videoScript: { intro: "Mở đầu", body: "Nội dung chính", conclusion: "Kết luận" },
          originLinks: ["https://example.test/nguon-goc"],
          language: "vi",
        },
      },
      verification: {
        id: "report-3",
        draftRevisionId: "revision-3",
        contentHash: "content-hash-3",
        passed: false,
        findings: [
          { claimId: "claim-1", verdict: "Pass", description: "Khớp với nguồn gốc đã lưu trữ" },
          { claimId: "claim-2", verdict: "Contradiction", description: HOSTILE_FINDING_DESCRIPTION },
        ],
      },
      artifacts: [
        {
          id: "artifact-page",
          draftRevisionId: "revision-3",
          platform: "Facebook_Page",
          rendererVersion: "renderer-v2",
          body: "BYTES CHÍNH XÁC CHO FACEBOOK",
          metadata: {},
          attribution: "Nguồn: https://example.test/nguon-goc",
          artifactHash: "artifact-hash-page",
        },
        {
          id: "artifact-youtube",
          draftRevisionId: "revision-3",
          platform: "YouTube",
          rendererVersion: "renderer-v2",
          body: "BYTES CHÍNH XÁC CHO YOUTUBE",
          metadata: { title: "Trợ lý AI" },
          attribution: "Nguồn: https://example.test/nguon-goc",
          artifactHash: "artifact-hash-youtube",
        },
      ],
      compliance: [
        {
          id: "compliance-page",
          artifactId: "artifact-page",
          artifactHash: "artifact-hash-page",
          platform: "Facebook_Page",
          passed: true,
          violatedRuleIds: [],
          attributionOk: true,
          copyrightOk: true,
          reasons: [],
        },
        {
          id: "compliance-youtube",
          artifactId: "artifact-youtube",
          artifactHash: "artifact-hash-youtube",
          platform: "YouTube",
          passed: false,
          violatedRuleIds: ["yt-attribution-1"],
          attributionOk: false,
          copyrightOk: true,
          reasons: [HOSTILE_COMPLIANCE_REASON],
        },
      ],
    },
  };
}

const approval: ApprovalDto = {
  id: "approval-1",
  draftRevisionId: "revision-3",
  contentHash: "content-hash-3",
  approvedArtifactIds: ["artifact-page"],
  approvedArtifactHashes: ["artifact-hash-page"],
};

function makeClient(
  review: PendingReviewDto,
  overrides: Partial<ReviewDashboardClient> = {},
): ReviewDashboardClient & { readonly editDraft: ReturnType<typeof vi.fn> } {
  const base = {
    listPending: vi.fn(async () => [review] as readonly PendingReviewDto[]),
    editDraft: vi.fn(async (_id: string, _expectedVersion: number, content: ContentDraftDto) => ({
      ...review.reviewPackage.revision,
      id: "revision-4",
      revision: 4,
      contentHash: "content-hash-4",
      content,
    })),
    approve: vi.fn(async () => approval),
    reject: vi.fn(async () => undefined),
    exportArtifact: vi.fn(async () => { throw new Error("export is not exercised by this suite"); }),
  };
  return { ...base, ...overrides } as ReviewDashboardClient & { readonly editDraft: ReturnType<typeof vi.fn> };
}

describe("Review dashboard rendering of a PendingApproval package (Req 8.1)", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the pending draft with its verification report and per-platform compliance results", async () => {
    const review = pendingReview();
    let signal: AbortSignal | undefined;
    const deadlineSpy = vi.spyOn(window, "setTimeout");
    const api = makeClient(review, {
      listPending: vi.fn(async (abort?: AbortSignal) => {
        signal = abort;
        return [review] as readonly PendingReviewDto[];
      }),
    });

    render(<App client={api} />);

    // The queue and the review package appear; loading is bounded by the 5s requirement,
    // asserted through the component's own deadline rather than by waiting.
    const queue = await screen.findByLabelText("Pending approval drafts");
    expect(within(queue).getByText("Revision 3")).toBeTruthy();
    expect(within(queue).getByText("chủ-đề-trợ-lý-AI")).toBeTruthy();
    expect(screen.getByText("1 pending")).toBeTruthy();
    expect(deadlineSpy.mock.calls.some((call) => call[1] === REVIEW_LOAD_DEADLINE_MS)).toBe(true);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);

    const evidence = screen.getByLabelText("Verification and compliance");
    // Verification report: every checked claim with its verdict.
    expect(within(evidence).getByText("Verification")).toBeTruthy();
    expect(within(evidence).getByText(/2 claims/)).toBeTruthy();
    expect(within(evidence).getByText("Pass")).toBeTruthy();
    expect(within(evidence).getByText("Contradiction")).toBeTruthy();
    expect(within(evidence).getByText("Khớp với nguồn gốc đã lưu trữ")).toBeTruthy();

    // Compliance results are shown per platform, with the failing platform blocked.
    expect(within(evidence).getByText("Facebook Page")).toBeTruthy();
    expect(within(evidence).getByText("YouTube")).toBeTruthy();
    expect(within(evidence).getByText("Passed")).toBeTruthy();
    expect(within(evidence).getByText("Blocked")).toBeTruthy();
    expect(evidence.textContent).toContain("yt-attribution-1");
    expect(evidence.textContent).toContain("Thiếu ghi công bắt buộc");
    expect(evidence.className).not.toContain("superseded");
  });

  it("reports a bounded failure when the queue does not load within 5 seconds", async () => {
    const review = pendingReview();
    const deadlineSpy = vi.spyOn(window, "setTimeout");
    const api = makeClient(review, {
      listPending: vi.fn((abort?: AbortSignal) => new Promise<readonly PendingReviewDto[]>((_resolve, reject) => {
        abort?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })),
    });

    render(<App client={api} />);
    expect(screen.getByText("Loading exact review packages…")).toBeTruthy();

    const deadline = deadlineSpy.mock.calls.find((call) => call[1] === REVIEW_LOAD_DEADLINE_MS);
    expect(deadline).toBeDefined();
    await act(async () => { (deadline![0] as () => void)(); });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The review queue did not load within 5 seconds. Try again.");
  });

  it("labels the prior report as superseded and withholds it as evidence for the new revision", async () => {
    const review = pendingReview();
    const api = makeClient(review);
    render(<App client={api} />);

    const post = await screen.findByLabelText("Facebook post");
    fireEvent.change(post, { target: { value: "Bản nháp đã sửa nên phải kiểm chứng lại." } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new revision" }));

    await waitFor(() => expect(api.editDraft).toHaveBeenCalledWith(
      "run-42", 7, expect.objectContaining({ facebookPost: "Bản nháp đã sửa nên phải kiểm chứng lại." }),
    ));

    // Revision N+1 is now active.
    expect(await screen.findByText("Revision 4")).toBeTruthy();
    expect(screen.getByText("content-hash-4")).toBeTruthy();

    // The report from revision 3 is explicitly labelled superseded and cannot authorize approval.
    const evidence = screen.getByLabelText("Verification and compliance");
    expect(evidence.className).toContain("superseded");
    expect(within(evidence).getByText("Superseded — re-verification required")).toBeTruthy();
    expect(screen.getByText(/superseded revision and cannot authorize approval/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve selected artifacts" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /I confirm approval/ })).toBeNull();
    expect(screen.getByText("Export is locked until explicit approval succeeds.")).toBeTruthy();
  });

  it("encodes source-derived report and compliance text instead of injecting live elements", async () => {
    const review = pendingReview();
    const { container } = render(<App client={makeClient(review)} />);

    const evidence = await screen.findByLabelText("Verification and compliance");
    expect(evidence.textContent).toContain(HOSTILE_FINDING_DESCRIPTION);
    expect(evidence.textContent).toContain(HOSTILE_COMPLIANCE_REASON);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.innerHTML).toContain("&lt;script&gt;");
  });
});
