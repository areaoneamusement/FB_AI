import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type {
  ComplianceResult,
  DraftRevision,
  PlatformArtifact,
  ResearchResult,
  Topic,
  VerificationReport,
} from "../src/domain/content.js";
import type {
  ApprovalRecord,
  DeliveryRecord,
  PipelineRun,
} from "../src/domain/workflow.js";
import type { GuardedTransitionCommand } from "../src/adapters/ports.js";
import { SqliteRepository } from "../src/persistence/sqlite-repository.js";

const CREATED = "2025-03-01T10:00:00.000Z";
const UPDATED = "2025-03-01T10:01:00.000Z";

function topic(id = "topic-1", externalId = "external-1"): Topic {
  return {
    id,
    sourceRef: {
      sourceId: "nguồn-1",
      captureId: "capture-1",
      url: "https://example.com/nguồn",
      capturedAt: CREATED,
      termsVersion: "điều-khoản-v1",
    },
    externalId,
    title: "Công cụ AI — dữ liệu chính xác",
    createdAt: CREATED,
    score: {
      total: 87.5,
      breakdown: [
        { criterionId: "độ-mới", componentValue: 75, weightPercent: 50 },
        { criterionId: "liên-quan", componentValue: 100, weightPercent: 50 },
      ],
      scoringConfigVersion: "score-v1",
    },
    categories: ["AI Tools", "Tin tức"],
  };
}

function run(topicId = "topic-1", id = "run-1"): PipelineRun {
  return {
    id,
    topicId,
    stage: "Collected",
    workStatus: "Ready",
    version: 0,
    categories: ["AI Tools", "Tin tức"],
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

const research: ResearchResult = {
  id: "research-1",
  topicId: "topic-1",
  items: [
    {
      id: "item-1",
      content: "Nội dung có dấu và ký tự 🌱",
      kind: "Quoted",
      evidenceRefs: [topic().sourceRef],
    },
  ],
  status: "Ok",
  unreachableSources: [],
  skippedSources: [],
};

const revision: DraftRevision = {
  id: "revision-1",
  draftId: "draft-1",
  revision: 1,
  content: {
    topicId: "topic-1",
    facebookPost: "Bài viết thử nghiệm với dữ liệu JSON".repeat(2),
    guide: [
      {
        heading: "Hướng dẫn",
        body: "Nội dung",
        imageSuggestions: [{ description: "Ảnh minh họa chi tiết" }],
      },
    ],
    videoScript: { intro: "Mở đầu", body: "Nội dung", conclusion: "Kết" },
    originLinks: ["https://example.com/nguồn"],
    language: "vi",
    brandVoiceVersion: "brand-v1",
  },
  contentHash: "content-hash-1",
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
  findings: [
    {
      claimId: "claim-1",
      verdict: "Pass",
      evidenceRefs: [topic().sourceRef],
      confidence: 0.99,
    },
  ],
  passed: true,
};

const artifact: PlatformArtifact = {
  id: "artifact-1",
  draftRevisionId: revision.id,
  platform: "Facebook_Page",
  rendererVersion: "renderer-v1",
  body: "Nội dung được duyệt",
  metadata: { tiêu_đề: "Dữ liệu", nested_as_text: "{\"safe\":true}" },
  attribution: "Nguồn: example.com",
  imageSuggestions: [{ description: "Ảnh minh họa" }],
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
  sourceTermsVersions: ["điều-khoản-v1"],
  evaluatorVersion: "evaluator-v1",
  passed: true,
  violatedRuleIds: [],
  attributionOk: true,
  copyrightOk: true,
  reasons: ["Đạt toàn bộ quy tắc"],
  checkedAt: CREATED,
};

const approval: ApprovalRecord = {
  id: "approval-1",
  pipelineRunId: "run-1",
  draftRevisionId: revision.id,
  contentHash: revision.contentHash,
  approvedArtifactIds: [artifact.id],
  approvedArtifactHashes: [artifact.artifactHash],
  operatorId: "operator-1",
  approvedAt: UPDATED,
};

const delivery: DeliveryRecord = {
  id: "delivery-1",
  kind: "Export",
  platform: artifact.platform,
  targetId: "page-1",
  approvalId: approval.id,
  artifactId: artifact.id,
  artifactHash: artifact.artifactHash,
  idempotencyKey: "delivery-key-1",
  status: "Exported",
  attempts: 1,
  externalUrl: "https://example.com/export/1",
  createdAt: UPDATED,
  updatedAt: UPDATED,
};

function firstTransition(): GuardedTransitionCommand {
  return {
    pipelineRunId: "run-1",
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
  };
}

function approvalTransition(): GuardedTransitionCommand {
  return {
    pipelineRunId: "run-1",
    expectedVersion: 1,
    expectedStage: "PendingApproval",
    expectedStatus: "Ready",
    nextStage: "Approved",
    nextStatus: "Ready",
    nextActiveDraftRevisionId: revision.id,
    actorType: "Operator",
    actorId: "operator-1",
    artifactRevisionId: revision.id,
    records: { approvals: [approval], deliveries: [delivery] },
    idempotencyKey: "approve-and-export",
  };
}

describe("SqliteRepository", () => {
  it("atomically persists and exactly reloads workflow evidence JSON", async () => {
    const database = new Database(":memory:");
    const repository = new SqliteRepository(database, { now: () => UPDATED });
    try {
      const created = await repository.createPipelineRun({
        run: run(),
        topic: topic(),
        idempotencyKey: "create-run",
      });
      const replayedCreate = await repository.createPipelineRun({
        run: run(),
        topic: topic(),
        idempotencyKey: "create-run",
      });
      expect(created).toEqual(run());
      expect(replayedCreate).toEqual(run());

      const prepared = await repository.commitGuardedTransition(firstTransition());
      expect(prepared).toMatchObject({
        kind: "Applied",
        run: { stage: "PendingApproval", version: 1 },
      });
      expect(await repository.getTopic(topic().id)).toEqual(topic());
      expect(await repository.getResearchResult(research.id)).toEqual(research);
      expect(await repository.getDraftRevision(revision.id)).toEqual(revision);
      expect(await repository.getVerificationReport(report.id)).toEqual(report);
      expect(await repository.getPlatformArtifact(artifact.id)).toEqual(artifact);
      expect(await repository.getComplianceResult(compliance.id)).toEqual(compliance);
      expect(await repository.listPipelineRuns()).toEqual([
        expect.objectContaining({ id: "run-1", stage: "PendingApproval" }),
      ]);
      expect(await repository.listVerificationReportsByDraftRevision(revision.id)).toEqual([report]);
      expect(await repository.listPlatformArtifactsByDraftRevision(revision.id)).toEqual([artifact]);
      expect(await repository.listComplianceResultsByDraftRevision(revision.id)).toEqual([compliance]);

      const approved = await repository.commitGuardedTransition(approvalTransition());
      expect(approved).toMatchObject({
        kind: "Applied",
        run: { stage: "Approved", version: 2 },
      });
      expect(await repository.getApproval(approval.id)).toEqual(approval);
      expect(await repository.listApprovalsByPipelineRun("run-1")).toEqual([approval]);
      expect(await repository.getDelivery(delivery.id)).toEqual(delivery);
      expect(await repository.getDeliveryByIdempotencyKey(delivery.idempotencyKey)).toEqual(delivery);
      expect(await repository.listDeliveriesByApproval(approval.id)).toEqual([delivery]);
      await expect(
        repository.recordDelivery({
          ...delivery,
          id: "another-delivery-id",
          status: "Failed",
          attempts: 2,
        }),
      ).resolves.toEqual({ record: delivery, replayed: true });

      const replay = await repository.commitGuardedTransition(approvalTransition());
      expect(replay).toEqual({
        ...(approved as Exclude<typeof approved, { kind: "Conflict" }>),
        kind: "Replayed",
      });
      expect(await repository.listTransitions("run-1")).toHaveLength(2);
    } finally {
      repository.close();
    }
  });

  it("rolls back failed record writes and returns conflicts for stale guards", async () => {
    const database = new Database(":memory:");
    const repository = new SqliteRepository(database, { now: () => UPDATED });
    try {
      await repository.createPipelineRun({
        run: run(),
        topic: topic(),
        idempotencyKey: "create-run",
      });
      const invalidResearch: ResearchResult = {
        ...research,
        id: "orphan-research",
        topicId: "missing-topic",
      };
      await expect(
        repository.commitGuardedTransition({
          ...firstTransition(),
          records: { researchResults: [invalidResearch] },
          idempotencyKey: "invalid-write",
        }),
      ).rejects.toThrow();
      expect(await repository.getResearchResult(invalidResearch.id)).toBeUndefined();
      expect(await repository.getPipelineRun("run-1")).toEqual(run());
      expect(await repository.listTransitions("run-1")).toEqual([]);

      const stale = await repository.commitGuardedTransition({
        ...firstTransition(),
        expectedVersion: 99,
        records: { researchResults: [research] },
        idempotencyKey: "stale-write",
      });
      expect(stale).toEqual({ kind: "Conflict", current: run() });
      expect(await repository.getResearchResult(research.id)).toBeUndefined();
    } finally {
      repository.close();
    }
  });

  it("preserves rejected evidence and enforces append-only records", async () => {
    const database = new Database(":memory:");
    const repository = new SqliteRepository(database, { now: () => UPDATED });
    try {
      await repository.createPipelineRun({
        run: run(),
        topic: topic(),
        idempotencyKey: "create-run",
      });
      await repository.commitGuardedTransition(firstTransition());
      const rejected = await repository.commitGuardedTransition({
        pipelineRunId: "run-1",
        expectedVersion: 1,
        expectedStage: "PendingApproval",
        expectedStatus: "Ready",
        nextStage: "Rejected",
        nextStatus: "Rejected",
        blockedReason: "[PendingApproval] Operator rejected the content",
        actorType: "Operator",
        actorId: "operator-1",
        reason: "Operator rejected the content",
        artifactRevisionId: revision.id,
        records: {},
        idempotencyKey: "reject-run",
      });
      expect(rejected).toMatchObject({
        kind: "Applied",
        run: {
          stage: "Rejected",
          workStatus: "Rejected",
          activeDraftRevisionId: revision.id,
          blockedReason: "[PendingApproval] Operator rejected the content",
        },
      });
      expect(await repository.getDraftRevision(revision.id)).toEqual(revision);
      expect(await repository.getVerificationReport(report.id)).toEqual(report);
      expect(() =>
        database.prepare("UPDATE draft_revisions SET content_hash = 'changed' WHERE id = ?").run(revision.id),
      ).toThrow("draft revisions are immutable");
      expect(() =>
        database.prepare("DELETE FROM compliance_results WHERE id = ?").run(compliance.id),
      ).toThrow("compliance results are immutable");
    } finally {
      repository.close();
    }
  });

  it("enforces source uniqueness while allowing idempotency keys per run", async () => {
    const database = new Database(":memory:");
    const repository = new SqliteRepository(database, { now: () => UPDATED });
    try {
      await repository.createPipelineRun({
        run: run(),
        topic: topic(),
        idempotencyKey: "same-key",
      });
      await expect(
        repository.createPipelineRun({
          run: run("topic-duplicate", "run-duplicate"),
          topic: { ...topic("topic-duplicate"), externalId: topic().externalId },
          idempotencyKey: "different-key",
        }),
      ).rejects.toThrow();
      expect(await repository.getPipelineRun("run-duplicate")).toBeUndefined();

      const secondTopic = topic("topic-2", "external-2");
      const secondRun = run(secondTopic.id, "run-2");
      await repository.createPipelineRun({
        run: secondRun,
        topic: secondTopic,
        idempotencyKey: "same-key",
      });
      const commandFor = (pipelineRun: PipelineRun): GuardedTransitionCommand => ({
        pipelineRunId: pipelineRun.id,
        expectedVersion: 0,
        expectedStage: "Collected",
        expectedStatus: "Ready",
        nextStage: "Scored",
        nextStatus: "Ready",
        actorType: "System",
        records: {},
        idempotencyKey: "transition-shared-key",
      });
      await expect(repository.commitGuardedTransition(commandFor(run()))).resolves.toMatchObject({ kind: "Applied" });
      await expect(repository.commitGuardedTransition(commandFor(secondRun))).resolves.toMatchObject({ kind: "Applied" });
    } finally {
      repository.close();
    }
  });
});
