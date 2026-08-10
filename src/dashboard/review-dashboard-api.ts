import { createHash } from "node:crypto";
import type { OutputPort, Repository } from "../adapters/ports.js";
import type {
  ContentDraft,
  DraftPatch,
  DraftRevision,
  PlatformArtifact,
} from "../domain/content.js";
import type {
  ApprovalRecord,
  DeliveryCommand,
  DeliveryOutcome,
  DeliveryRecord,
  PipelineRun,
  ReviewPackage,
  ReviewQueueFilter,
  ReviewSummary,
} from "../domain/workflow.js";
import {
  ContentPipeline,
  PipelineCommandError,
} from "../pipeline/content-pipeline.js";

export type DashboardApiErrorCode =
  | "AUTHORIZATION_REQUIRED"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "INVALID_EDIT"
  | "INVALID_REJECTION"
  | "CONFLICT"
  | "SAVE_FAILED"
  | "EVIDENCE_UNAVAILABLE"
  | "CONTENT_NOT_APPROVED";

export class DashboardApiError extends Error {
  constructor(
    readonly code: DashboardApiErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DashboardApiError";
  }
}
export interface AuthenticatedOperator {
  readonly id: string;
  readonly role: "Operator" | "Admin";
}

interface MutationCommand {
  readonly operator: AuthenticatedOperator;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

export interface EditDraftCommand extends MutationCommand {
  readonly patch: DraftPatch;
}

export interface DashboardApprovalCommand extends MutationCommand {
  readonly confirmed: true;
  readonly draftRevisionId: string;
  readonly contentHash: string;
  readonly verificationReportId: string;
  readonly complianceResultIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly artifactHashes: readonly string[];
}

export interface RejectDraftCommand extends MutationCommand {
  readonly note: string;
}

export interface ApprovedArtifactAccess {
  readonly approval: ApprovalRecord;
  readonly artifact: PlatformArtifact;
}

export interface DeliverApprovedArtifactCommand {
  readonly operator: AuthenticatedOperator;
  readonly approvalId: string;
  readonly artifactId: string;
  readonly artifactHash: string;
  readonly targetId: string;
  readonly idempotencyKey: string;
}

export interface ReviewDashboardApiOptions {
  readonly now?: () => string;
}

const BLOCKED_REVIEW_STATUSES = new Set<PipelineRun["workStatus"]>([
  "RetryableBlocked",
  "Unscored",
  "InsufficientData",
  "VerificationBlocked",
  "ComplianceFailed",
]);

function assertOperator(operator: AuthenticatedOperator): void {
  if (
    operator === undefined ||
    operator.id.trim().length === 0 ||
    (operator.role !== "Operator" && operator.role !== "Admin")
  ) {
    throw new DashboardApiError(
      "AUTHORIZATION_REQUIRED",
      "An authenticated Operator is required",
    );
  }
}

function assertTextLimit(value: string, label: string): void {
  if (Array.from(value).length > 5_000) {
    throw new DashboardApiError(
      "INVALID_EDIT",
      `${label} must not exceed 5000 characters`,
    );
  }
}

function validateContent(content: ContentDraft, topicId: string): void {
  if (content.topicId !== topicId) {
    throw new DashboardApiError("INVALID_EDIT", "An edit cannot change the topic binding");
  }
  assertTextLimit(content.facebookPost, "facebookPost");
  content.guide.forEach((section, sectionIndex) => {
    assertTextLimit(section.heading, `guide[${sectionIndex}].heading`);
    assertTextLimit(section.body, `guide[${sectionIndex}].body`);
    section.imageSuggestions.forEach((suggestion, suggestionIndex) => {
      assertTextLimit(
        suggestion.description,
        `guide[${sectionIndex}].imageSuggestions[${suggestionIndex}].description`,
      );
    });
  });
  assertTextLimit(content.videoScript.intro, "videoScript.intro");
  assertTextLimit(content.videoScript.body, "videoScript.body");
  assertTextLimit(content.videoScript.conclusion, "videoScript.conclusion");
  content.originLinks.forEach((link, index) => assertTextLimit(link, `originLinks[${index}]`));
  assertTextLimit(content.language, "language");
  if (content.brandVoiceVersion !== undefined) {
    assertTextLimit(content.brandVoiceVersion, "brandVoiceVersion");
  }
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function hashDraftContent(content: ContentDraft): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(content)), "utf8")
    .digest("hex");
}

function isQueuedForReview(run: PipelineRun): boolean {
  return run.stage === "PendingApproval" || BLOCKED_REVIEW_STATUSES.has(run.workStatus);
}

export class ReviewDashboardApi {
  private readonly now: () => string;

  constructor(
    private readonly repository: Repository,
    private readonly pipeline: ContentPipeline,
    private readonly outputPort: OutputPort,
    options: ReviewDashboardApiOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async listPending(): Promise<readonly ReviewSummary[]> {
    const runs = await this.repository.listPipelineRuns();
    return runs
      .filter((run) => run.stage === "PendingApproval")
      .map((run) => this.summary(run));
  }

  async listReviewQueue(
    filter: ReviewQueueFilter = {},
  ): Promise<readonly ReviewSummary[]> {
    const runs = (await this.repository.listPipelineRuns()).filter(
      (run) => isQueuedForReview(run) && (filter.status === undefined || run.workStatus === filter.status),
    );
    if (filter.platform === undefined) return runs.map((run) => this.summary(run));

    const matches = await Promise.all(runs.map(async (run) => {
      if (run.activeDraftRevisionId === undefined) return false;
      const artifacts = await this.repository.listPlatformArtifactsByDraftRevision(
        run.activeDraftRevisionId,
      );
      return artifacts.some((artifact) => artifact.platform === filter.platform);
    }));
    return runs.filter((_run, index) => matches[index]).map((run) => this.summary(run));
  }

  async getDraft(pipelineRunId: string): Promise<ReviewPackage> {
    return this.getReviewPackage(pipelineRunId);
  }

  async getReviewPackage(pipelineRunId: string): Promise<ReviewPackage> {
    const run = await this.requiredRun(pipelineRunId);
    if (run.activeDraftRevisionId === undefined) {
      throw new DashboardApiError("NOT_FOUND", "The pipeline run has no active draft revision");
    }
    const revision = await this.repository.getDraftRevision(run.activeDraftRevisionId);
    if (revision === undefined) {
      throw new DashboardApiError("NOT_FOUND", "The active draft revision was not found");
    }
    const [reports, artifacts, compliance] = await Promise.all([
      this.repository.listVerificationReportsByDraftRevision(revision.id),
      this.repository.listPlatformArtifactsByDraftRevision(revision.id),
      this.repository.listComplianceResultsByDraftRevision(revision.id),
    ]);
    const verification = [...reports].reverse().find(
      (report) => report.contentHash === revision.contentHash,
    );
    if (verification === undefined && run.stage === "PendingApproval") {
      throw new DashboardApiError(
        "EVIDENCE_UNAVAILABLE",
        "No verification report matches the active draft revision and content hash",
      );
    }
    const artifactHashes = new Map(artifacts.map((artifact) => [artifact.id, artifact.artifactHash]));
    return {
      run,
      revision,
      ...(verification === undefined ? {} : { verification }),
      artifacts,
      compliance: compliance.filter(
        (result) => artifactHashes.get(result.artifactId) === result.artifactHash,
      ),
    };
  }
  async editDraft(
    pipelineRunId: string,
    command: EditDraftCommand,
  ): Promise<DraftRevision> {
    assertOperator(command.operator);
    const run = await this.requiredRun(pipelineRunId);
    if (
      run.stage !== "PendingApproval" ||
      run.workStatus !== "Ready" ||
      run.version !== command.expectedVersion ||
      run.activeDraftRevisionId === undefined
    ) {
      throw new DashboardApiError(
        run.version === command.expectedVersion ? "INVALID_STATE" : "CONFLICT",
        "Draft editing requires the current PendingApproval version",
      );
    }
    const current = await this.repository.getDraftRevision(run.activeDraftRevisionId);
    if (current === undefined) {
      throw new DashboardApiError("NOT_FOUND", "The active draft revision was not found");
    }
    validateContent(command.patch.content, run.topicId);
    const contentHash = hashDraftContent(command.patch.content);
    const revision: DraftRevision = {
      id: `${current.draftId}:revision:${current.revision + 1}:${contentHash.slice(0, 12)}`,
      draftId: current.draftId,
      revision: current.revision + 1,
      parentRevisionId: current.id,
      content: structuredClone(command.patch.content),
      contentHash,
      createdBy: "Operator",
      actorId: command.operator.id,
      createdAt: this.now(),
    };

    try {
      const outcome = await this.repository.commitGuardedTransition({
        pipelineRunId,
        expectedVersion: command.expectedVersion,
        expectedStage: "PendingApproval",
        expectedStatus: "Ready",
        nextStage: "Generated",
        nextStatus: "Ready",
        nextActiveDraftRevisionId: revision.id,
        actorType: "Operator",
        actorId: command.operator.id,
        reason: "Operator edited the pending draft; re-verification required",
        artifactRevisionId: revision.id,
        records: { draftRevisions: [revision] },
        idempotencyKey: command.idempotencyKey,
      });
      if (outcome.kind === "Conflict") {
        throw new DashboardApiError(
          "CONFLICT",
          "Pipeline state or version changed before the edit could be saved",
        );
      }
      return (await this.repository.getDraftRevision(revision.id)) ?? revision;
    } catch (error) {
      if (error instanceof DashboardApiError) throw error;
      throw new DashboardApiError(
        "SAVE_FAILED",
        "The draft edit could not be saved; the previous revision remains active",
        { cause: error },
      );
    }
  }

  async approve(
    pipelineRunId: string,
    command: DashboardApprovalCommand,
  ): Promise<ApprovalRecord> {
    assertOperator(command.operator);
    return this.pipeline.approve({
      pipelineRunId,
      expectedVersion: command.expectedVersion,
      expectedStage: "PendingApproval",
      expectedStatus: "Ready",
      operatorId: command.operator.id,
      confirmed: command.confirmed,
      draftRevisionId: command.draftRevisionId,
      contentHash: command.contentHash,
      verificationReportId: command.verificationReportId,
      complianceResultIds: command.complianceResultIds,
      artifactIds: command.artifactIds,
      artifactHashes: command.artifactHashes,
      idempotencyKey: command.idempotencyKey,
    });
  }

  async reject(
    pipelineRunId: string,
    command: RejectDraftCommand,
  ): Promise<PipelineRun> {
    assertOperator(command.operator);
    const note = command.note.trim();
    if (Array.from(note).length < 1 || Array.from(note).length > 1_000) {
      throw new DashboardApiError(
        "INVALID_REJECTION",
        "A rejection note must contain 1 to 1000 characters",
      );
    }
    return this.pipeline.reject({
      pipelineRunId,
      expectedVersion: command.expectedVersion,
      expectedStage: "PendingApproval",
      expectedStatus: "Ready",
      failingStage: "PendingApproval",
      reason: note,
      actorType: "Operator",
      actorId: command.operator.id,
      idempotencyKey: command.idempotencyKey,
    });
  }
  async getApprovedArtifact(
    pipelineRunId: string,
    operator: AuthenticatedOperator,
    approvalId: string,
    artifactId: string,
    artifactHash: string,
  ): Promise<ApprovedArtifactAccess> {
    assertOperator(operator);
    const authorization = await this.pipeline.authorizeDelivery({
      pipelineRunId,
      approvalId,
      artifactId,
      artifactHash,
    });
    if (!authorization.allowed) {
      throw new DashboardApiError(
        "CONTENT_NOT_APPROVED",
        authorization.message,
      );
    }
    const [approval, artifact] = await Promise.all([
      this.repository.getApproval(approvalId),
      this.repository.getPlatformArtifact(artifactId),
    ]);
    if (approval === undefined || artifact === undefined) {
      throw new DashboardApiError("NOT_FOUND", "Approved artifact was not found");
    }
    return { approval, artifact };
  }

  async deliverApprovedArtifact(
    pipelineRunId: string,
    command: DeliverApprovedArtifactCommand,
  ): Promise<DeliveryOutcome> {
    await this.getApprovedArtifact(
      pipelineRunId,
      command.operator,
      command.approvalId,
      command.artifactId,
      command.artifactHash,
    );
    const delivery: DeliveryCommand = {
      approvalId: command.approvalId,
      artifactId: command.artifactId,
      artifactHash: command.artifactHash,
      targetId: command.targetId,
      idempotencyKey: command.idempotencyKey,
    };
    return this.outputPort.deliver(delivery);
  }

  async listDeliveries(
    pipelineRunId: string,
    operator: AuthenticatedOperator,
  ): Promise<readonly DeliveryRecord[]> {
    assertOperator(operator);
    await this.requiredRun(pipelineRunId);
    const approvals = await this.repository.listApprovalsByPipelineRun(pipelineRunId);
    const deliveries = await Promise.all(
      approvals.map((approval) => this.repository.listDeliveriesByApproval(approval.id)),
    );
    return deliveries.flat();
  }

  private async requiredRun(id: string): Promise<PipelineRun> {
    const run = await this.repository.getPipelineRun(id);
    if (run === undefined) {
      throw new DashboardApiError("NOT_FOUND", `Pipeline run ${id} was not found`);
    }
    return run;
  }

  private summary(run: PipelineRun): ReviewSummary {
    return {
      pipelineRunId: run.id,
      stage: run.stage,
      status: run.workStatus,
      version: run.version,
    };
  }
}

export function isDashboardConflict(error: unknown): boolean {
  return (
    (error instanceof DashboardApiError && error.code === "CONFLICT") ||
    (error instanceof PipelineCommandError && error.code === "CONFLICT")
  );
}
