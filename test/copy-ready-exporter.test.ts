import { describe, expect, it } from "vitest";
import type { PlatformArtifact, Topic } from "../src/domain/content.js";
import type {
  ApprovalRecord,
  DeliveryCommand,
  PipelineRun,
  WorkflowStage,
} from "../src/domain/workflow.js";
import { createPhase1OutputPort } from "../src/output/index.js";
import { CopyReadyExporter } from "../src/output/copy-ready-exporter.js";
import { SqliteRepository } from "../src/persistence/sqlite-repository.js";

const CREATED = "2025-05-01T10:00:00.000Z";
const EXPORTED = "2025-05-01T11:00:00.000Z";

const topic: Topic = {
  id: "topic-output",
  sourceRef: {
    sourceId: "source-output",
    captureId: "capture-output",
    url: "https://origin.example/ai-update",
    capturedAt: CREATED,
    termsVersion: "terms-v1",
  },
  externalId: "external-output",
  title: "AI update",
  createdAt: CREATED,
  score: { total: 90, breakdown: [], scoringConfigVersion: "score-v1" },
  categories: ["AI Tools"],
};

const imageSuggestions = [
  { description: "Minh họa quy trình AI theo từng bước" },
];

const artifacts: readonly PlatformArtifact[] = [
  {
    id: "artifact-page",
    draftRevisionId: "revision-output",
    platform: "Facebook_Page",
    rendererVersion: "renderer-v2",
    body: "Bài Facebook Page đã render — giữ nguyên từng byte.",
    metadata: {},
    attribution: "Nguồn: https://origin.example/ai-update",
    imageSuggestions,
    artifactHash: "hash-page",
    createdAt: CREATED,
  },
  {
    id: "artifact-group",
    draftRevisionId: "revision-output",
    platform: "Facebook_Group",
    rendererVersion: "renderer-v2",
    body: "Bài Facebook Group đã render — giữ nguyên từng byte.",
    metadata: { audience: "community" },
    attribution: "Nguồn: https://origin.example/ai-update",
    imageSuggestions,
    artifactHash: "hash-group",
    createdAt: CREATED,
  },
  {
    id: "artifact-youtube",
    draftRevisionId: "revision-output",
    platform: "YouTube",
    rendererVersion: "renderer-v2",
    body: "Mở đầu\n\nNội dung chính\n\nKết luận",
    metadata: {
      title: "Cập nhật AI mới",
      description: "Video tóm tắt cập nhật AI có nguồn.",
      tags: "AI,công cụ AI,cập nhật",
    },
    attribution: "Nguồn: https://origin.example/ai-update",
    imageSuggestions,
    artifactHash: "hash-youtube",
    createdAt: CREATED,
  },
];

const approval: ApprovalRecord = {
  id: "approval-output",
  pipelineRunId: "run-output",
  draftRevisionId: "revision-output",
  contentHash: "content-hash-output",
  approvedArtifactIds: artifacts.map((artifact) => artifact.id),
  approvedArtifactHashes: artifacts.map((artifact) => artifact.artifactHash),
  operatorId: "operator-output",
  approvedAt: CREATED,
};

function initialRun(): PipelineRun {
  return {
    id: approval.pipelineRunId,
    topicId: topic.id,
    stage: "Collected",
    workStatus: "Ready",
    version: 0,
    categories: ["AI Tools"],
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

async function setup(stage: WorkflowStage): Promise<SqliteRepository> {
  const repository = new SqliteRepository(":memory:", { now: () => CREATED });
  await repository.createPipelineRun({
    run: initialRun(),
    topic,
    idempotencyKey: "create-output-run",
  });
  await repository.commitGuardedTransition({
    pipelineRunId: approval.pipelineRunId,
    expectedVersion: 0,
    expectedStage: "Collected",
    expectedStatus: "Ready",
    nextStage: stage,
    nextStatus: "Ready",
    nextActiveDraftRevisionId: approval.draftRevisionId,
    actorType: "Operator",
    actorId: approval.operatorId,
    artifactRevisionId: approval.draftRevisionId,
    records: {
      draftRevisions: [
        {
          id: approval.draftRevisionId,
          draftId: "draft-output",
          revision: 1,
          content: {
            topicId: topic.id,
            facebookPost: "Nội dung nguồn đã dùng để render artifact.".repeat(2),
            guide: [],
            videoScript: {
              intro: "Mở đầu",
              body: "Nội dung chính",
              conclusion: "Kết luận",
            },
            originLinks: [topic.sourceRef.url],
            language: "vi",
          },
          contentHash: approval.contentHash,
          createdBy: "System",
          createdAt: CREATED,
        },
      ],
      platformArtifacts: artifacts,
      approvals: [approval],
    },
    idempotencyKey: `prepare-${stage}`,
  });
  return repository;
}

function commandFor(
  artifact: PlatformArtifact,
  idempotencyKey = `export-${artifact.platform}`,
): DeliveryCommand {
  return {
    approvalId: approval.id,
    artifactId: artifact.id,
    artifactHash: artifact.artifactHash,
    targetId: `target-${artifact.platform}`,
    idempotencyKey,
  };
}

describe("CopyReadyExporter", () => {
  it("persists exact attributed copy-ready bundles for every Phase 1 platform", async () => {
    const repository = await setup("Approved");
    const output = createPhase1OutputPort(repository, { now: () => EXPORTED });
    const exporter = new CopyReadyExporter(repository, { now: () => EXPORTED });
    try {
      for (const [index, artifact] of artifacts.entries()) {
        const command = commandFor(artifact, `platform-export-${index}`);
        const outcome = await output.deliver(command);
        expect(outcome).toEqual({
          status: "Exported",
          exportedBundleId: expect.stringMatching(/^export-[a-f0-9]{64}$/),
        });

        const bundle = await exporter.getExportBundle(outcome.exportedBundleId!);
        expect(bundle).toEqual({
          id: outcome.exportedBundleId,
          platform: artifact.platform,
          targetId: command.targetId,
          approvalId: approval.id,
          artifactId: artifact.id,
          artifactHash: artifact.artifactHash,
          rendererVersion: artifact.rendererVersion,
          body: artifact.body,
          metadata: artifact.metadata,
          attribution: artifact.attribution,
          imageSuggestions: artifact.imageSuggestions,
          createdAt: EXPORTED,
        });
        expect(await repository.getDelivery(outcome.exportedBundleId!)).toMatchObject({
          kind: "Export",
          status: "Exported",
          attempts: 1,
          exportBundle: bundle,
        });
        await expect(output.deliver(command)).resolves.toEqual(outcome);
      }
    } finally {
      repository.close();
    }
  });

  it("blocks export unless the approval's pipeline run is Approved", async () => {
    const repository = await setup("PendingApproval");
    const exporter = new CopyReadyExporter(repository, { now: () => EXPORTED });
    const command = commandFor(artifacts[0]!);
    try {
      await expect(exporter.deliver(command)).resolves.toEqual({
        status: "Failed",
        errorCode: "CONTENT_NOT_APPROVED",
        errorMessage: "Content is not approved for output or delivery",
      });
      expect(
        await repository.getDeliveryByIdempotencyKey(command.idempotencyKey),
      ).toBeUndefined();
    } finally {
      repository.close();
    }
  });

  it("rejects hash mismatches and conflicting idempotency bindings", async () => {
    const repository = await setup("Approved");
    const exporter = new CopyReadyExporter(repository, { now: () => EXPORTED });
    try {
      await expect(
        exporter.deliver({
          ...commandFor(artifacts[0]!),
          artifactHash: "stale-or-mutated-hash",
        }),
      ).resolves.toMatchObject({
        status: "Failed",
        errorCode: "APPROVAL_ARTIFACT_MISMATCH",
      });

      const sharedKey = "one-logical-export";
      await expect(
        exporter.deliver(commandFor(artifacts[0]!, sharedKey)),
      ).resolves.toMatchObject({ status: "Exported" });
      await expect(
        exporter.deliver(commandFor(artifacts[1]!, sharedKey)),
      ).resolves.toEqual({
        status: "Failed",
        errorCode: "IDEMPOTENCY_CONFLICT",
        errorMessage: "Idempotency key is already bound to another delivery",
      });
    } finally {
      repository.close();
    }
  });
});
