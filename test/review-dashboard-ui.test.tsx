// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/dashboard/web/App.js";
import type {
  ApprovalDto,
  ExportBundleDto,
  PendingReviewDto,
  ReviewDashboardClient,
} from "../src/dashboard/web/api-client.js";

const review: PendingReviewDto = {
  pipelineRunId: "run-1",
  stage: "PendingApproval",
  status: "Ready",
  version: 7,
  reviewPackage: {
    run: { id: "run-1", stage: "PendingApproval", workStatus: "Ready", version: 7 },
    revision: {
      id: "revision-3",
      revision: 3,
      contentHash: "content-hash-3",
      content: {
        topicId: "topic-ai",
        facebookPost: "Nội dung Facebook đã được kiểm chứng.",
        guide: [{
          heading: "Bước một",
          body: "Nội dung hướng dẫn",
          imageSuggestions: [{ description: "Minh họa chi tiết" }],
        }],
        videoScript: { intro: "Mở đầu", body: "Nội dung", conclusion: "Kết luận" },
        originLinks: ["https://example.test/source"],
        language: "vi",
      },
    },
    verification: {
      id: "report-3",
      draftRevisionId: "revision-3",
      contentHash: "content-hash-3",
      passed: true,
      findings: [{ claimId: "claim-1", verdict: "Pass", description: "Matches source evidence" }],
    },
    artifacts: [{
      id: "artifact-page",
      draftRevisionId: "revision-3",
      platform: "Facebook_Page",
      rendererVersion: "renderer-v2",
      body: "EXACT APPROVED BYTES",
      metadata: {},
      attribution: "Nguồn: https://example.test/source",
      artifactHash: "artifact-hash-page",
    }],
    compliance: [{
      id: "compliance-page",
      artifactId: "artifact-page",
      artifactHash: "artifact-hash-page",
      platform: "Facebook_Page",
      passed: true,
      violatedRuleIds: [],
      attributionOk: true,
      copyrightOk: true,
      reasons: [],
    }],
  },
};

const approval: ApprovalDto = {
  id: "approval-1",
  draftRevisionId: "revision-3",
  contentHash: "content-hash-3",
  approvedArtifactIds: ["artifact-page"],
  approvedArtifactHashes: ["artifact-hash-page"],
};
const bundle: ExportBundleDto = {
  id: "bundle-1",
  platform: "Facebook_Page",
  targetId: "page-main",
  approvalId: approval.id,
  artifactId: "artifact-page",
  artifactHash: "artifact-hash-page",
  rendererVersion: "renderer-v2",
  body: "EXACT APPROVED BYTES",
  metadata: {},
  attribution: "Nguồn: https://example.test/source",
  imageSuggestions: [],
  createdAt: "2025-08-01T00:00:00.000Z",
};

function client(): ReviewDashboardClient & {
  editDraft: ReturnType<typeof vi.fn>;
  approve: ReturnType<typeof vi.fn>;
  exportArtifact: ReturnType<typeof vi.fn>;
} {
  return {
    listPending: vi.fn(async () => [review]),
    editDraft: vi.fn(async (_id, _version, content) => ({
      ...review.reviewPackage.revision,
      id: "revision-4",
      revision: 4,
      contentHash: "content-hash-4",
      content,
    })),
    approve: vi.fn(async () => approval),
    reject: vi.fn(async () => undefined),
    exportArtifact: vi.fn(async () => bundle),
  } as ReviewDashboardClient & {
    editDraft: ReturnType<typeof vi.fn>;
    approve: ReturnType<typeof vi.fn>;
    exportArtifact: ReturnType<typeof vi.fn>;
  };
}

describe("Review dashboard UI", () => {
  afterEach(cleanup);

  it("renders a pending revision with exact verification and per-platform compliance", async () => {
    render(<App client={client()} />);

    expect(await screen.findByText("Verification & compliance")).toBeTruthy();
    expect(screen.getByText("Matches source evidence")).toBeTruthy();
    expect(screen.getAllByText("Facebook Page").length).toBeGreaterThan(0);
    expect(screen.getByText("Export is locked until explicit approval succeeds.")).toBeTruthy();
    expect(screen.queryByText("copy-ready bundle")).toBeNull();
  });

  it("requires exact selection and confirmation before exposing immutable export", async () => {
    const api = client();
    render(<App client={api} />);
    await screen.findByText("Review decision");

    const approveButton = screen.getByRole("button", { name: "Approve selected artifacts" });
    expect((approveButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Facebook Page/ }));
    expect((approveButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /I confirm approval/ }));
    fireEvent.click(approveButton);

    await screen.findByText("Approved artifacts");
    expect(api.approve).toHaveBeenCalledWith("run-1", {
      expectedVersion: 7,
      confirmed: true,
      draftRevisionId: "revision-3",
      contentHash: "content-hash-3",
      verificationReportId: "report-3",
      complianceResultIds: ["compliance-page"],
      artifactIds: ["artifact-page"],
      artifactHashes: ["artifact-hash-page"],
    });

    fireEvent.change(screen.getByLabelText("Target for Facebook_Page"), { target: { value: "page-main" } });
    fireEvent.click(screen.getByRole("button", { name: "Create copy-ready export" }));
    expect(await screen.findByText("EXACT APPROVED BYTES")).toBeTruthy();
    expect(api.exportArtifact).toHaveBeenCalledWith(
      "run-1", approval, review.reviewPackage.artifacts[0], "page-main",
    );
  });

  it("labels old evidence as superseded after an immutable edit and removes approval controls", async () => {
    const api = client();
    render(<App client={api} />);
    const editor = await screen.findByLabelText("Facebook post");
    fireEvent.change(editor, { target: { value: "Nội dung đã sửa và phải kiểm chứng lại." } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new revision" }));

    expect(await screen.findByText("Superseded — re-verification required")).toBeTruthy();
    expect(screen.getByText(/new immutable revision/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve selected artifacts" })).toBeNull();
    await waitFor(() => expect(api.editDraft).toHaveBeenCalledWith(
      "run-1", 7, expect.objectContaining({ facebookPost: "Nội dung đã sửa và phải kiểm chứng lại." }),
    ));
  });
});
