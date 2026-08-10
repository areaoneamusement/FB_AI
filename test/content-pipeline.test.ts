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
  PipelineTransition,
} from "../src/domain/workflow.js";
import type {
  CreatePipelineRunCommand,
  GuardedTransitionCommand,
  GuardedTransitionOutcome,
  Repository,
} from "../src/adapters/ports.js";
import {
  ContentPipeline,
  PipelineCommandError,
} from "../src/pipeline/content-pipeline.js";

const NOW = "2025-01-01T00:10:00.000Z";
const START = "2025-01-01T00:05:00.000Z";

class MemoryRepository implements Repository {
  readonly topics = new Map<string, Topic>();
  readonly research = new Map<string, ResearchResult>();
  readonly revisions = new Map<string, DraftRevision>();
  readonly reports = new Map<string, VerificationReport>();
  readonly artifacts = new Map<string, PlatformArtifact>();
  readonly compliance = new Map<string, ComplianceResult>();
  readonly approvals = new Map<string, ApprovalRecord>();
  readonly runs = new Map<string, PipelineRun>();
  readonly transitions: PipelineTransition[] = [];
  readonly deliveries = new Map<string, DeliveryRecord>();
  readonly replay = new Map<string, GuardedTransitionOutcome>();

  async createPipelineRun(command: CreatePipelineRunCommand): Promise<PipelineRun> {
    this.topics.set(command.topic.id, command.topic);
    this.runs.set(command.run.id, command.run);
    return command.run;
  }
  async getTopic(id: string) { return this.topics.get(id); }
  async getResearchResult(id: string) { return this.research.get(id); }
  async getDraftRevision(id: string) { return this.revisions.get(id); }
  async getVerificationReport(id: string) { return this.reports.get(id); }
  async getPlatformArtifact(id: string) { return this.artifacts.get(id); }
  async getComplianceResult(id: string) { return this.compliance.get(id); }
  async getApproval(id: string) { return this.approvals.get(id); }
  async getPipelineRun(id: string) { return this.runs.get(id); }
  async listPipelineRuns() { return [...this.runs.values()]; }
  async listVerificationReportsByDraftRevision(draftRevisionId: string) {
    return [...this.reports.values()].filter((value) => value.draftRevisionId === draftRevisionId);
  }
  async listPlatformArtifactsByDraftRevision(draftRevisionId: string) {
    return [...this.artifacts.values()].filter((value) => value.draftRevisionId === draftRevisionId);
  }
  async listComplianceResultsByDraftRevision(draftRevisionId: string) {
    return [...this.compliance.values()].filter((value) => value.draftRevisionId === draftRevisionId);
  }
  async listApprovalsByPipelineRun(pipelineRunId: string) {
    return [...this.approvals.values()].filter((value) => value.pipelineRunId === pipelineRunId);
  }
  async listTransitions(pipelineRunId: string) {
    return this.transitions.filter((value) => value.pipelineRunId === pipelineRunId);
  }
  async getDelivery(id: string) { return this.deliveries.get(id); }
  async getDeliveryByIdempotencyKey(key: string) {
    return [...this.deliveries.values()].find((value) => value.idempotencyKey === key);
  }
  async listDeliveriesByApproval(approvalId: string) {
    return [...this.deliveries.values()].filter((value) => value.approvalId === approvalId);
  }

  async commitGuardedTransition(
    command: GuardedTransitionCommand,
  ): Promise<GuardedTransitionOutcome> {
    const replayKey = `${command.pipelineRunId}:${command.idempotencyKey}`;
    const prior = this.replay.get(replayKey);
    if (prior !== undefined) {
      const replayed = prior.kind === "Conflict"
        ? prior
        : { ...prior, kind: "Replayed" as const };
      return replayed;
    }
    const current = this.runs.get(command.pipelineRunId);
    if (
      current === undefined ||
      current.version !== command.expectedVersion ||
      current.stage !== command.expectedStage ||
      current.workStatus !== command.expectedStatus
    ) {
      return { kind: "Conflict", current };
    }
    for (const research of command.records.researchResults ?? []) {
      this.research.set(research.id, research);
    }
    for (const revision of command.records.draftRevisions ?? []) {
      this.revisions.set(revision.id, revision);
    }
    for (const report of command.records.verificationReports ?? []) {
      this.reports.set(report.id, report);
    }
    for (const artifact of command.records.platformArtifacts ?? []) {
      this.artifacts.set(artifact.id, artifact);
    }
    for (const result of command.records.complianceResults ?? []) {
      this.compliance.set(result.id, result);
    }
    for (const approval of command.records.approvals ?? []) {
      this.approvals.set(approval.id, approval);
    }
    const run: PipelineRun = {
      ...current,
      stage: command.nextStage,
      workStatus: command.nextStatus,
      version: current.version + 1,
      activeDraftRevisionId:
        command.nextActiveDraftRevisionId ?? current.activeDraftRevisionId,
      ...(command.blockedReason === undefined
        ? { blockedReason: undefined }
        : { blockedReason: command.blockedReason }),
      updatedAt: NOW,
    };
    const transition: PipelineTransition = {
      id: `transition-${this.transitions.length + 1}`,
      pipelineRunId: current.id,
      fromStage: current.stage,
      toStage: run.stage,
      fromStatus: current.workStatus,
      toStatus: run.workStatus,
      actorType: command.actorType,
      actorId: command.actorId,
      artifactRevisionId: command.artifactRevisionId,
      reason: command.reason,
      idempotencyKey: command.idempotencyKey,
      createdAt: NOW,
    };
    this.runs.set(run.id, run);
    this.transitions.push(transition);
    const outcome = { kind: "Applied" as const, run, transition };
    this.replay.set(replayKey, outcome);
    return outcome;
  }

  async recordDelivery(record: DeliveryRecord) {
    const prior = await this.getDeliveryByIdempotencyKey(record.idempotencyKey);
    if (prior !== undefined) return { record: prior, replayed: true };
    this.deliveries.set(record.id, record);
    return { record, replayed: false };
  }
}
function topic(categories: readonly string[] = ["AI Tools"]): Topic {
  return {
    id: "topic-1",
    sourceRef: {
      sourceId: "source-1",
      captureId: "capture-1",
      url: "https://example.com/source",
      capturedAt: NOW,
      termsVersion: "terms-v1",
    },
    externalId: "external-1",
    title: "Topic",
    createdAt: NOW,
    score: {
      total: 90,
      breakdown: [
        { criterionId: "relevance", componentValue: 90, weightPercent: 100 },
      ],
      scoringConfigVersion: "score-v1",
    },
    categories,
  };
}

function revision(): DraftRevision {
  return {
    id: "revision-1",
    draftId: "draft-1",
    revision: 1,
    content: {
      topicId: "topic-1",
      facebookPost: "A".repeat(50),
      guide: [],
      videoScript: { intro: "intro", body: "body", conclusion: "end" },
      originLinks: ["https://example.com/source"],
      language: "vi",
    },
    contentHash: "content-hash-1",
    createdBy: "System",
    createdAt: NOW,
  };
}

function report(): VerificationReport {
  return {
    id: "report-1",
    draftRevisionId: "revision-1",
    contentHash: "content-hash-1",
    researchResultId: "research-1",
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
}

function artifact(): PlatformArtifact {
  return {
    id: "artifact-1",
    draftRevisionId: "revision-1",
    platform: "Facebook_Page",
    rendererVersion: "renderer-v1",
    body: "approved bytes",
    metadata: {},
    attribution: "Source",
    imageSuggestions: [],
    artifactHash: "artifact-hash-1",
    createdAt: NOW,
  };
}

function compliance(): ComplianceResult {
  return {
    id: "compliance-1",
    artifactId: "artifact-1",
    artifactHash: "artifact-hash-1",
    draftRevisionId: "revision-1",
    platform: "Facebook_Page",
    ruleSetVersion: "rules-v1",
    sourceTermsVersions: ["terms-v1"],
    evaluatorVersion: "evaluator-v1",
    passed: true,
    violatedRuleIds: [],
    attributionOk: true,
    copyrightOk: true,
    reasons: [],
    checkedAt: NOW,
  };
}

function run(stage: PipelineRun["stage"], workStatus: PipelineRun["workStatus"] = "Ready"): PipelineRun {
  return {
    id: "run-1",
    topicId: "topic-1",
    activeDraftRevisionId: "revision-1",
    stage,
    workStatus,
    version: 1,
    categories: ["AI Tools"],
    createdAt: START,
    updatedAt: START,
  };
}

function pipeline(repository: MemoryRepository, retryBudget = 2): ContentPipeline {
  return new ContentPipeline(repository, ["AI Tools", "AI Skills", "AI News"], {
    automaticStageRetryBudgets: {
      Scored: retryBudget,
      Researched: retryBudget,
      Generated: retryBudget,
      Verified: retryBudget,
      ComplianceChecked: retryBudget,
    },
    now: () => NOW,
  });
}
describe("ContentPipeline", () => {
  it("assigns 1-5 unique categories only from the configured set", async () => {
    const repository = new MemoryRepository();
    const contentPipeline = pipeline(repository);

    const created = await contentPipeline.start({
      pipelineRunId: "run-1",
      topic: topic([]),
      categories: ["AI Tools", "AI News"],
      idempotencyKey: "start-1",
      createdAt: START,
    });

    expect(created.categories).toEqual(["AI Tools", "AI News"]);
    expect((await repository.getTopic("topic-1"))?.categories).toEqual([
      "AI Tools",
      "AI News",
    ]);
    expect(() => contentPipeline.assignCategories([])).toThrow(PipelineCommandError);
    expect(() => contentPipeline.assignCategories(["Unknown"])).toThrow(
      "configured category set",
    );
    expect(() =>
      contentPipeline.assignCategories([
        "AI Tools",
        "AI Skills",
        "AI News",
        "AI Tools",
      ]),
    ).toThrow("1 to 5 unique categories");
  });

  it("uses intent-specific adjacent transitions and rejects stage skipping", async () => {
    const repository = new MemoryRepository();
    repository.runs.set("run-1", run("Researched"));
    repository.revisions.set("revision-1", revision());
    const contentPipeline = pipeline(repository);

    const generated = await contentPipeline.completeGeneration({
      pipelineRunId: "run-1",
      expectedVersion: 1,
      expectedStage: "Researched",
      expectedStatus: "Ready",
      draftRevisionId: "revision-1",
      idempotencyKey: "generate-1",
    });

    expect(generated.stage).toBe("Generated");
    await expect(
      contentPipeline.submitForReview({
        pipelineRunId: "run-1",
        expectedVersion: 2,
        expectedStage: "Verified",
        expectedStatus: "Ready",
        idempotencyKey: "skip-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(repository.transitions).toHaveLength(1);
  });

  it("records valid rejection context while preserving the active draft", async () => {
    const repository = new MemoryRepository();
    repository.runs.set("run-1", run("Generated"));
    repository.revisions.set("revision-1", revision());
    const contentPipeline = pipeline(repository);

    const rejected = await contentPipeline.reject({
      pipelineRunId: "run-1",
      expectedVersion: 1,
      expectedStage: "Generated",
      expectedStatus: "Ready",
      failingStage: "Generated",
      reason: "Generated content failed terminal validation",
      actorType: "System",
      idempotencyKey: "reject-1",
    });

    expect(rejected).toMatchObject({
      stage: "Rejected",
      workStatus: "Rejected",
      activeDraftRevisionId: "revision-1",
      blockedReason: "[Generated] Generated content failed terminal validation",
    });
    expect(repository.revisions.get("revision-1")).toEqual(revision());
    expect(repository.transitions[0]).toMatchObject({
      fromStage: "Generated",
      toStage: "Rejected",
      reason: "Generated content failed terminal validation",
    });
  });
  it("measures the rejection reason limit in code points for both actor types", async () => {
    // "🙂" is one code point but two UTF-16 code units.
    const astral = (codePoints: number) => "🙂".repeat(codePoints);

    const accepted = async (
      actorType: "Operator" | "System",
      codePointCount: number,
    ) => {
      const repository = new MemoryRepository();
      repository.runs.set("run-1", run("Generated"));
      repository.revisions.set("revision-1", revision());
      const contentPipeline = pipeline(repository);
      const reason = astral(codePointCount);

      const rejected = await contentPipeline.reject({
        pipelineRunId: "run-1",
        expectedVersion: 1,
        expectedStage: "Generated",
        expectedStatus: "Ready",
        failingStage: "Generated",
        reason,
        actorType,
        ...(actorType === "Operator" ? { actorId: "operator-1" } : {}),
        idempotencyKey: "reject-boundary",
      });

      expect(rejected).toMatchObject({
        stage: "Rejected",
        workStatus: "Rejected",
        blockedReason: `[Generated] ${reason}`,
      });
      expect(repository.transitions[0]).toMatchObject({ reason });
    };

    const refused = async (
      actorType: "Operator" | "System",
      codePointCount: number,
    ) => {
      const repository = new MemoryRepository();
      repository.runs.set("run-1", run("Generated"));
      repository.revisions.set("revision-1", revision());
      const contentPipeline = pipeline(repository);

      await expect(
        contentPipeline.reject({
          pipelineRunId: "run-1",
          expectedVersion: 1,
          expectedStage: "Generated",
          expectedStatus: "Ready",
          failingStage: "Generated",
          reason: astral(codePointCount),
          actorType,
          ...(actorType === "Operator" ? { actorId: "operator-1" } : {}),
          idempotencyKey: "reject-over",
        }),
      ).rejects.toMatchObject({ code: "INVALID_REJECTION" });
      expect(repository.transitions).toHaveLength(0);
    };

    await accepted("Operator", 1_000);
    await refused("Operator", 1_001);
    await accepted("System", 500);
    await refused("System", 501);
  });

  it("approves only exact passing evidence and delivers only an approved exact artifact", async () => {
    const repository = new MemoryRepository();
    repository.runs.set("run-1", run("PendingApproval"));
    repository.revisions.set("revision-1", revision());
    repository.reports.set("report-1", report());
    repository.artifacts.set("artifact-1", artifact());
    repository.compliance.set("compliance-1", compliance());
    const contentPipeline = pipeline(repository);

    expect(
      await contentPipeline.canDeliver({
        pipelineRunId: "run-1",
        approvalId: "missing",
        artifactId: "artifact-1",
        artifactHash: "artifact-hash-1",
      }),
    ).toBe(false);

    const approval = await contentPipeline.approve({
      pipelineRunId: "run-1",
      expectedVersion: 1,
      expectedStage: "PendingApproval",
      expectedStatus: "Ready",
      operatorId: "operator-1",
      confirmed: true,
      draftRevisionId: "revision-1",
      contentHash: "content-hash-1",
      verificationReportId: "report-1",
      complianceResultIds: ["compliance-1"],
      artifactIds: ["artifact-1"],
      artifactHashes: ["artifact-hash-1"],
      idempotencyKey: "approve-1",
    });

    expect((await repository.getPipelineRun("run-1"))?.stage).toBe("Approved");
    expect(approval.operatorId).toBe("operator-1");
    expect(
      await contentPipeline.canDeliver({
        pipelineRunId: "run-1",
        approvalId: approval.id,
        artifactId: "artifact-1",
        artifactHash: "artifact-hash-1",
      }),
    ).toBe(true);
    await expect(
      contentPipeline.canDeliver({
        pipelineRunId: "run-1",
        approvalId: approval.id,
        artifactId: "artifact-1",
        artifactHash: "changed-hash",
      }),
    ).resolves.toBe(false);
  });

  it("refuses stale approval evidence without changing PendingApproval", async () => {
    const repository = new MemoryRepository();
    repository.runs.set("run-1", run("PendingApproval"));
    repository.revisions.set("revision-1", revision());
    repository.reports.set("report-1", report());
    repository.artifacts.set("artifact-1", artifact());
    repository.compliance.set("compliance-1", compliance());
    const contentPipeline = pipeline(repository);

    await expect(
      contentPipeline.approve({
        pipelineRunId: "run-1",
        expectedVersion: 1,
        expectedStage: "PendingApproval",
        expectedStatus: "Ready",
        operatorId: "operator-1",
        confirmed: true,
        draftRevisionId: "revision-1",
        contentHash: "stale-content-hash",
        verificationReportId: "report-1",
        complianceResultIds: ["compliance-1"],
        artifactIds: ["artifact-1"],
        artifactHashes: ["artifact-hash-1"],
        idempotencyKey: "approve-stale",
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_MISMATCH" });
    expect((await repository.getPipelineRun("run-1"))?.stage).toBe(
      "PendingApproval",
    );
    expect(repository.transitions).toHaveLength(0);
  });
  it("refuses delivery during automatic stages with a not-approved indicator", async () => {
    const repository = new MemoryRepository();
    repository.runs.set("run-1", run("Verified", "InProgress"));
    const contentPipeline = pipeline(repository);

    await expect(
      contentPipeline.authorizeDelivery({
        pipelineRunId: "run-1",
        approvalId: "approval-1",
        artifactId: "artifact-1",
        artifactHash: "artifact-hash-1",
      }),
    ).resolves.toEqual({
      allowed: false,
      errorCode: "CONTENT_NOT_APPROVED",
      message: "Content is not approved for output or delivery",
    });
  });

  it("blocks a 300s timeout while retries remain and rejects only at budget exhaustion", async () => {
    const repository = new MemoryRepository();
    repository.runs.set("run-1", run("Generated", "InProgress"));
    repository.revisions.set("revision-1", revision());
    const contentPipeline = pipeline(repository, 2);

    const blocked = await contentPipeline.handleAutomaticStageTimeout({
      pipelineRunId: "run-1",
      expectedVersion: 1,
      expectedStage: "Generated",
      expectedStatus: "InProgress",
      stage: "Generated",
      attempt: 1,
      startedAt: START,
      timedOutAt: NOW,
      idempotencyKey: "timeout-1",
    });

    expect(blocked).toMatchObject({
      stage: "Generated",
      workStatus: "RetryableBlocked",
      activeDraftRevisionId: "revision-1",
    });

    const rejected = await contentPipeline.handleAutomaticStageTimeout({
      pipelineRunId: "run-1",
      expectedVersion: 2,
      expectedStage: "Generated",
      expectedStatus: "RetryableBlocked",
      stage: "Generated",
      attempt: 2,
      startedAt: START,
      timedOutAt: NOW,
      idempotencyKey: "timeout-2",
    });

    expect(rejected).toMatchObject({
      stage: "Rejected",
      workStatus: "Rejected",
      activeDraftRevisionId: "revision-1",
    });
    expect(rejected.blockedReason).toContain("[Generated]");
    expect(rejected.blockedReason).toContain("retry budget exhausted");
  });

  it("atomically persists exact verification evidence and owns the Generated to Verified transition", async () => {
    const repository = new MemoryRepository();
    repository.runs.set("run-1", run("Generated"));
    repository.revisions.set("revision-1", revision());
    const contentPipeline = pipeline(repository);
    const claim = {
      id: "claim-1",
      draftRevisionId: "revision-1",
      format: "FacebookPost" as const,
      path: "facebookPost",
      startOffset: 0,
      endOffset: 50,
      text: "A".repeat(50),
    };
    const exactReport: VerificationReport = {
      ...report(),
      findings: [{
        claimId: claim.id,
        verdict: "Pass",
        evidenceRefs: [topic().sourceRef],
      }],
    };

    const verified = await contentPipeline.recordVerificationResult({
      pipelineRunId: "run-1",
      expectedVersion: 1,
      expectedStage: "Generated",
      expectedStatus: "Ready",
      idempotencyKey: "verify-result-1",
      result: {
        kind: "Passed",
        eligibleStage: "Verified",
        activeRevision: revision(),
        claims: [claim],
        report: exactReport,
        attempts: 1,
        artifacts: {
          revisions: [],
          reports: [exactReport],
          corrections: [],
        },
      },
    });

    expect(verified).toMatchObject({
      stage: "Verified",
      workStatus: "Ready",
      activeDraftRevisionId: "revision-1",
    });
    expect(await repository.getVerificationReport(exactReport.id)).toEqual(exactReport);
    expect(repository.transitions[0]).toMatchObject({
      fromStage: "Generated",
      toStage: "Verified",
      artifactRevisionId: "revision-1",
    });
  });
});
