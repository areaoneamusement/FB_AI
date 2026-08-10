import type {
  CreatePipelineRunCommand,
  GuardedTransitionCommand,
  GuardedTransitionOutcome,
  IdempotentDeliveryWrite,
  Repository,
  TransitionRecords,
} from "./ports.js";
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

export class InMemoryRepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InMemoryRepositoryConflictError";
  }
}

export interface InMemoryRepositoryOptions {
  readonly now?: () => string;
}

interface TransitionReplay {
  readonly run: PipelineRun;
  readonly transition: PipelineTransition;
}

interface RepositoryState {
  topics: Map<string, Topic>;
  sourceItems: Map<string, string>;
  researchResults: Map<string, ResearchResult>;
  draftRevisions: Map<string, DraftRevision>;
  draftRevisionNumbers: Map<string, string>;
  verificationReports: Map<string, VerificationReport>;
  platformArtifacts: Map<string, PlatformArtifact>;
  complianceResults: Map<string, ComplianceResult>;
  approvals: Map<string, ApprovalRecord>;
  pipelineRuns: Map<string, PipelineRun>;
  createKeys: Map<string, string>;
  transitions: Map<string, PipelineTransition[]>;
  transitionReplays: Map<string, TransitionReplay>;
  deliveries: Map<string, DeliveryRecord>;
  deliveryKeys: Map<string, string>;
}
function emptyState(): RepositoryState {
  return {
    topics: new Map(),
    sourceItems: new Map(),
    researchResults: new Map(),
    draftRevisions: new Map(),
    draftRevisionNumbers: new Map(),
    verificationReports: new Map(),
    platformArtifacts: new Map(),
    complianceResults: new Map(),
    approvals: new Map(),
    pipelineRuns: new Map(),
    createKeys: new Map(),
    transitions: new Map(),
    transitionReplays: new Map(),
    deliveries: new Map(),
    deliveryKeys: new Map(),
  };
}

function copyState(state: RepositoryState): RepositoryState {
  return {
    topics: new Map(state.topics),
    sourceItems: new Map(state.sourceItems),
    researchResults: new Map(state.researchResults),
    draftRevisions: new Map(state.draftRevisions),
    draftRevisionNumbers: new Map(state.draftRevisionNumbers),
    verificationReports: new Map(state.verificationReports),
    platformArtifacts: new Map(state.platformArtifacts),
    complianceResults: new Map(state.complianceResults),
    approvals: new Map(state.approvals),
    pipelineRuns: new Map(state.pipelineRuns),
    createKeys: new Map(state.createKeys),
    transitions: new Map(
      [...state.transitions].map(([id, transitions]) => [id, [...transitions]]),
    ),
    transitionReplays: new Map(state.transitionReplays),
    deliveries: new Map(state.deliveries),
    deliveryKeys: new Map(state.deliveryKeys),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireAbsent<T>(map: Map<string, T>, id: string, label: string): void {
  if (map.has(id)) {
    throw new InMemoryRepositoryConflictError(`${label} ${id} already exists`);
  }
}

function requireRecord<T>(
  map: Map<string, T>,
  id: string,
  label: string,
): T {
  const value = map.get(id);
  if (value === undefined) {
    throw new InMemoryRepositoryConflictError(`${label} ${id} does not exist`);
  }
  return value;
}

function transitionKey(runId: string, idempotencyKey: string): string {
  return `${runId}\u0000${idempotencyKey}`;
}

function sourceItemKey(topic: Topic): string {
  return `${topic.sourceRef.sourceId}\u0000${topic.externalId}`;
}

function revisionNumberKey(revision: DraftRevision): string {
  return `${revision.draftId}\u0000${revision.revision}`;
}
export class InMemoryRepository implements Repository {
  private state = emptyState();
  private readonly now: () => string;

  constructor(options: InMemoryRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async createPipelineRun(
    command: CreatePipelineRunCommand,
  ): Promise<PipelineRun> {
    if (command.run.topicId !== command.topic.id) {
      throw new InMemoryRepositoryConflictError(
        "Pipeline run topic binding is invalid",
      );
    }
    const existing = this.state.pipelineRuns.get(command.run.id);
    if (existing !== undefined) {
      if (this.state.createKeys.get(command.run.id) === command.idempotencyKey) {
        return clone(existing);
      }
      throw new InMemoryRepositoryConflictError(
        `Pipeline run ${command.run.id} already exists with another idempotency key`,
      );
    }

    const next = copyState(this.state);
    this.insertTopic(next, command.topic);
    requireAbsent(next.pipelineRuns, command.run.id, "Pipeline run");
    this.validateActiveRevision(next, command.run);
    next.pipelineRuns.set(command.run.id, clone(command.run));
    next.createKeys.set(command.run.id, command.idempotencyKey);
    this.state = next;
    return clone(command.run);
  }

  async getTopic(id: string): Promise<Topic | undefined> {
    return this.get(this.state.topics, id);
  }

  async getResearchResult(id: string): Promise<ResearchResult | undefined> {
    return this.get(this.state.researchResults, id);
  }

  async getDraftRevision(id: string): Promise<DraftRevision | undefined> {
    return this.get(this.state.draftRevisions, id);
  }

  async getVerificationReport(id: string): Promise<VerificationReport | undefined> {
    return this.get(this.state.verificationReports, id);
  }

  async getPlatformArtifact(id: string): Promise<PlatformArtifact | undefined> {
    return this.get(this.state.platformArtifacts, id);
  }

  async getComplianceResult(id: string): Promise<ComplianceResult | undefined> {
    return this.get(this.state.complianceResults, id);
  }

  async getApproval(id: string): Promise<ApprovalRecord | undefined> {
    return this.get(this.state.approvals, id);
  }

  async getPipelineRun(id: string): Promise<PipelineRun | undefined> {
    return this.get(this.state.pipelineRuns, id);
  }

  async listPipelineRuns(): Promise<readonly PipelineRun[]> {
    return clone([...this.state.pipelineRuns.values()]);
  }

  async listVerificationReportsByDraftRevision(
    draftRevisionId: string,
  ): Promise<readonly VerificationReport[]> {
    return clone([...this.state.verificationReports.values()].filter(
      (report) => report.draftRevisionId === draftRevisionId,
    ));
  }

  async listPlatformArtifactsByDraftRevision(
    draftRevisionId: string,
  ): Promise<readonly PlatformArtifact[]> {
    return clone([...this.state.platformArtifacts.values()].filter(
      (artifact) => artifact.draftRevisionId === draftRevisionId,
    ));
  }

  async listComplianceResultsByDraftRevision(
    draftRevisionId: string,
  ): Promise<readonly ComplianceResult[]> {
    return clone([...this.state.complianceResults.values()].filter(
      (result) => result.draftRevisionId === draftRevisionId,
    ));
  }

  async listApprovalsByPipelineRun(
    pipelineRunId: string,
  ): Promise<readonly ApprovalRecord[]> {
    return clone([...this.state.approvals.values()].filter(
      (approval) => approval.pipelineRunId === pipelineRunId,
    ));
  }

  async listTransitions(
    pipelineRunId: string,
  ): Promise<readonly PipelineTransition[]> {
    return clone(this.state.transitions.get(pipelineRunId) ?? []);
  }

  async getDelivery(id: string): Promise<DeliveryRecord | undefined> {
    return this.get(this.state.deliveries, id);
  }

  async getDeliveryByIdempotencyKey(
    key: string,
  ): Promise<DeliveryRecord | undefined> {
    const id = this.state.deliveryKeys.get(key);
    return id === undefined ? undefined : this.get(this.state.deliveries, id);
  }

  async listDeliveriesByApproval(
    approvalId: string,
  ): Promise<readonly DeliveryRecord[]> {
    return clone([...this.state.deliveries.values()].filter(
      (delivery) => delivery.approvalId === approvalId,
    ));
  }

  async commitGuardedTransition(
    command: GuardedTransitionCommand,
  ): Promise<GuardedTransitionOutcome> {
    const replay = this.state.transitionReplays.get(
      transitionKey(command.pipelineRunId, command.idempotencyKey),
    );
    if (replay !== undefined) {
      return {
        kind: "Replayed",
        run: clone(replay.run),
        transition: clone(replay.transition),
      };
    }

    const current = this.state.pipelineRuns.get(command.pipelineRunId);
    if (
      current === undefined ||
      current.version !== command.expectedVersion ||
      current.stage !== command.expectedStage ||
      current.workStatus !== command.expectedStatus
    ) {
      return {
        kind: "Conflict",
        current: current === undefined ? undefined : clone(current),
      };
    }

    const next = copyState(this.state);
    this.insertTransitionRecords(next, command.records);
    const updated = this.updatedRun(current, command);
    this.validateActiveRevision(next, updated);
    next.pipelineRuns.set(updated.id, clone(updated));
    const transition = this.transitionFor(current, updated, command);
    requireAbsent(
      new Map(
        [...next.transitions.values()].flat().map((item) => [item.id, item]),
      ),
      transition.id,
      "Pipeline transition",
    );
    next.transitions.set(updated.id, [
      ...(next.transitions.get(updated.id) ?? []),
      clone(transition),
    ]);
    next.transitionReplays.set(
      transitionKey(updated.id, command.idempotencyKey),
      { run: clone(updated), transition: clone(transition) },
    );
    this.state = next;
    return { kind: "Applied", run: clone(updated), transition: clone(transition) };
  }

  async recordDelivery(record: DeliveryRecord): Promise<IdempotentDeliveryWrite> {
    const existingId = this.state.deliveryKeys.get(record.idempotencyKey);
    if (existingId !== undefined) {
      return {
        record: clone(requireRecord(this.state.deliveries, existingId, "Delivery")),
        replayed: true,
      };
    }
    const next = copyState(this.state);
    this.insertDelivery(next, record);
    this.state = next;
    return { record: clone(record), replayed: false };
  }

  private get<T>(map: Map<string, T>, id: string): T | undefined {
    const value = map.get(id);
    return value === undefined ? undefined : clone(value);
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

  private validateActiveRevision(
    state: RepositoryState,
    run: PipelineRun,
  ): void {
    if (run.activeDraftRevisionId === undefined) return;
    const revision = requireRecord(
      state.draftRevisions,
      run.activeDraftRevisionId,
      "Draft revision",
    );
    if (revision.content.topicId !== run.topicId) {
      throw new InMemoryRepositoryConflictError(
        "Active revision topic binding is invalid",
      );
    }
  }

  private insertTransitionRecords(
    state: RepositoryState,
    records: TransitionRecords,
  ): void {
    for (const topic of records.topics ?? []) this.insertTopic(state, topic);
    for (const research of records.researchResults ?? []) {
      this.insertResearch(state, research);
    }
    for (const revision of records.draftRevisions ?? []) {
      this.insertRevision(state, revision);
    }
    for (const report of records.verificationReports ?? []) {
      this.insertReport(state, report);
    }
    for (const artifact of records.platformArtifacts ?? []) {
      this.insertArtifact(state, artifact);
    }
    for (const result of records.complianceResults ?? []) {
      this.insertCompliance(state, result);
    }
    for (const approval of records.approvals ?? []) {
      this.insertApproval(state, approval);
    }
    for (const delivery of records.deliveries ?? []) {
      this.insertDelivery(state, delivery);
    }
  }

  private insertTopic(state: RepositoryState, topic: Topic): void {
    requireAbsent(state.topics, topic.id, "Topic");
    const sourceKey = sourceItemKey(topic);
    if (state.sourceItems.has(sourceKey)) {
      throw new InMemoryRepositoryConflictError(
        `Source item ${topic.sourceRef.sourceId}/${topic.externalId} already exists`,
      );
    }
    state.topics.set(topic.id, clone(topic));
    state.sourceItems.set(sourceKey, topic.id);
  }

  private insertResearch(
    state: RepositoryState,
    result: ResearchResult,
  ): void {
    requireAbsent(state.researchResults, result.id, "Research result");
    requireRecord(state.topics, result.topicId, "Topic");
    state.researchResults.set(result.id, clone(result));
  }

  private insertRevision(
    state: RepositoryState,
    revision: DraftRevision,
  ): void {
    requireAbsent(state.draftRevisions, revision.id, "Draft revision");
    if (!Number.isInteger(revision.revision) || revision.revision <= 0) {
      throw new InMemoryRepositoryConflictError(
        "Draft revision number must be a positive integer",
      );
    }
    const numberKey = revisionNumberKey(revision);
    if (state.draftRevisionNumbers.has(numberKey)) {
      throw new InMemoryRepositoryConflictError(
        `Draft revision ${revision.draftId}/${revision.revision} already exists`,
      );
    }
    requireRecord(state.topics, revision.content.topicId, "Topic");
    if (revision.parentRevisionId !== undefined) {
      requireRecord(
        state.draftRevisions,
        revision.parentRevisionId,
        "Parent draft revision",
      );
    }
    state.draftRevisions.set(revision.id, clone(revision));
    state.draftRevisionNumbers.set(numberKey, revision.id);
  }

  private insertReport(
    state: RepositoryState,
    report: VerificationReport,
  ): void {
    requireAbsent(state.verificationReports, report.id, "Verification report");
    const revision = requireRecord(
      state.draftRevisions,
      report.draftRevisionId,
      "Draft revision",
    );
    requireRecord(state.researchResults, report.researchResultId, "Research result");
    if (revision.contentHash !== report.contentHash) {
      throw new InMemoryRepositoryConflictError(
        "Verification report content hash mismatch",
      );
    }
    state.verificationReports.set(report.id, clone(report));
  }
  private insertArtifact(
    state: RepositoryState,
    artifact: PlatformArtifact,
  ): void {
    requireAbsent(state.platformArtifacts, artifact.id, "Platform artifact");
    requireRecord(
      state.draftRevisions,
      artifact.draftRevisionId,
      "Draft revision",
    );
    state.platformArtifacts.set(artifact.id, clone(artifact));
  }

  private insertCompliance(
    state: RepositoryState,
    result: ComplianceResult,
  ): void {
    requireAbsent(state.complianceResults, result.id, "Compliance result");
    const artifact = requireRecord(
      state.platformArtifacts,
      result.artifactId,
      "Platform artifact",
    );
    if (
      artifact.draftRevisionId !== result.draftRevisionId ||
      artifact.artifactHash !== result.artifactHash ||
      artifact.platform !== result.platform
    ) {
      throw new InMemoryRepositoryConflictError(
        "Compliance result artifact binding mismatch",
      );
    }
    state.complianceResults.set(result.id, clone(result));
  }

  private insertApproval(
    state: RepositoryState,
    approval: ApprovalRecord,
  ): void {
    requireAbsent(state.approvals, approval.id, "Approval");
    requireRecord(state.pipelineRuns, approval.pipelineRunId, "Pipeline run");
    const revision = requireRecord(
      state.draftRevisions,
      approval.draftRevisionId,
      "Draft revision",
    );
    if (revision.contentHash !== approval.contentHash) {
      throw new InMemoryRepositoryConflictError("Approval content hash mismatch");
    }
    if (
      approval.approvedArtifactIds.length !==
      approval.approvedArtifactHashes.length
    ) {
      throw new InMemoryRepositoryConflictError(
        "Approval artifact IDs and hashes must have equal lengths",
      );
    }
    if (new Set(approval.approvedArtifactIds).size !== approval.approvedArtifactIds.length) {
      throw new InMemoryRepositoryConflictError(
        "Approval cannot contain a duplicate artifact",
      );
    }
    approval.approvedArtifactIds.forEach((artifactId, index) => {
      const artifact = requireRecord(
        state.platformArtifacts,
        artifactId,
        "Platform artifact",
      );
      if (
        artifact.draftRevisionId !== approval.draftRevisionId ||
        artifact.artifactHash !== approval.approvedArtifactHashes[index]
      ) {
        throw new InMemoryRepositoryConflictError(
          "Approval artifact binding mismatch",
        );
      }
    });
    state.approvals.set(approval.id, clone(approval));
  }
  private insertDelivery(
    state: RepositoryState,
    record: DeliveryRecord,
  ): IdempotentDeliveryWrite {
    const existingId = state.deliveryKeys.get(record.idempotencyKey);
    if (existingId !== undefined) {
      return {
        record: clone(requireRecord(state.deliveries, existingId, "Delivery")),
        replayed: true,
      };
    }
    requireAbsent(state.deliveries, record.id, "Delivery");
    const approval = requireRecord(
      state.approvals,
      record.approvalId,
      "Approval",
    );
    const artifact = requireRecord(
      state.platformArtifacts,
      record.artifactId,
      "Platform artifact",
    );
    const artifactIndex = approval.approvedArtifactIds.indexOf(record.artifactId);
    if (
      artifactIndex < 0 ||
      approval.approvedArtifactHashes[artifactIndex] !== record.artifactHash ||
      artifact.artifactHash !== record.artifactHash ||
      artifact.platform !== record.platform
    ) {
      throw new InMemoryRepositoryConflictError(
        "Delivery approval binding mismatch",
      );
    }
    state.deliveries.set(record.id, clone(record));
    state.deliveryKeys.set(record.idempotencyKey, record.id);
    return { record: clone(record), replayed: false };
  }
}
