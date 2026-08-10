import { createHash } from "node:crypto";
import type { OutputPort, Repository } from "../adapters/ports.js";
import type { PlatformArtifact } from "../domain/content.js";
import type {
  ApprovalRecord,
  DeliveryCommand,
  DeliveryOutcome,
  DeliveryRecord,
  ExportBundle,
  PipelineRun,
} from "../domain/workflow.js";

export interface CopyReadyExporterOptions {
  readonly now?: () => string;
}

const YOUTUBE_METADATA_FIELDS = ["title", "description", "tags"] as const;

function failed(errorCode: string, errorMessage: string): DeliveryOutcome {
  return { status: "Failed", errorCode, errorMessage };
}

function stableExportId(idempotencyKey: string): string {
  return `export-${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Phase 1 OutputPort. It packages immutable artifact fields for manual copying;
 * it never reads a mutable draft or renders content after approval.
 */
export class CopyReadyExporter implements OutputPort {
  private readonly now: () => string;

  constructor(
    private readonly repository: Repository,
    options: CopyReadyExporterOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async deliver(command: DeliveryCommand): Promise<DeliveryOutcome> {
    const validationFailure = this.validateCommand(command);
    if (validationFailure !== undefined) return validationFailure;

    const replay = await this.repository.getDeliveryByIdempotencyKey(
      command.idempotencyKey,
    );
    if (replay !== undefined) return this.replayOutcome(replay, command);

    const [approval, artifact] = await Promise.all([
      this.repository.getApproval(command.approvalId),
      this.repository.getPlatformArtifact(command.artifactId),
    ]);
    if (approval === undefined) {
      return failed("APPROVAL_NOT_FOUND", "Approval record was not found");
    }
    if (artifact === undefined) {
      return failed("ARTIFACT_NOT_FOUND", "Platform artifact was not found");
    }

    const run = await this.repository.getPipelineRun(approval.pipelineRunId);
    const authorizationFailure = this.authorize(
      command,
      approval,
      artifact,
      run,
    );
    if (authorizationFailure !== undefined) return authorizationFailure;

    const artifactFailure = this.validateCopyReadyArtifact(artifact);
    if (artifactFailure !== undefined) return artifactFailure;

    const createdAt = this.now();
    const id = stableExportId(command.idempotencyKey);
    const bundle: ExportBundle = {
      id,
      platform: artifact.platform,
      targetId: command.targetId,
      approvalId: approval.id,
      artifactId: artifact.id,
      artifactHash: artifact.artifactHash,
      rendererVersion: artifact.rendererVersion,
      body: artifact.body,
      metadata: { ...artifact.metadata },
      attribution: artifact.attribution,
      imageSuggestions: artifact.imageSuggestions.map((suggestion) => ({
        ...suggestion,
      })),
      createdAt,
    };
    const record: DeliveryRecord = {
      id,
      kind: "Export",
      platform: artifact.platform,
      targetId: command.targetId,
      approvalId: approval.id,
      artifactId: artifact.id,
      artifactHash: artifact.artifactHash,
      idempotencyKey: command.idempotencyKey,
      status: "Exported",
      attempts: 1,
      exportBundle: bundle,
      createdAt,
      updatedAt: createdAt,
    };

    try {
      const write = await this.repository.recordDelivery(record);
      return this.replayOutcome(write.record, command);
    } catch (error: unknown) {
      return failed(
        "EXPORT_PERSISTENCE_FAILED",
        error instanceof Error ? error.message : "Export persistence failed",
      );
    }
  }

  /** Loads an exported bundle by the ID returned from deliver. */
  async getExportBundle(id: string): Promise<ExportBundle | undefined> {
    const record = await this.repository.getDelivery(id);
    return record?.kind === "Export" ? record.exportBundle : undefined;
  }

  private validateCommand(command: DeliveryCommand): DeliveryOutcome | undefined {
    if (
      !hasText(command.approvalId) ||
      !hasText(command.artifactId) ||
      !hasText(command.artifactHash) ||
      !hasText(command.targetId) ||
      !hasText(command.idempotencyKey)
    ) {
      return failed(
        "INVALID_DELIVERY_COMMAND",
        "Approval, artifact, hash, target, and idempotency key are required",
      );
    }
    return undefined;
  }

  private authorize(
    command: DeliveryCommand,
    approval: ApprovalRecord,
    artifact: PlatformArtifact,
    run: PipelineRun | undefined,
  ): DeliveryOutcome | undefined {
    if (
      run?.stage !== "Approved" ||
      run.activeDraftRevisionId !== approval.draftRevisionId
    ) {
      return failed(
        "CONTENT_NOT_APPROVED",
        "Content is not approved for output or delivery",
      );
    }

    const artifactIndex = approval.approvedArtifactIds.indexOf(artifact.id);
    if (
      artifactIndex < 0 ||
      approval.approvedArtifactHashes.length !==
        approval.approvedArtifactIds.length ||
      approval.approvedArtifactHashes[artifactIndex] !== command.artifactHash ||
      artifact.artifactHash !== command.artifactHash ||
      artifact.draftRevisionId !== approval.draftRevisionId
    ) {
      return failed(
        "APPROVAL_ARTIFACT_MISMATCH",
        "Artifact is not part of the exact approved artifact set",
      );
    }
    return undefined;
  }

  private validateCopyReadyArtifact(
    artifact: PlatformArtifact,
  ): DeliveryOutcome | undefined {
    if (!hasText(artifact.body) || !hasText(artifact.attribution)) {
      return failed(
        "ARTIFACT_NOT_COPY_READY",
        "Approved artifact body and origin attribution are required",
      );
    }
    if (artifact.platform === "YouTube") {
      const missing = YOUTUBE_METADATA_FIELDS.filter(
        (field) => !hasText(artifact.metadata[field]),
      );
      if (missing.length > 0) {
        return failed(
          "ARTIFACT_NOT_COPY_READY",
          `Approved YouTube artifact is missing metadata: ${missing.join(", ")}`,
        );
      }
    }
    return undefined;
  }

  private replayOutcome(
    record: DeliveryRecord,
    command: DeliveryCommand,
  ): DeliveryOutcome {
    if (
      record.kind !== "Export" ||
      record.status !== "Exported" ||
      record.approvalId !== command.approvalId ||
      record.artifactId !== command.artifactId ||
      record.artifactHash !== command.artifactHash ||
      record.targetId !== command.targetId ||
      record.exportBundle === undefined ||
      record.exportBundle.id !== record.id
    ) {
      return failed(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key is already bound to another delivery",
      );
    }
    return { status: "Exported", exportedBundleId: record.exportBundle.id };
  }
}
