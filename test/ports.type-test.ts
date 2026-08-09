import type {
  ModelAGenerationPort,
  ModelAGenerationRequest,
  ModelAGenerationResponse,
  ModelBCritiquePort,
  ModelBCritiqueRequest,
  ModelBCritiqueResponse,
  GuardedTransitionCommand,
  ModelCallControl,
  OutputPort,
  Repository,
  SourceFetcher,
} from "../src/adapters/ports.js";
import type {
  ComplianceResult,
  DraftRevision,
  PlatformArtifact,
  ReproducibilityMetadata,
  ResearchResult,
  Topic,
  VerificationReport,
} from "../src/domain/content.js";
import type {
  ApprovalRecord,
  DeliveryCommand,
  DeliveryOutcome,
  DeliveryRecord,
  PipelineRun,
  PipelineTransition,
} from "../src/domain/workflow.js";
import type {
  FetchPage,
  SourceConfig,
  SourceCursor,
  SourcePermission,
} from "../src/domain/source.js";

class FakeSourceFetcher implements SourceFetcher {
  async fetch(
    _source: SourceConfig,
    cursor: SourceCursor | undefined,
    signal: AbortSignal,
  ): Promise<FetchPage> {
    if (signal.aborted) throw new Error("cancelled");
    return cursor === undefined ? { items: [] } : { items: [], nextCursor: cursor };
  }

  async isAllowed(_source: SourceConfig): Promise<SourcePermission> {
    return {
      allowed: true,
      termsVersion: "terms-v1",
      robotsCapturedAt: "2025-01-01T00:00:00.000Z",
    };
  }
}

class FakeModelA implements ModelAGenerationPort {
  async generate(
    _request: ModelAGenerationRequest,
    control: ModelCallControl,
  ): Promise<ModelAGenerationResponse> {
    if (control.signal.aborted || Date.parse(control.deadlineAt) <= Date.now()) {
      throw new Error("model call cancelled or expired");
    }
    throw new Error("compile-only fake");
  }
}

class FakeModelB implements ModelBCritiquePort {
  async critique(
    _request: ModelBCritiqueRequest,
    control: ModelCallControl,
  ): Promise<ModelBCritiqueResponse> {
    if (control.signal.aborted || Date.parse(control.deadlineAt) <= Date.now()) {
      throw new Error("model call cancelled or expired");
    }
    throw new Error("compile-only fake");
  }
}

const repository: Repository = {
  async createPipelineRun(command) {
    return command.run;
  },
  async getTopic(_id): Promise<Topic | undefined> {
    return undefined;
  },
  async getResearchResult(_id): Promise<ResearchResult | undefined> {
    return undefined;
  },
  async getDraftRevision(_id): Promise<DraftRevision | undefined> {
    return undefined;
  },
  async getVerificationReport(_id): Promise<VerificationReport | undefined> {
    return undefined;
  },
  async getPlatformArtifact(_id): Promise<PlatformArtifact | undefined> {
    return undefined;
  },
  async getComplianceResult(_id): Promise<ComplianceResult | undefined> {
    return undefined;
  },
  async getApproval(_id): Promise<ApprovalRecord | undefined> {
    return undefined;
  },
  async getPipelineRun(_id): Promise<PipelineRun | undefined> {
    return undefined;
  },
  async listTransitions(_pipelineRunId): Promise<readonly PipelineTransition[]> {
    return [];
  },
  async getDelivery(_id): Promise<DeliveryRecord | undefined> {
    return undefined;
  },
  async getDeliveryByIdempotencyKey(_key): Promise<DeliveryRecord | undefined> {
    return undefined;
  },
  async commitGuardedTransition(command) {
    return {
      kind: "Conflict",
      current: await this.getPipelineRun(command.pipelineRunId),
    };
  },
  async recordDelivery(record) {
    return { record, replayed: false };
  },
};

class FakeOutput implements OutputPort {
  async deliver(command: DeliveryCommand): Promise<DeliveryOutcome> {
    if (!command.approvalId || !command.artifactId || !command.artifactHash) {
      return { status: "Failed", errorCode: "INVALID_APPROVAL_BINDING" };
    }
    return { status: "Exported", exportedBundleId: "bundle-1" };
  }
}

type Assert<T extends true> = T;
type HasNoMutableWorkflowState<T> = Extract<
  keyof T,
  "stage" | "workStatus"
> extends never
  ? true
  : false;
type DomainArtifactsHaveNoMutableWorkflowState = Assert<
  HasNoMutableWorkflowState<
    | Topic
    | ResearchResult
    | DraftRevision
    | VerificationReport
    | PlatformArtifact
    | ComplianceResult
    | ApprovalRecord
    | DeliveryRecord
  >
>;
type PipelineRunOwnsMutableWorkflowState = Assert<
  "stage" | "workStatus" extends keyof PipelineRun ? true : false
>;
type CompleteReproducibilityMetadata = Assert<
  ReproducibilityMetadata extends {
    readonly provider: string;
    readonly model: string;
    readonly promptVersion: string;
    readonly configurationVersion: string;
  }
    ? true
    : false
>;
type ModelControlSupportsCancellationAndDeadline = Assert<
  ModelCallControl extends {
    readonly signal: AbortSignal;
    readonly deadlineAt: string;
  }
    ? true
    : false
>;
type GuardedMutationSupportsConcurrencyAndIdempotency = Assert<
  GuardedTransitionCommand extends {
    readonly expectedVersion: number;
    readonly expectedStage: PipelineRun["stage"];
    readonly idempotencyKey: string;
  }
    ? true
    : false
>;
type OutputSignature = (command: DeliveryCommand) => Promise<DeliveryOutcome>;

const source: SourceFetcher = new FakeSourceFetcher();
const modelA: ModelAGenerationPort = new FakeModelA();
const modelB: ModelBCritiquePort = new FakeModelB();
const output: OutputPort = new FakeOutput();
const exactDeliverSignature: OutputSignature = output.deliver.bind(output);

void source;
void modelA;
void modelB;
void repository;
void exactDeliverSignature;
void (undefined as unknown as DomainArtifactsHaveNoMutableWorkflowState);
void (undefined as unknown as PipelineRunOwnsMutableWorkflowState);
void (undefined as unknown as CompleteReproducibilityMetadata);
void (undefined as unknown as ModelControlSupportsCancellationAndDeadline);
void (undefined as unknown as GuardedMutationSupportsConcurrencyAndIdempotency);
