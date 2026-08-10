import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import type {
  ComplianceResult,
  DraftRevision,
  PlatformArtifact,
  ResearchResult,
  Topic,
  VerificationReport,
} from "../domain/content.js";
import type {
  ApprovalRecord,
  DeliveryRecord,
  PipelineRun,
  PipelineTransition,
} from "../domain/workflow.js";
import type {
  CreatePipelineRunCommand,
  GuardedTransitionCommand,
  GuardedTransitionOutcome,
  IdempotentDeliveryWrite,
  Repository,
  TransitionRecords,
} from "../adapters/ports.js";

const MIGRATION_ID = "001_repository";
const MIGRATION_SQL = readFileSync(
  new URL("./migrations/001_repository.sql", import.meta.url),
  "utf8",
);

interface PayloadRow { readonly payload: string }
interface RunRow extends PayloadRow { readonly create_idempotency_key: string }
interface TransitionRow extends PayloadRow { readonly result_run_payload: string }

export class RepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryConflictError";
  }
}

export interface SqliteRepositoryOptions {
  readonly now?: () => string;
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function decode<T>(value: string): T {
  return JSON.parse(value) as T;
}

export class SqliteRepository implements Repository {
  private readonly database: Database.Database;
  private readonly now: () => string;

  constructor(
    database: Database.Database | string = ":memory:",
    options: SqliteRepositoryOptions = {},
  ) {
    this.database =
      typeof database === "string" ? new Database(database) : database;
    this.now = options.now ?? (() => new Date().toISOString());
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.applyMigrations();
  }

  close(): void {
    this.database.close();
  }

  async createPipelineRun(
    command: CreatePipelineRunCommand,
  ): Promise<PipelineRun> {
    return this.database.transaction((value: CreatePipelineRunCommand) => {
      if (value.run.topicId !== value.topic.id) {
        throw new RepositoryConflictError("Pipeline run topic binding is invalid");
      }
      const existing = this.database
        .prepare("SELECT payload, create_idempotency_key FROM pipeline_runs WHERE id = ?")
        .get(value.run.id) as RunRow | undefined;
      if (existing !== undefined) {
        if (existing.create_idempotency_key === value.idempotencyKey) {
          return decode<PipelineRun>(existing.payload);
        }
        throw new RepositoryConflictError(
          `Pipeline run ${value.run.id} already exists with another idempotency key`,
        );
      }
      this.insertTopic(value.topic);
      this.database.prepare(
        "INSERT INTO pipeline_runs (id, topic_id, active_draft_revision_id, stage, work_status, version, create_idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        value.run.id,
        value.run.topicId,
        value.run.activeDraftRevisionId ?? null,
        value.run.stage,
        value.run.workStatus,
        value.run.version,
        value.idempotencyKey,
        encode(value.run),
      );
      return value.run;
    })(command);
  }

  async getTopic(id: string): Promise<Topic | undefined> {
    return this.getPayload<Topic>("topics", id);
  }

  async getResearchResult(id: string): Promise<ResearchResult | undefined> {
    return this.getPayload<ResearchResult>("research_results", id);
  }

  async getDraftRevision(id: string): Promise<DraftRevision | undefined> {
    return this.getPayload<DraftRevision>("draft_revisions", id);
  }

  async getVerificationReport(id: string): Promise<VerificationReport | undefined> {
    return this.getPayload<VerificationReport>("verification_reports", id);
  }

  async getPlatformArtifact(id: string): Promise<PlatformArtifact | undefined> {
    return this.getPayload<PlatformArtifact>("platform_artifacts", id);
  }

  async getComplianceResult(id: string): Promise<ComplianceResult | undefined> {
    return this.getPayload<ComplianceResult>("compliance_results", id);
  }

  async getApproval(id: string): Promise<ApprovalRecord | undefined> {
    return this.getPayload<ApprovalRecord>("approvals", id);
  }

  async getPipelineRun(id: string): Promise<PipelineRun | undefined> {
    return this.getPayload<PipelineRun>("pipeline_runs", id);
  }

  async listTransitions(
    pipelineRunId: string,
  ): Promise<readonly PipelineTransition[]> {
    const rows = this.database
      .prepare("SELECT payload FROM pipeline_transitions WHERE pipeline_run_id = ? ORDER BY rowid")
      .all(pipelineRunId) as PayloadRow[];
    return rows.map((row) => decode<PipelineTransition>(row.payload));
  }

  async getDelivery(id: string): Promise<DeliveryRecord | undefined> {
    return this.getPayload<DeliveryRecord>("deliveries", id);
  }

  async getDeliveryByIdempotencyKey(
    key: string,
  ): Promise<DeliveryRecord | undefined> {
    const row = this.database
      .prepare("SELECT payload FROM deliveries WHERE idempotency_key = ?")
      .get(key) as PayloadRow | undefined;
    return row === undefined ? undefined : decode<DeliveryRecord>(row.payload);
  }

  async commitGuardedTransition(
    command: GuardedTransitionCommand,
  ): Promise<GuardedTransitionOutcome> {
    return this.database.transaction((value: GuardedTransitionCommand) => {
      const replay = this.database.prepare(
        "SELECT payload, result_run_payload FROM pipeline_transitions WHERE pipeline_run_id = ? AND idempotency_key = ?",
      ).get(value.pipelineRunId, value.idempotencyKey) as TransitionRow | undefined;
      if (replay !== undefined) {
        return {
          kind: "Replayed" as const,
          run: decode<PipelineRun>(replay.result_run_payload),
          transition: decode<PipelineTransition>(replay.payload),
        };
      }

      const current = this.getPayload<PipelineRun>("pipeline_runs", value.pipelineRunId);
      if (
        current === undefined ||
        current.version !== value.expectedVersion ||
        current.stage !== value.expectedStage ||
        current.workStatus !== value.expectedStatus
      ) {
        return { kind: "Conflict" as const, current };
      }

      this.insertTransitionRecords(value.records);
      const updated = this.updatedRun(current, value);
      const result = this.database.prepare(
        "UPDATE pipeline_runs SET active_draft_revision_id = ?, stage = ?, work_status = ?, version = ?, payload = ? WHERE id = ? AND version = ? AND stage = ? AND work_status = ?",
      ).run(
        updated.activeDraftRevisionId ?? null,
        updated.stage,
        updated.workStatus,
        updated.version,
        encode(updated),
        current.id,
        value.expectedVersion,
        value.expectedStage,
        value.expectedStatus,
      );
      if (result.changes !== 1) {
        throw new RepositoryConflictError("Guarded pipeline update lost its optimistic lock");
      }

      const transition = this.transitionFor(current, updated, value);
      this.database.prepare(
        "INSERT INTO pipeline_transitions (id, pipeline_run_id, from_stage, to_stage, from_status, to_status, idempotency_key, payload, result_run_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        transition.id,
        transition.pipelineRunId,
        transition.fromStage,
        transition.toStage,
        transition.fromStatus,
        transition.toStatus,
        transition.idempotencyKey,
        encode(transition),
        encode(updated),
      );
      return { kind: "Applied" as const, run: updated, transition };
    })(command);
  }

  async recordDelivery(record: DeliveryRecord): Promise<IdempotentDeliveryWrite> {
    return this.database.transaction((value: DeliveryRecord) =>
      this.insertDelivery(value),
    )(record);
  }

  private applyMigrations(): void {
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = this.database
      .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
      .get(MIGRATION_ID);
    if (applied !== undefined) return;
    this.database.transaction(() => {
      this.database.exec(MIGRATION_SQL);
      this.database.prepare(
        "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
      ).run(MIGRATION_ID, this.now());
    })();
  }

  private getPayload<T>(table: string, id: string): T | undefined {
    const allowed = new Set([
      "topics",
      "research_results",
      "draft_revisions",
      "verification_reports",
      "platform_artifacts",
      "compliance_results",
      "approvals",
      "pipeline_runs",
      "deliveries",
    ]);
    if (!allowed.has(table)) throw new Error(`Unsupported repository table ${table}`);
    const row = this.database
      .prepare(`SELECT payload FROM ${table} WHERE id = ?`)
      .get(id) as PayloadRow | undefined;
    return row === undefined ? undefined : decode<T>(row.payload);
  }

  private updatedRun(
    current: PipelineRun,
    command: GuardedTransitionCommand,
  ): PipelineRun {
    const activeDraftRevisionId =
      command.nextActiveDraftRevisionId ?? current.activeDraftRevisionId;
    return {
      id: current.id,
      topicId: current.topicId,
      ...(activeDraftRevisionId === undefined ? {} : { activeDraftRevisionId }),
      stage: command.nextStage,
      workStatus: command.nextStatus,
      version: current.version + 1,
      categories: current.categories,
      ...(command.blockedReason === undefined
        ? {}
        : { blockedReason: command.blockedReason }),
      createdAt: current.createdAt,
      updatedAt: this.now(),
    };
  }

  private transitionFor(
    current: PipelineRun,
    updated: PipelineRun,
    command: GuardedTransitionCommand,
  ): PipelineTransition {
    return {
      id: `${current.id}:transition:${updated.version}`,
      pipelineRunId: current.id,
      fromStage: current.stage,
      toStage: updated.stage,
      fromStatus: current.workStatus,
      toStatus: updated.workStatus,
      actorType: command.actorType,
      ...(command.actorId === undefined ? {} : { actorId: command.actorId }),
      ...(command.artifactRevisionId === undefined
        ? {}
        : { artifactRevisionId: command.artifactRevisionId }),
      ...(command.reason === undefined ? {} : { reason: command.reason }),
      idempotencyKey: command.idempotencyKey,
      createdAt: this.now(),
    };
  }

  private insertTransitionRecords(records: TransitionRecords): void {
    for (const topic of records.topics ?? []) this.insertTopic(topic);
    for (const research of records.researchResults ?? []) this.insertResearch(research);
    for (const revision of records.draftRevisions ?? []) this.insertRevision(revision);
    for (const report of records.verificationReports ?? []) this.insertReport(report);
    for (const artifact of records.platformArtifacts ?? []) this.insertArtifact(artifact);
    for (const result of records.complianceResults ?? []) this.insertCompliance(result);
    for (const approval of records.approvals ?? []) this.insertApproval(approval);
    for (const delivery of records.deliveries ?? []) this.insertDelivery(delivery);
  }

  private insertTopic(topic: Topic): void {
    this.database.prepare(
      "INSERT INTO topics (id, source_id, external_id, payload) VALUES (?, ?, ?, ?)",
    ).run(topic.id, topic.sourceRef.sourceId, topic.externalId, encode(topic));
  }

  private insertResearch(result: ResearchResult): void {
    this.database.prepare(
      "INSERT INTO research_results (id, topic_id, payload) VALUES (?, ?, ?)",
    ).run(result.id, result.topicId, encode(result));
  }

  private insertRevision(revision: DraftRevision): void {
    this.database.prepare(
      "INSERT INTO draft_revisions (id, draft_id, revision, parent_revision_id, topic_id, content_hash, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      revision.id,
      revision.draftId,
      revision.revision,
      revision.parentRevisionId ?? null,
      revision.content.topicId,
      revision.contentHash,
      encode(revision),
    );
  }

  private insertReport(report: VerificationReport): void {
    this.database.prepare(
      "INSERT INTO verification_reports (id, draft_revision_id, research_result_id, content_hash, payload) VALUES (?, ?, ?, ?, ?)",
    ).run(
      report.id,
      report.draftRevisionId,
      report.researchResultId,
      report.contentHash,
      encode(report),
    );
  }

  private insertArtifact(artifact: PlatformArtifact): void {
    this.database.prepare(
      "INSERT INTO platform_artifacts (id, draft_revision_id, platform, artifact_hash, payload) VALUES (?, ?, ?, ?, ?)",
    ).run(
      artifact.id,
      artifact.draftRevisionId,
      artifact.platform,
      artifact.artifactHash,
      encode(artifact),
    );
  }

  private insertCompliance(result: ComplianceResult): void {
    this.database.prepare(
      "INSERT INTO compliance_results (id, artifact_id, draft_revision_id, artifact_hash, passed, payload) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      result.id,
      result.artifactId,
      result.draftRevisionId,
      result.artifactHash,
      result.passed ? 1 : 0,
      encode(result),
    );
  }

  private insertApproval(approval: ApprovalRecord): void {
    if (
      approval.approvedArtifactIds.length !==
      approval.approvedArtifactHashes.length
    ) {
      throw new RepositoryConflictError(
        "Approval artifact IDs and hashes must have equal lengths",
      );
    }
    this.database.prepare(
      "INSERT INTO approvals (id, pipeline_run_id, draft_revision_id, content_hash, payload) VALUES (?, ?, ?, ?, ?)",
    ).run(
      approval.id,
      approval.pipelineRunId,
      approval.draftRevisionId,
      approval.contentHash,
      encode(approval),
    );
    const statement = this.database.prepare(
      "INSERT INTO approval_artifacts (approval_id, ordinal, artifact_id, artifact_hash) VALUES (?, ?, ?, ?)",
    );
    approval.approvedArtifactIds.forEach((artifactId, ordinal) => {
      statement.run(
        approval.id,
        ordinal,
        artifactId,
        approval.approvedArtifactHashes[ordinal],
      );
    });
  }

  private insertDelivery(record: DeliveryRecord): IdempotentDeliveryWrite {
    const existing = this.database
      .prepare("SELECT payload FROM deliveries WHERE idempotency_key = ?")
      .get(record.idempotencyKey) as PayloadRow | undefined;
    if (existing !== undefined) {
      return { record: decode<DeliveryRecord>(existing.payload), replayed: true };
    }
    this.database.prepare(
      "INSERT INTO deliveries (id, approval_id, artifact_id, artifact_hash, platform, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      record.id,
      record.approvalId,
      record.artifactId,
      record.artifactHash,
      record.platform,
      record.idempotencyKey,
      encode(record),
    );
    return { record, replayed: false };
  }
}
