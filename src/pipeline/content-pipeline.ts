import type {
  ComplianceResult,
  DraftRevision,
  PlatformArtifact,
  Topic,
  VerificationReport,
} from "../domain/content.js";
import {
  SUCCESSFUL_WORKFLOW_STAGES,
  type ApprovalRecord,
  type PipelineRun,
  type WorkStatus,
  type WorkflowStage,
} from "../domain/workflow.js";
import type {
  ExpectedPipelineState,
  Repository,
  TransitionRecords,
} from "../adapters/ports.js";

export const AUTOMATIC_WORKFLOW_STAGES = [
  "Scored",
  "Researched",
  "Generated",
  "Verified",
  "ComplianceChecked",
] as const satisfies readonly WorkflowStage[];

export const AUTOMATIC_STAGE_TIMEOUT_MS = 300_000;

export type AutomaticWorkflowStage =
  (typeof AUTOMATIC_WORKFLOW_STAGES)[number];

type PipelineErrorCode =
  | "INVALID_COMMAND"
  | "INVALID_CATEGORY"
  | "INVALID_REJECTION"
  | "INVALID_TRANSITION"
  | "EVIDENCE_MISMATCH"
  | "CONFLICT"
  | "NOT_FOUND"
  | "NOT_TIMED_OUT";

export class PipelineCommandError extends Error {
  constructor(
    readonly code: PipelineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PipelineCommandError";
  }
}
interface MutationCommand extends ExpectedPipelineState {
  readonly idempotencyKey: string;
}

export interface StartPipelineCommand {
  readonly pipelineRunId: string;
  readonly topic: Topic;
  readonly categories: readonly string[];
  readonly idempotencyKey: string;
  readonly createdAt?: string;
}

export interface CompleteScoringCommand extends MutationCommand {
  readonly topicId: string;
  readonly scoreId: string;
}

export interface CompleteResearchCommand extends MutationCommand {
  readonly researchResultId: string;
}

export interface CompleteGenerationCommand extends MutationCommand {
  readonly draftRevisionId: string;
}

export interface CompleteVerificationCommand extends MutationCommand {
  readonly reportId: string;
}

export interface CompleteComplianceCommand extends MutationCommand {
  readonly artifactResultIds: readonly string[];
}

export interface SubmitForReviewCommand extends MutationCommand {}

export interface RejectCommand extends MutationCommand {
  readonly failingStage: WorkflowStage;
  readonly reason: string;
  readonly actorType: "System" | "Operator";
  readonly actorId?: string;
}

export interface ApprovalCommand extends MutationCommand {
  readonly operatorId: string;
  readonly confirmed: true;
  readonly draftRevisionId: string;
  readonly contentHash: string;
  readonly verificationReportId: string;
  readonly complianceResultIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly artifactHashes: readonly string[];
}

export interface DeliveryAuthorizationCommand {
  readonly pipelineRunId: string;
  readonly approvalId: string;
  readonly artifactId: string;
  readonly artifactHash: string;
}

export type DeliveryAuthorization =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly errorCode:
        | "CONTENT_NOT_APPROVED"
        | "APPROVAL_ARTIFACT_MISMATCH";
      readonly message: string;
    };

export interface AutomaticStageTimeoutCommand extends MutationCommand {
  readonly stage: AutomaticWorkflowStage;
  /** One-based attempt number that has just timed out. */
  readonly attempt: number;
  readonly startedAt: string;
  readonly timedOutAt?: string;
}

export interface ContentPipelineOptions {
  readonly automaticStageRetryBudgets?: Partial<
    Readonly<Record<AutomaticWorkflowStage, number>>
  >;
  readonly now?: () => string;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new PipelineCommandError("INVALID_COMMAND", `${label} is required`);
  }
}

function isAutomaticStage(stage: WorkflowStage): stage is AutomaticWorkflowStage {
  return (AUTOMATIC_WORKFLOW_STAGES as readonly WorkflowStage[]).includes(stage);
}

function isAdjacent(from: WorkflowStage, to: WorkflowStage): boolean {
  const fromIndex = SUCCESSFUL_WORKFLOW_STAGES.indexOf(
    from as (typeof SUCCESSFUL_WORKFLOW_STAGES)[number],
  );
  return fromIndex >= 0 && SUCCESSFUL_WORKFLOW_STAGES[fromIndex + 1] === to;
}

function assertIntentStage(
  command: MutationCommand,
  expected: WorkflowStage,
  next: WorkflowStage,
): void {
  if (command.expectedStage !== expected || !isAdjacent(expected, next)) {
    throw new PipelineCommandError(
      "INVALID_TRANSITION",
      `Expected adjacent transition ${expected} -> ${next}`,
    );
  }
  assertNonEmpty(command.idempotencyKey, "idempotencyKey");
}

function timeoutReason(
  stage: AutomaticWorkflowStage,
  attempt: number,
  budget: number,
): string {
  return `Automatic stage ${stage} timed out after 300 seconds (attempt ${attempt}/${budget})`;
}
export class ContentPipeline {
  private readonly categorySet: ReadonlySet<string>;
  private readonly retryBudgets: Readonly<Record<AutomaticWorkflowStage, number>>;
  private readonly now: () => string;

  constructor(
    private readonly repository: Repository,
    configuredCategories: readonly string[],
    options: ContentPipelineOptions = {},
  ) {
    const categories = configuredCategories.map((category) => category.trim());
    if (
      categories.length === 0 ||
      categories.some((category) => category.length === 0) ||
      new Set(categories).size !== categories.length
    ) {
      throw new PipelineCommandError(
        "INVALID_CATEGORY",
        "Configured categories must be non-empty and unique",
      );
    }
    this.categorySet = new Set(categories);

    const budgets = Object.fromEntries(
      AUTOMATIC_WORKFLOW_STAGES.map((stage) => [
        stage,
        options.automaticStageRetryBudgets?.[stage] ?? 3,
      ]),
    ) as Record<AutomaticWorkflowStage, number>;
    for (const [stage, budget] of Object.entries(budgets)) {
      if (!Number.isInteger(budget) || budget < 1) {
        throw new PipelineCommandError(
          "INVALID_COMMAND",
          `Retry budget for ${stage} must be a positive integer`,
        );
      }
    }
    this.retryBudgets = budgets;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  assignCategories(requested: readonly string[]): readonly string[] {
    const unique = [...new Set(requested)];
    if (
      requested.length !== unique.length ||
      unique.length < 1 ||
      unique.length > 5 ||
      unique.some((category) => !this.categorySet.has(category))
    ) {
      throw new PipelineCommandError(
        "INVALID_CATEGORY",
        "Choose 1 to 5 unique categories from the configured category set",
      );
    }
    return Object.freeze(unique);
  }

  async start(command: StartPipelineCommand): Promise<PipelineRun> {
    assertNonEmpty(command.pipelineRunId, "pipelineRunId");
    assertNonEmpty(command.idempotencyKey, "idempotencyKey");
    const categories = this.assignCategories(command.categories);
    const createdAt = command.createdAt ?? this.now();
    const topic: Topic = { ...command.topic, categories };
    const run: PipelineRun = {
      id: command.pipelineRunId,
      topicId: topic.id,
      stage: "Collected",
      workStatus: "Ready",
      version: 0,
      categories,
      createdAt,
      updatedAt: createdAt,
    };
    return this.repository.createPipelineRun({
      run,
      topic,
      idempotencyKey: command.idempotencyKey,
    });
  }

  async completeScoring(command: CompleteScoringCommand): Promise<PipelineRun> {
    assertIntentStage(command, "Collected", "Scored");
    assertNonEmpty(command.scoreId, "scoreId");
    const topic = await this.requiredTopic(command.topicId);
    const run = await this.repository.getPipelineRun(command.pipelineRunId);
    if (run !== undefined && run.topicId !== topic.id) {
      throw new PipelineCommandError("EVIDENCE_MISMATCH", "Score topic does not belong to this pipeline run");
    }
    if (topic.score.total === null) {
      throw new PipelineCommandError("EVIDENCE_MISMATCH", "An unscored topic cannot advance");
    }
    this.assignCategories(topic.categories);
    return this.commitAdjacent(command, "Scored", command.scoreId);
  }

  async completeResearch(command: CompleteResearchCommand): Promise<PipelineRun> {
    assertIntentStage(command, "Scored", "Researched");
    const research = await this.repository.getResearchResult(command.researchResultId);
    if (research === undefined) this.notFound("Research result", command.researchResultId);
    const run = await this.repository.getPipelineRun(command.pipelineRunId);
    if (research.status !== "Ok" || (run !== undefined && research.topicId !== run.topicId)) {
      throw new PipelineCommandError("EVIDENCE_MISMATCH", "Research must be sufficient and belong to the run topic");
    }
    return this.commitAdjacent(command, "Researched", research.id);
  }

  async completeGeneration(command: CompleteGenerationCommand): Promise<PipelineRun> {
    assertIntentStage(command, "Researched", "Generated");
    const revision = await this.requiredRevision(command.draftRevisionId);
    const run = await this.repository.getPipelineRun(command.pipelineRunId);
    if (run !== undefined && revision.content.topicId !== run.topicId) {
      throw new PipelineCommandError("EVIDENCE_MISMATCH", "Draft revision does not belong to the run topic");
    }
    return this.commitAdjacent(
      command,
      "Generated",
      revision.id,
      {},
      revision.id,
    );
  }
  async completeVerification(command: CompleteVerificationCommand): Promise<PipelineRun> {
    assertIntentStage(command, "Generated", "Verified");
    const report = await this.requiredVerification(command.reportId);
    const run = await this.requiredRun(command.pipelineRunId);
    const revision = await this.requiredRevision(report.draftRevisionId);
    if (
      !report.passed ||
      run.activeDraftRevisionId !== revision.id ||
      report.contentHash !== revision.contentHash
    ) {
      throw new PipelineCommandError(
        "EVIDENCE_MISMATCH",
        "Verification must pass for the active revision and exact content hash",
      );
    }
    return this.commitAdjacent(command, "Verified", report.id);
  }

  async completeCompliance(command: CompleteComplianceCommand): Promise<PipelineRun> {
    assertIntentStage(command, "Verified", "ComplianceChecked");
    if (command.artifactResultIds.length === 0) {
      throw new PipelineCommandError("EVIDENCE_MISMATCH", "At least one compliance result is required");
    }
    const run = await this.requiredRun(command.pipelineRunId);
    const results = await Promise.all(
      command.artifactResultIds.map((id) => this.requiredCompliance(id)),
    );
    if (new Set(command.artifactResultIds).size !== command.artifactResultIds.length) {
      throw new PipelineCommandError("EVIDENCE_MISMATCH", "Compliance result IDs must be unique");
    }
    for (const result of results) {
      const artifact = await this.requiredArtifact(result.artifactId);
      if (
        !result.passed ||
        !result.attributionOk ||
        !result.copyrightOk ||
        result.violatedRuleIds.length > 0 ||
        result.draftRevisionId !== run.activeDraftRevisionId ||
        artifact.draftRevisionId !== run.activeDraftRevisionId ||
        result.artifactHash !== artifact.artifactHash
      ) {
        throw new PipelineCommandError(
          "EVIDENCE_MISMATCH",
          "Every selected artifact must pass compliance for the active revision and exact artifact hash",
        );
      }
    }
    return this.commitAdjacent(
      command,
      "ComplianceChecked",
      command.artifactResultIds.join(","),
    );
  }

  async submitForReview(command: SubmitForReviewCommand): Promise<PipelineRun> {
    assertIntentStage(command, "ComplianceChecked", "PendingApproval");
    return this.commitAdjacent(command, "PendingApproval");
  }

  async reject(command: RejectCommand): Promise<PipelineRun> {
    if (
      command.expectedStage === "Rejected" ||
      command.failingStage !== command.expectedStage
    ) {
      throw new PipelineCommandError(
        "INVALID_REJECTION",
        "The failing stage must identify the current nonterminal stage",
      );
    }
    const reason = command.reason.trim();
    if (reason.length < 1 || reason.length > 500) {
      throw new PipelineCommandError(
        "INVALID_REJECTION",
        "Rejection reason must contain 1 to 500 characters",
      );
    }
    if (command.actorType === "Operator") {
      assertNonEmpty(command.actorId ?? "", "actorId");
    }
    const run = await this.requiredRun(command.pipelineRunId);
    return this.commit(command, {
      nextStage: "Rejected",
      nextStatus: "Rejected",
      nextActiveDraftRevisionId: run.activeDraftRevisionId,
      blockedReason: `[${command.failingStage}] ${reason}`,
      actorType: command.actorType,
      actorId: command.actorId,
      reason,
      artifactRevisionId: run.activeDraftRevisionId,
      records: {},
    });
  }

  async approve(command: ApprovalCommand): Promise<ApprovalRecord> {
    assertIntentStage(command, "PendingApproval", "Approved");
    assertNonEmpty(command.operatorId, "operatorId");
    if (command.confirmed !== true) {
      throw new PipelineCommandError("INVALID_COMMAND", "Approval must be explicitly confirmed");
    }
    const run = await this.requiredRun(command.pipelineRunId);
    const revision = await this.requiredRevision(command.draftRevisionId);
    const report = await this.requiredVerification(command.verificationReportId);
    const artifacts = await Promise.all(command.artifactIds.map((id) => this.requiredArtifact(id)));
    const compliance = await Promise.all(
      command.complianceResultIds.map((id) => this.requiredCompliance(id)),
    );
    this.assertApprovalEvidence(command, run, revision, report, artifacts, compliance);

    const approvalId = `${command.pipelineRunId}:approval:${command.idempotencyKey}`;
    const approval: ApprovalRecord = {
      id: approvalId,
      pipelineRunId: command.pipelineRunId,
      draftRevisionId: revision.id,
      contentHash: revision.contentHash,
      approvedArtifactIds: [...command.artifactIds],
      approvedArtifactHashes: [...command.artifactHashes],
      operatorId: command.operatorId,
      approvedAt: this.now(),
    };
    const outcome = await this.commitRaw(command, {
      nextStage: "Approved",
      nextStatus: "Ready",
      nextActiveDraftRevisionId: revision.id,
      actorType: "Operator",
      actorId: command.operatorId,
      artifactRevisionId: revision.id,
      records: { approvals: [approval] },
    });
    if (outcome.kind === "Replayed") {
      return (await this.repository.getApproval(approvalId)) ?? approval;
    }
    return approval;
  }
  async canDeliver(command: DeliveryAuthorizationCommand): Promise<boolean> {
    return (await this.authorizeDelivery(command)).allowed;
  }

  async authorizeDelivery(
    command: DeliveryAuthorizationCommand,
  ): Promise<DeliveryAuthorization> {
    const run = await this.repository.getPipelineRun(command.pipelineRunId);
    if (run?.stage !== "Approved") {
      return {
        allowed: false,
        errorCode: "CONTENT_NOT_APPROVED",
        message: "Content is not approved for output or delivery",
      };
    }
    const [approval, artifact] = await Promise.all([
      this.repository.getApproval(command.approvalId),
      this.repository.getPlatformArtifact(command.artifactId),
    ]);
    const index = approval?.approvedArtifactIds.indexOf(command.artifactId) ?? -1;
    if (
      approval === undefined ||
      approval.pipelineRunId !== run.id ||
      approval.draftRevisionId !== run.activeDraftRevisionId ||
      index < 0 ||
      approval.approvedArtifactHashes[index] !== command.artifactHash ||
      artifact === undefined ||
      artifact.draftRevisionId !== approval.draftRevisionId ||
      artifact.artifactHash !== command.artifactHash
    ) {
      return {
        allowed: false,
        errorCode: "APPROVAL_ARTIFACT_MISMATCH",
        message: "Artifact is not part of the exact approved artifact set",
      };
    }
    return { allowed: true };
  }

  async handleAutomaticStageTimeout(
    command: AutomaticStageTimeoutCommand,
  ): Promise<PipelineRun> {
    if (
      !isAutomaticStage(command.stage) ||
      command.expectedStage !== command.stage
    ) {
      throw new PipelineCommandError(
        "INVALID_TRANSITION",
        "Timeout stage must match the current automatic stage",
      );
    }
    const start = Date.parse(command.startedAt);
    const end = Date.parse(command.timedOutAt ?? this.now());
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw new PipelineCommandError("INVALID_COMMAND", "Timeout timestamps are invalid");
    }
    if (end - start < AUTOMATIC_STAGE_TIMEOUT_MS) {
      throw new PipelineCommandError(
        "NOT_TIMED_OUT",
        "Automatic stage has not reached its 300-second deadline",
      );
    }
    const budget = this.retryBudgets[command.stage];
    if (!Number.isInteger(command.attempt) || command.attempt < 1 || command.attempt > budget) {
      throw new PipelineCommandError(
        "INVALID_COMMAND",
        `Timeout attempt must be between 1 and ${budget}`,
      );
    }
    const reason = timeoutReason(command.stage, command.attempt, budget);
    const run = await this.requiredRun(command.pipelineRunId);
    if (command.attempt < budget) {
      return this.commit(command, {
        nextStage: command.stage,
        nextStatus: "RetryableBlocked",
        nextActiveDraftRevisionId: run.activeDraftRevisionId,
        blockedReason: `${reason}; retry remains within the configured stage budget`,
        actorType: "System",
        reason,
        artifactRevisionId: run.activeDraftRevisionId,
        records: {},
      });
    }
    return this.commit(command, {
      nextStage: "Rejected",
      nextStatus: "Rejected",
      nextActiveDraftRevisionId: run.activeDraftRevisionId,
      blockedReason: `[${command.stage}] ${reason}; retry budget exhausted`,
      actorType: "System",
      reason: `${reason}; retry budget exhausted`,
      artifactRevisionId: run.activeDraftRevisionId,
      records: {},
    });
  }

  private assertApprovalEvidence(
    command: ApprovalCommand,
    run: PipelineRun,
    revision: DraftRevision,
    report: VerificationReport,
    artifacts: readonly PlatformArtifact[],
    compliance: readonly ComplianceResult[],
  ): void {
    if (
      run.activeDraftRevisionId !== revision.id ||
      command.contentHash !== revision.contentHash ||
      !report.passed ||
      report.draftRevisionId !== revision.id ||
      report.contentHash !== revision.contentHash ||
      command.artifactIds.length < 1 ||
      command.artifactIds.length !== command.artifactHashes.length ||
      command.complianceResultIds.length !== command.artifactIds.length ||
      new Set(command.artifactIds).size !== command.artifactIds.length ||
      new Set(command.complianceResultIds).size !== command.complianceResultIds.length
    ) {
      throw new PipelineCommandError(
        "EVIDENCE_MISMATCH",
        "Approval evidence does not match the active revision",
      );
    }
    const complianceByArtifact = new Map(
      compliance.map((result) => [result.artifactId, result]),
    );
    for (let index = 0; index < artifacts.length; index += 1) {
      const artifact = artifacts[index];
      const expectedHash = command.artifactHashes[index];
      const result = complianceByArtifact.get(artifact.id);
      if (
        artifact.draftRevisionId !== revision.id ||
        artifact.artifactHash !== expectedHash ||
        result === undefined ||
        !result.passed ||
        !result.attributionOk ||
        !result.copyrightOk ||
        result.violatedRuleIds.length > 0 ||
        result.draftRevisionId !== revision.id ||
        result.artifactHash !== expectedHash
      ) {
        throw new PipelineCommandError(
          "EVIDENCE_MISMATCH",
          "Every approved artifact needs exact-hash passing compliance",
        );
      }
    }
  }
  private async commitAdjacent(
    command: MutationCommand,
    nextStage: WorkflowStage,
    artifactRevisionId?: string,
    records: TransitionRecords = {},
    nextActiveDraftRevisionId?: string,
  ): Promise<PipelineRun> {
    if (!isAdjacent(command.expectedStage, nextStage)) {
      throw new PipelineCommandError("INVALID_TRANSITION", "Workflow stage skipping is prohibited");
    }
    return this.commit(command, {
      nextStage,
      nextStatus: "Ready",
      nextActiveDraftRevisionId,
      actorType: "System",
      artifactRevisionId,
      records,
    });
  }

  private async commit(
    command: MutationCommand,
    change: {
      readonly nextStage: WorkflowStage;
      readonly nextStatus: WorkStatus;
      readonly nextActiveDraftRevisionId?: string;
      readonly blockedReason?: string;
      readonly actorType: "System" | "Operator";
      readonly actorId?: string;
      readonly reason?: string;
      readonly artifactRevisionId?: string;
      readonly records: TransitionRecords;
    },
  ): Promise<PipelineRun> {
    const outcome = await this.commitRaw(command, change);
    return outcome.run;
  }

  private async commitRaw(
    command: MutationCommand,
    change: {
      readonly nextStage: WorkflowStage;
      readonly nextStatus: WorkStatus;
      readonly nextActiveDraftRevisionId?: string;
      readonly blockedReason?: string;
      readonly actorType: "System" | "Operator";
      readonly actorId?: string;
      readonly reason?: string;
      readonly artifactRevisionId?: string;
      readonly records: TransitionRecords;
    },
  ): Promise<
    | { readonly run: PipelineRun; readonly kind: "Applied" }
    | { readonly run: PipelineRun; readonly kind: "Replayed" }
  > {
    const outcome = await this.repository.commitGuardedTransition({
      ...command,
      ...change,
    });
    if (outcome.kind === "Conflict") {
      throw new PipelineCommandError(
        "CONFLICT",
        "Pipeline state or version changed before this command could be committed",
      );
    }
    return { run: outcome.run, kind: outcome.kind };
  }

  private async requiredRun(id: string): Promise<PipelineRun> {
    const value = await this.repository.getPipelineRun(id);
    if (value === undefined) this.notFound("Pipeline run", id);
    return value;
  }

  private async requiredTopic(id: string): Promise<Topic> {
    const value = await this.repository.getTopic(id);
    if (value === undefined) this.notFound("Topic", id);
    return value;
  }

  private async requiredRevision(id: string): Promise<DraftRevision> {
    const value = await this.repository.getDraftRevision(id);
    if (value === undefined) this.notFound("Draft revision", id);
    return value;
  }

  private async requiredVerification(id: string): Promise<VerificationReport> {
    const value = await this.repository.getVerificationReport(id);
    if (value === undefined) this.notFound("Verification report", id);
    return value;
  }

  private async requiredArtifact(id: string): Promise<PlatformArtifact> {
    const value = await this.repository.getPlatformArtifact(id);
    if (value === undefined) this.notFound("Platform artifact", id);
    return value;
  }

  private async requiredCompliance(id: string): Promise<ComplianceResult> {
    const value = await this.repository.getComplianceResult(id);
    if (value === undefined) this.notFound("Compliance result", id);
    return value;
  }

  private notFound(label: string, id: string): never {
    throw new PipelineCommandError("NOT_FOUND", `${label} ${id} was not found`);
  }
}
