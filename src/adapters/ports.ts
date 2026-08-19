import type {
  Claim,
  ComplianceResult,
  ContentDraft,
  DraftRevision,
  PlatformArtifact,
  ReproducibilityMetadata,
  ResearchResult,
  Topic,
  VerificationFinding,
  VerificationReport,
} from "../domain/content.js";
import type {
  ApprovalRecord,
  DeliveryCommand,
  DeliveryOutcome,
  DeliveryRecord,
  PipelineRun,
  PipelineTransition,
  WorkStatus,
  WorkflowStage,
} from "../domain/workflow.js";
import type {
  FetchPage,
  SourceConfig,
  SourceCursor,
  SourcePermission,
} from "../domain/source.js";

/** Source adapters must retain and return durable cursors between pages. */
/**
 * A refusal the source will keep repeating until its window resets.
 *
 * Retrying one is worse than useless: each attempt spends budget the source is waiting to
 * give back, and it cannot succeed before the reset. A live run halved its own GitHub
 * search allowance this way — every page was fetched twice, once to fail and once to fail
 * again a few milliseconds later.
 */
export function isRateLimitRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status } = error as { status?: unknown };
  return status === 403 || status === 429;
}

export interface SourceFetcher {
  fetch(
    source: SourceConfig,
    cursor: SourceCursor | undefined,
    signal: AbortSignal,
  ): Promise<FetchPage>;
  isAllowed(source: SourceConfig): Promise<SourcePermission>;
}

export interface ModelCallControl {
  readonly signal: AbortSignal;
  /** Absolute UTC deadline in ISO-8601 form. */
  readonly deadlineAt: string;
}

export interface ModelAGenerationRequest {
  readonly topic: Topic;
  readonly research: ResearchResult;
  readonly inputHash: string;
  /** Exact provider/model/prompt/configuration requested for reproducibility. */
  readonly requestedModel: ReproducibilityMetadata;
  readonly language: string;
  readonly brandVoiceVersion?: string;
}

export interface ModelAGenerationResponse {
  readonly content: ContentDraft;
  readonly provenance: ReproducibilityMetadata;
}

/** Independently injectable Model A generation capability. */
export interface ModelAGenerationPort {
  generate(
    request: ModelAGenerationRequest,
    control: ModelCallControl,
  ): Promise<ModelAGenerationResponse>;
}

export interface ModelBCritiqueRequest {
  readonly revision: DraftRevision;
  readonly claims: readonly Claim[];
  readonly research: ResearchResult;
  readonly round: number;
  /** Exact provider/model/prompt/configuration requested for reproducibility. */
  readonly requestedModel: ReproducibilityMetadata;
}

export interface ModelBCritiqueResponse {
  readonly findings: readonly VerificationFinding[];
  readonly provenance: ReproducibilityMetadata;
}

/** Independently injectable Model B critique capability. */
export interface ModelBCritiquePort {
  critique(
    request: ModelBCritiqueRequest,
    control: ModelCallControl,
  ): Promise<ModelBCritiqueResponse>;
}

/** Immutable records persisted in the same transaction as a state transition. */
export interface TransitionRecords {
  readonly topics?: readonly Topic[];
  readonly researchResults?: readonly ResearchResult[];
  readonly draftRevisions?: readonly DraftRevision[];
  readonly verificationReports?: readonly VerificationReport[];
  readonly platformArtifacts?: readonly PlatformArtifact[];
  readonly complianceResults?: readonly ComplianceResult[];
  readonly approvals?: readonly ApprovalRecord[];
  readonly deliveries?: readonly DeliveryRecord[];
}

export interface CreatePipelineRunCommand {
  readonly run: PipelineRun;
  readonly topic: Topic;
  readonly idempotencyKey: string;
}

export interface ExpectedPipelineState {
  readonly pipelineRunId: string;
  readonly expectedVersion: number;
  readonly expectedStage: WorkflowStage;
  readonly expectedStatus: WorkStatus;
}

export interface GuardedTransitionCommand extends ExpectedPipelineState {
  readonly nextStage: WorkflowStage;
  readonly nextStatus: WorkStatus;
  readonly nextActiveDraftRevisionId?: string;
  readonly blockedReason?: string;
  readonly actorType: "System" | "Operator";
  readonly actorId?: string;
  readonly reason?: string;
  readonly artifactRevisionId?: string;
  readonly records: TransitionRecords;
  readonly idempotencyKey: string;
}

export type GuardedTransitionOutcome =
  | {
      readonly kind: "Applied" | "Replayed";
      readonly run: PipelineRun;
      readonly transition: PipelineTransition;
    }
  | {
      readonly kind: "Conflict";
      readonly current: PipelineRun | undefined;
    };

export interface IdempotentDeliveryWrite {
  readonly record: DeliveryRecord;
  readonly replayed: boolean;
}

/**
 * Persistence boundary. Implementations must treat revisions, reports, artifacts,
 * approvals, transitions, and delivery identity fields as append-only.
 */
export interface Repository {
  createPipelineRun(command: CreatePipelineRunCommand): Promise<PipelineRun>;
  getTopic(id: string): Promise<Topic | undefined>;
  getResearchResult(id: string): Promise<ResearchResult | undefined>;
  getDraftRevision(id: string): Promise<DraftRevision | undefined>;
  getVerificationReport(id: string): Promise<VerificationReport | undefined>;
  getPlatformArtifact(id: string): Promise<PlatformArtifact | undefined>;
  getComplianceResult(id: string): Promise<ComplianceResult | undefined>;
  getApproval(id: string): Promise<ApprovalRecord | undefined>;
  getPipelineRun(id: string): Promise<PipelineRun | undefined>;
  listPipelineRuns(): Promise<readonly PipelineRun[]>;
  listVerificationReportsByDraftRevision(
    draftRevisionId: string,
  ): Promise<readonly VerificationReport[]>;
  listPlatformArtifactsByDraftRevision(
    draftRevisionId: string,
  ): Promise<readonly PlatformArtifact[]>;
  listComplianceResultsByDraftRevision(
    draftRevisionId: string,
  ): Promise<readonly ComplianceResult[]>;
  listApprovalsByPipelineRun(
    pipelineRunId: string,
  ): Promise<readonly ApprovalRecord[]>;
  listTransitions(pipelineRunId: string): Promise<readonly PipelineTransition[]>;
  getDelivery(id: string): Promise<DeliveryRecord | undefined>;
  getDeliveryByIdempotencyKey(key: string): Promise<DeliveryRecord | undefined>;
  listDeliveriesByApproval(
    approvalId: string,
  ): Promise<readonly DeliveryRecord[]>;

  /** Atomically checks expected state/version, appends records/transition, and updates the run. */
  commitGuardedTransition(
    command: GuardedTransitionCommand,
  ): Promise<GuardedTransitionOutcome>;

  /** Idempotently inserts or returns the logical delivery identified by its key. */
  recordDelivery(record: DeliveryRecord): Promise<IdempotentDeliveryWrite>;
}

export interface OutputPort {
  deliver(command: DeliveryCommand): Promise<DeliveryOutcome>;
}
