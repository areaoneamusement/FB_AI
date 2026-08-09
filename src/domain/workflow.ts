import type { TargetPlatform } from "./content.js";

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
