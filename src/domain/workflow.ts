import type {
  ComplianceResult,
  DraftRevision,
  PlatformArtifact,
  TargetPlatform,
  VerificationReport,
} from "./content.js";

export type WorkflowStage =
  | "Collected"
  | "Scored"
  | "Researched"
  | "Generated"
  | "Verified"
  | "ComplianceChecked"
  | "PendingApproval"
  | "Approved"
  | "Rejected";

/** Canonical content-maturity order. Rejected is terminal; publication is delivery state. */
export const SUCCESSFUL_WORKFLOW_STAGES = [
  "Collected",
  "Scored",
  "Researched",
  "Generated",
  "Verified",
  "ComplianceChecked",
  "PendingApproval",
  "Approved",
] as const satisfies readonly WorkflowStage[];

export type SuccessfulWorkflowStage =
  (typeof SUCCESSFUL_WORKFLOW_STAGES)[number];

export const WORKFLOW_STAGE_INDEX = Object.freeze({
  Collected: 0,
  Scored: 1,
  Researched: 2,
  Generated: 3,
  Verified: 4,
  ComplianceChecked: 5,
  PendingApproval: 6,
  Approved: 7,
}) satisfies Readonly<Record<SuccessfulWorkflowStage, number>>;

export type WorkStatus =
  | "Ready"
  | "InProgress"
  | "RetryableBlocked"
  | "Unscored"
  | "InsufficientData"
  | "VerificationBlocked"
  | "ComplianceFailed"
  | "Rejected";

export interface PipelineRun {
  readonly id: string;
  readonly topicId: string;
  readonly activeDraftRevisionId?: string;
  readonly stage: WorkflowStage;
  readonly workStatus: WorkStatus;
  readonly version: number;
  readonly categories: readonly string[];
  readonly blockedReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PipelineTransition {
  readonly id: string;
  readonly pipelineRunId: string;
  readonly fromStage: WorkflowStage;
  readonly toStage: WorkflowStage;
  readonly fromStatus: WorkStatus;
  readonly toStatus: WorkStatus;
  readonly actorType: "System" | "Operator";
  readonly actorId?: string;
  readonly artifactRevisionId?: string;
  readonly reason?: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface ApprovalCommand {
  readonly operatorId: string;
  readonly draftRevisionId: string;
  readonly contentHash: string;
  readonly artifactIds: readonly string[];
  readonly artifactHashes: readonly string[];
  readonly confirmed: true;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly pipelineRunId: string;
  readonly draftRevisionId: string;
  readonly contentHash: string;
  readonly approvedArtifactIds: readonly string[];
  readonly approvedArtifactHashes: readonly string[];
  readonly operatorId: string;
  readonly approvedAt: string;
}

export interface ReviewQueueFilter {
  readonly status?: WorkStatus;
  readonly platform?: TargetPlatform;
}

export interface ReviewSummary {
  readonly pipelineRunId: string;
  readonly stage: WorkflowStage;
  readonly status: WorkStatus;
  readonly version: number;
}

export interface ReviewPackage {
  readonly run: PipelineRun;
  readonly revision: DraftRevision;
  readonly verification: VerificationReport;
  readonly artifacts: readonly PlatformArtifact[];
  readonly compliance: readonly ComplianceResult[];
}

export type DeliveryKind = "Export" | "Publish";
export type DeliveryStatus =
  | "Pending"
  | "Exported"
  | "Publishing"
  | "Published"
  | "Deferred"
  | "Failed"
  | "Cancelled";

export interface DeliveryCommand {
  readonly approvalId: string;
  readonly artifactId: string;
  readonly artifactHash: string;
  readonly targetId: string;
  readonly idempotencyKey: string;
}

export interface DeliveryOutcome {
  readonly status: DeliveryStatus;
  readonly externalId?: string;
  readonly externalUrl?: string;
  readonly exportedBundleId?: string;
  readonly retryAt?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface DeliveryRecord {
  readonly id: string;
  readonly kind: DeliveryKind;
  readonly platform: TargetPlatform;
  readonly targetId: string;
  readonly approvalId: string;
  readonly artifactId: string;
  readonly artifactHash: string;
  readonly idempotencyKey: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt?: string;
  readonly externalId?: string;
  readonly externalUrl?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
