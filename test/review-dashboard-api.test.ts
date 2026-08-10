import { describe, expect, it, vi } from "vitest";
import { InMemoryRepository } from "../src/adapters/in-memory-repository.js";
import type { OutputPort } from "../src/adapters/ports.js";
import type {
  ComplianceResult,
  DraftRevision,
  PlatformArtifact,
  ResearchResult,
  Topic,
  VerificationReport,
} from "../src/domain/content.js";
import type { DeliveryCommand, PipelineRun } from "../src/domain/workflow.js";
import {
  DashboardApiError,
  ReviewDashboardApi,
  hashDraftContent,
} from "../src/dashboard/review-dashboard-api.js";
import { ContentPipeline } from "../src/pipeline/content-pipeline.js";

const CREATED = "2025-07-01T10:00:00.000Z";
const UPDATED = "2025-07-01T10:05:00.000Z";
const operator = { id: "operator-1", role: "Operator" as const };

const topic: Topic = {
  id: "topic-1",
  sourceRef: {
    sourceId: "source-1",
    captureId: "capture-1",
    url: "https://example.test/source",
    capturedAt: CREATED,
    termsVersion: "terms-v1",
  },
  externalId: "external-1",
  title: "AI update",
  createdAt: CREATED,
  score: { total: 90, breakdown: [], scoringConfigVersion: "score-v1" },
  categories: ["AI Tools"],
};
const research: ResearchResult = {
  id: "research-1",
  topicId: topic.id,
  items: [],
  status: "Ok",
  unreachableSources: [],
  skippedSources: [],
};

const content = {
  topicId: topic.id,
  facebookPost: "A".repeat(50),
  guide: [{
    heading: "Guide",
    body: "Body",
    imageSuggestions: [{ description: "Detailed image suggestion" }],
  }],
  videoScript: { intro: "Intro", body: "Body", conclusion: "Conclusion" },
  originLinks: [topic.sourceRef.url],
  language: "vi",
};

const revision: DraftRevision = {
  id: "revision-1",
  draftId: "draft-1",
  revision: 1,
  content,
  contentHash: hashDraftContent(content),
  createdBy: "System",
  createdAt: CREATED,
};

const report: VerificationReport = {
  id: "report-1",
  draftRevisionId: revision.id,
  contentHash: revision.contentHash,
  researchResultId: research.id,
  round: 1,
  modelB: {
    provider: "provider-b",
    model: "model-b",
    promptVersion: "prompt-v1",
    configurationVersion: "config-v1",
  },
  findings: [],
  passed: true,
};

const artifact: PlatformArtifact = {
  id: "artifact-1",
  draftRevisionId: revision.id,
  platform: "Facebook_Page",
  rendererVersion: "renderer-v1",
  body: "immutable approved bytes",
  metadata: {},
  attribution: topic.sourceRef.url,
  imageSuggestions: [],
  artifactHash: "artifact-hash-1",
  createdAt: CREATED,
};

const compliance: ComplianceResult = {
  id: "compliance-1",
  artifactId: artifact.id,
  artifactHash: artifact.artifactHash,
  draftRevisionId: revision.id,
  platform: artifact.platform,
  ruleSetVersion: "rules-v1",
  sourceTermsVersions: ["terms-v1"],
  evaluatorVersion: "evaluator-v1",
  passed: true,
  violatedRuleIds: [],
  attributionOk: true,
  copyrightOk: true,
  reasons: [],
  checkedAt: CREATED,
};
class RecordingOutput implements OutputPort {
  readonly deliver = vi.fn(async (_command: DeliveryCommand) => ({
    status: "Exported" as const,
    exportedBundleId: "bundle-1",
  }));
}

async function setup(): Promise<{
  repository: InMemoryRepository;
  output: RecordingOutput;
  api: ReviewDashboardApi;
}> {
  const repository = new InMemoryRepository({ now: () => UPDATED });
  const run: PipelineRun = {
    id: "run-1",
    topicId: topic.id,
    stage: "Collected",
    workStatus: "Ready",
    version: 0,
    categories: topic.categories,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
  await repository.createPipelineRun({ run, topic, idempotencyKey: "create-run" });
  await repository.commitGuardedTransition({
    pipelineRunId: run.id,
    expectedVersion: 0,
    expectedStage: "Collected",
    expectedStatus: "Ready",
    nextStage: "PendingApproval",
    nextStatus: "Ready",
    nextActiveDraftRevisionId: revision.id,
    actorType: "System",
    artifactRevisionId: revision.id,
    records: {
      researchResults: [research],
      draftRevisions: [revision],
      verificationReports: [report],
      platformArtifacts: [artifact],
      complianceResults: [compliance],
    },
    idempotencyKey: "prepare-review",
  });
  const pipeline = new ContentPipeline(repository, ["AI Tools"], {
    now: () => UPDATED,
  });
  const output = new RecordingOutput();
  return {
    repository,
    output,
    api: new ReviewDashboardApi(repository, pipeline, output, { now: () => UPDATED }),
  };
}

describe("ReviewDashboardApi", () => {
  it("loads pending packages and saves edits as immutable revisions requiring re-verification", async () => {
    const { api, repository } = await setup();

    await expect(api.listPending()).resolves.toEqual([{
      pipelineRunId: "run-1",
      stage: "PendingApproval",
      status: "Ready",
      version: 1,
    }]);
    await expect(api.getDraft("run-1")).resolves.toMatchObject({
      revision: { id: revision.id },
      verification: { id: report.id },
      artifacts: [{ id: artifact.id }],
      compliance: [{ id: compliance.id }],
    });

    const editedContent = { ...content, facebookPost: "Nội dung đã chỉnh sửa" };
    const edited = await api.editDraft("run-1", {
      operator,
      expectedVersion: 1,
      idempotencyKey: "edit-1",
      patch: { content: editedContent },
    });

    expect(edited).toMatchObject({
      revision: 2,
      parentRevisionId: revision.id,
      createdBy: "Operator",
      actorId: operator.id,
      content: editedContent,
    });
    expect(edited.contentHash).toBe(hashDraftContent(editedContent));
    expect(await repository.getDraftRevision(revision.id)).toEqual(revision);
    expect(await repository.getDraftRevision(edited.id)).toEqual(edited);
    expect(await repository.getPipelineRun("run-1")).toMatchObject({
      stage: "Generated",
      version: 2,
      activeDraftRevisionId: edited.id,
    });
    await expect(api.listPending()).resolves.toEqual([]);
    await expect(api.getDraft("run-1")).resolves.toEqual({
      run: expect.objectContaining({
        stage: "Generated",
        activeDraftRevisionId: edited.id,
      }),
      revision: edited,
      artifacts: [],
      compliance: [],
    });
  });
  it("rejects oversized edits without changing the active revision", async () => {
    const { api, repository } = await setup();

    await expect(api.editDraft("run-1", {
      operator,
      expectedVersion: 1,
      idempotencyKey: "edit-too-long",
      patch: { content: { ...content, facebookPost: "x".repeat(5_001) } },
    })).rejects.toBeInstanceOf(DashboardApiError);
    expect(await repository.getPipelineRun("run-1")).toMatchObject({
      stage: "PendingApproval",
      version: 1,
      activeDraftRevisionId: revision.id,
    });
  });

  it("approves exact evidence and exports only the immutable approved artifact", async () => {
    const { api, output } = await setup();

    const approval = await api.approve("run-1", {
      operator,
      expectedVersion: 1,
      confirmed: true,
      draftRevisionId: revision.id,
      contentHash: revision.contentHash,
      verificationReportId: report.id,
      complianceResultIds: [compliance.id],
      artifactIds: [artifact.id],
      artifactHashes: [artifact.artifactHash],
      idempotencyKey: "approve-1",
    });
    await expect(api.getApprovedArtifact(
      "run-1",
      operator,
      approval.id,
      artifact.id,
      artifact.artifactHash,
    )).resolves.toEqual({ approval, artifact });

    await expect(api.deliverApprovedArtifact("run-1", {
      operator,
      approvalId: approval.id,
      artifactId: artifact.id,
      artifactHash: artifact.artifactHash,
      targetId: "page-1",
      idempotencyKey: "export-1",
    })).resolves.toEqual({ status: "Exported", exportedBundleId: "bundle-1" });
    expect(output.deliver).toHaveBeenCalledWith({
      approvalId: approval.id,
      artifactId: artifact.id,
      artifactHash: artifact.artifactHash,
      targetId: "page-1",
      idempotencyKey: "export-1",
    });
    await expect(api.getApprovedArtifact(
      "run-1",
      operator,
      approval.id,
      artifact.id,
      "stale-hash",
    )).rejects.toMatchObject({ code: "CONTENT_NOT_APPROVED" });
  });

  it("keeps invalid rejections unchanged and persists a valid 1000-character note", async () => {
    const { api, repository } = await setup();

    await expect(api.reject("run-1", {
      operator,
      expectedVersion: 1,
      note: " ",
      idempotencyKey: "reject-empty",
    })).rejects.toMatchObject({ code: "INVALID_REJECTION" });
    await expect(api.reject("run-1", {
      operator,
      expectedVersion: 1,
      note: "x".repeat(1_001),
      idempotencyKey: "reject-long",
    })).rejects.toMatchObject({ code: "INVALID_REJECTION" });
    expect(await repository.getPipelineRun("run-1")).toMatchObject({
      stage: "PendingApproval",
      version: 1,
    });

    const note = "x".repeat(1_000);
    await expect(api.reject("run-1", {
      operator,
      expectedVersion: 1,
      note,
      idempotencyKey: "reject-valid",
    })).resolves.toMatchObject({
      stage: "Rejected",
      workStatus: "Rejected",
      version: 2,
      blockedReason: `[PendingApproval] ${note}`,
    });
    expect((await repository.listTransitions("run-1"))[1]).toMatchObject({
      actorType: "Operator",
      actorId: operator.id,
      reason: note,
    });
  });
});
