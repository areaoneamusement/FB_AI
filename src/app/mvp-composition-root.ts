import Database from "better-sqlite3";
import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  ModelAGenerationPort,
  ModelBCritiquePort,
  Repository,
  SourceFetcher,
} from "../adapters/ports.js";
import {
  ComplianceChecker,
  type ArtifactComplianceResult,
  type ComplianceCheckInput,
  type ComplianceResultPersistence,
} from "../compliance/compliance-checker.js";
import type {
  DraftRevision,
  PlatformArtifact,
  ReproducibilityMetadata,
  ResearchResult,
  TargetPlatform,
  Topic,
  VerificationReport,
} from "../domain/content.js";
import {
  SUCCESSFUL_WORKFLOW_STAGES,
  type PipelineRun,
} from "../domain/workflow.js";
import type { SourceConfig } from "../domain/source.js";
import {
  createReviewDashboardHttpHandler,
  type ReviewDashboardHttpOptions,
} from "../dashboard/review-dashboard-http-handler.js";
import { ReviewDashboardApi } from "../dashboard/review-dashboard-api.js";
import { CopyReadyExporter } from "../output/copy-ready-exporter.js";
import { SqliteCollectionStateStore } from "../persistence/sqlite-collection-state-store.js";
import { SqliteRepository } from "../persistence/sqlite-repository.js";
import {
  ContentGenerator,
  type ContentGenerationResult,
} from "../pipeline/content-generator.js";
import {
  ContentPipeline,
  type ContentPipelineOptions,
} from "../pipeline/content-pipeline.js";
import { PlatformArtifactRenderer } from "../pipeline/platform-artifact-renderer.js";
import { ResearchAggregator } from "../pipeline/research-aggregator.js";
import {
  VerificationEngine,
  type ModelACorrectionPort,
  type VerificationResult,
} from "../pipeline/verification-engine.js";
import {
  SourceCollector,
  type CollectedSourceItem,
  type CollectionOptions,
  type CollectionResult,
} from "../pipeline/source-collector.js";
import { SourceRegistry } from "../pipeline/source-registry.js";
import {
  TopicScorer,
  type CriterionValues,
  type ScoringConfig,
} from "../pipeline/topic-scorer.js";

export type ComplianceConfiguration = Omit<
  ComplianceCheckInput,
  "artifact" | "draftRevision"
>;

export interface MvpPipelineConfiguration {
  readonly sources: readonly SourceConfig[];
  readonly collection?: CollectionOptions;
  readonly scoring: {
    readonly config: ScoringConfig;
    readonly minScore: number;
    readonly valuesFor: (item: CollectedSourceItem) => CriterionValues;
  };
  readonly research?: {
    readonly minItems?: number;
    readonly perSourceTimeoutMs?: number;
    readonly overallDeadlineMs?: number;
  };
  /**
   * Topics carried past scoring in one cycle. Everything downstream of scoring costs
   * real quota — research re-fetches every source per topic, then two model providers
   * run per topic — so a busy collection would otherwise spend the whole rate limit on
   * whatever happened to clear the threshold. Topics are ranked first, so the cap keeps
   * the best ones; the rest are reported as Deferred and return on a later cycle.
   */
  readonly maxTopicsPerCycle?: number;
  readonly generation: {
    readonly requestedModel: Parameters<ContentGenerator["generate"]>[0]["requestedModel"];
    readonly language?: string;
    readonly brandVoiceVersion?: string;
    readonly deadlineMs?: number;
  };
  readonly verification: {
    readonly requestedModel: ReproducibilityMetadata;
    readonly requestedCorrectionModel?: ReproducibilityMetadata;
    readonly round?: number;
    readonly maxRounds?: number;
    readonly maxAttempts?: number;
    readonly deadlineMs?: number;
  };
  readonly rendering: {
    readonly rendererVersion: string;
    readonly platforms: readonly TargetPlatform[];
  };
  readonly compliance: {
    readonly evaluatorVersion: string;
    readonly resolve: (
      artifact: PlatformArtifact,
      revision: DraftRevision,
      research: ResearchResult,
    ) => ComplianceConfiguration | Promise<ComplianceConfiguration>;
  };
  readonly categories: {
    readonly allowed: readonly string[];
    readonly selectFor: (item: CollectedSourceItem) => readonly string[];
  };
  readonly pipeline?: ContentPipelineOptions;
}
export interface MvpCompositionConfig extends MvpPipelineConfiguration {
  readonly sqlitePath?: string;
  readonly dashboardHttp: ReviewDashboardHttpOptions;
  readonly now?: () => Date;
}

export interface MvpExternalAdapters {
  readonly sourceFetcher: SourceFetcher;
  readonly modelA: ModelAGenerationPort;
  readonly modelACorrection: ModelACorrectionPort;
  readonly modelB: ModelBCritiquePort;
}

export type MvpItemOutcome =
  | { readonly kind: "PendingReview"; readonly run: PipelineRun }
  | { readonly kind: "BelowThreshold"; readonly topic: Topic }
  | { readonly kind: "Deferred"; readonly topic: Topic }
  | { readonly kind: "InsufficientResearch"; readonly run: PipelineRun; readonly research: ResearchResult }
  | { readonly kind: "GenerationFailed"; readonly run: PipelineRun; readonly generation: ContentGenerationResult }
  | { readonly kind: "VerificationBlocked"; readonly run: PipelineRun; readonly report: VerificationReport }
  | {
      readonly kind: "VerificationRetryableBlocked";
      readonly run: PipelineRun;
      readonly verification: Extract<VerificationResult, { readonly kind: "RetryableBlocked" }>;
    }
  | { readonly kind: "ComplianceFailed"; readonly run: PipelineRun; readonly results: readonly ArtifactComplianceResult[] };

/**
 * Default per-cycle topic budget. Three topics cost roughly three research sweeps and six
 * model calls — enough to keep the review queue fed, small enough to stay inside the free
 * GitHub rate limit and to make a first live run cheap.
 */
export const DEFAULT_MAX_TOPICS_PER_CYCLE = 3;

export interface MvpCycleOutcome {
  readonly collection: CollectionResult;
  readonly items: readonly MvpItemOutcome[];
}

/**
 * ComplianceChecker must return an artifact before the workflow can transition.
 * This sink deliberately buffers instead of independently persisting; the
 * ContentPipeline atomically writes the result with Verified -> ComplianceChecked.
 */
export class PipelineComplianceResultBuffer implements ComplianceResultPersistence {
  readonly #results = new Map<string, ArtifactComplianceResult>();

  public async persistComplianceResult(result: ArtifactComplianceResult): Promise<void> {
    this.#results.set(result.id, result);
  }

  public take(id: string): ArtifactComplianceResult {
    const result = this.#results.get(id);
    if (result === undefined) throw new Error(`Compliance result ${id} was not buffered`);
    this.#results.delete(id);
    return result;
  }
}

interface MvpProcessors {
  readonly collector: SourceCollector;
  readonly scorer: TopicScorer;
  readonly researchAggregator: ResearchAggregator;
  readonly generator: ContentGenerator;
  readonly verification: VerificationEngine;
  readonly renderer: PlatformArtifactRenderer;
  readonly complianceChecker: ComplianceChecker;
  readonly complianceBuffer: PipelineComplianceResultBuffer;
}

/** Full automatic MVP orchestration; only this ContentPipeline changes stages. */
export class MvpContentPipeline extends ContentPipeline {
  public constructor(
    private readonly mvpRepository: Repository,
    categories: readonly string[],
    private readonly processors: MvpProcessors,
    private readonly configuration: MvpPipelineConfiguration,
    options: ContentPipelineOptions = {},
    private readonly clock: () => Date = () => new Date(),
  ) {
    super(mvpRepository, categories, options);
  }

  public async runCycle(now = this.clock()): Promise<MvpCycleOutcome> {
    const collection = await this.processors.collector.runCycle(
      this.configuration.collection,
      now,
    );
    const items: MvpItemOutcome[] = [];
    const eligible: { readonly item: CollectedSourceItem; readonly topic: Topic }[] = [];

    for (const item of collection.items) {
      const topic = this.scoreTopic(item);
      if (
        topic.score.total === null ||
        topic.score.total < this.configuration.scoring.minScore
      ) {
        items.push({ kind: "BelowThreshold", topic });
        continue;
      }
      eligible.push({ item, topic });
    }

    // Highest score first, newest first on a tie — the same order the review queue uses.
    eligible.sort(
      (left, right) =>
        (right.topic.score.total ?? 0) - (left.topic.score.total ?? 0) ||
        Date.parse(right.item.collectedAt) - Date.parse(left.item.collectedAt),
    );

    const budget = this.configuration.maxTopicsPerCycle ?? DEFAULT_MAX_TOPICS_PER_CYCLE;
    for (const [index, { item, topic }] of eligible.entries()) {
      if (index >= budget) {
        items.push({ kind: "Deferred", topic });
        continue;
      }
      items.push(await this.processScoredTopic(item, topic));
    }

    return Object.freeze({ collection, items: Object.freeze(items) });
  }

  public async processItem(item: CollectedSourceItem): Promise<MvpItemOutcome> {
    const topic = this.scoreTopic(item);
    if (
      topic.score.total === null ||
      topic.score.total < this.configuration.scoring.minScore
    ) {
      return { kind: "BelowThreshold", topic };
    }
    return this.processScoredTopic(item, topic);
  }

  /** Everything after scoring, for a topic already known to clear the threshold. */
  private async processScoredTopic(
    item: CollectedSourceItem,
    topic: Topic,
  ): Promise<MvpItemOutcome> {
    let run = await this.start({
      pipelineRunId: `run-${topic.id}`,
      topic,
      categories: this.configuration.categories.selectFor(item),
      idempotencyKey: `start:${topic.id}`,
      createdAt: item.collectedAt,
    });
    run = await this.completeScoring({
      pipelineRunId: run.id,
      expectedVersion: run.version,
      expectedStage: "Collected",
      expectedStatus: "Ready",
      topicId: topic.id,
      scoreId: `score:${topic.id}:${topic.score.scoringConfigVersion}`,
      idempotencyKey: `score:${topic.id}`,
    });
    const research = await this.processors.researchAggregator.aggregate(
      topic,
      this.configuration.sources,
      this.configuration.research,
    );
    if (research.status !== "Ok") {
      run = await this.commitStatus(run, "InsufficientData", {
        researchResults: [research],
      }, research.reason);
      return { kind: "InsufficientResearch", run, research };
    }
    run = await this.commitEvidenceTransition(run, "Researched", {
      researchResults: [research],
    }, research.id);

    const generation = await this.processors.generator.generate({
      topic,
      research,
      ...this.configuration.generation,
    });
    if (generation.kind !== "Generated") {
      run = await this.commitStatus(
        run,
        "RetryableBlocked",
        {},
        `Generation failed: ${generation.failingFormats.join(", ")}`,
      );
      return { kind: "GenerationFailed", run, generation };
    }
    const generatedRevision = generation.revision;
    run = await this.commitEvidenceTransition(run, "Generated", {
      draftRevisions: [generatedRevision],
    }, generatedRevision.id, generatedRevision.id);

    const verification = await this.processors.verification.verify({
      revision: generatedRevision,
      research,
      requestedModel: this.configuration.verification.requestedModel,
      ...(this.configuration.verification.requestedCorrectionModel === undefined
        ? {}
        : {
            requestedCorrectionModel:
              this.configuration.verification.requestedCorrectionModel,
          }),
      round: this.configuration.verification.round ?? 1,
      ...(this.configuration.verification.maxRounds === undefined
        ? {}
        : { maxRounds: this.configuration.verification.maxRounds }),
      ...(this.configuration.verification.maxAttempts === undefined
        ? {}
        : { maxAttempts: this.configuration.verification.maxAttempts }),
      ...(this.configuration.verification.deadlineMs === undefined
        ? {}
        : { deadlineMs: this.configuration.verification.deadlineMs }),
    });
    const verificationRecords = {
      draftRevisions: verification.artifacts.revisions,
      verificationReports: verification.artifacts.reports,
    };
    const activeRevision = verification.activeRevision;
    if (verification.kind === "RetryableBlocked") {
      run = await this.commitStatus(
        run,
        verification.workStatus,
        verificationRecords,
        verification.error.reason,
        activeRevision.id,
      );
      return { kind: "VerificationRetryableBlocked", run, verification };
    }
    const report = verification.report;
    this.assertVerificationBinding(report, activeRevision, research);
    if (verification.kind === "VerificationBlocked") {
      run = await this.commitStatus(
        run,
        verification.workStatus,
        verificationRecords,
        "Verification remained blocked after the configured rounds",
        activeRevision.id,
      );
      return { kind: "VerificationBlocked", run, report };
    }
    run = await this.commitEvidenceTransition(
      run,
      "Verified",
      verificationRecords,
      report.id,
      activeRevision.id,
    );

    const artifacts = this.processors.renderer.render({
      revision: activeRevision,
      topic,
      platforms: this.configuration.rendering.platforms,
    });
    const results: ArtifactComplianceResult[] = [];
    for (const artifact of artifacts) {
      const compliance = await this.configuration.compliance.resolve(
        artifact,
        activeRevision,
        research,
      );
      const checked = await this.processors.complianceChecker.check({
        artifact,
        draftRevision: activeRevision,
        ...compliance,
      });
      results.push(this.processors.complianceBuffer.take(checked.id));
    }
    if (results.some((result) => !result.passed)) {
      run = await this.commitStatus(run, "ComplianceFailed", {
        platformArtifacts: artifacts,
        complianceResults: results,
      }, "One or more immutable platform artifacts failed compliance");
      return { kind: "ComplianceFailed", run, results: Object.freeze(results) };
    }
    run = await this.commitEvidenceTransition(run, "ComplianceChecked", {
      platformArtifacts: artifacts,
      complianceResults: results,
    }, results.map((result) => result.id).join(","));
    run = await this.submitForReview({
      pipelineRunId: run.id,
      expectedVersion: run.version,
      expectedStage: "ComplianceChecked",
      expectedStatus: "Ready",
      idempotencyKey: `review:${run.id}:${run.version}`,
    });
    return { kind: "PendingReview", run };
  }

  private scoreTopic(item: CollectedSourceItem): Topic {
    const source = this.configuration.sources.find(({ id }) => id === item.sourceId);
    if (source === undefined) throw new Error(`Collected source ${item.sourceId} is not configured`);
    const topicId = stableTopicId(item.sourceId, item.externalId);
    const topic: Topic = {
      id: topicId,
      sourceRef: {
        sourceId: item.sourceId,
        captureId: item.normalizedContentHash || item.externalId,
        url: item.canonicalUrl ?? source.url,
        capturedAt: item.collectedAt,
        termsVersion: item.permission.termsVersion,
      },
      externalId: item.externalId,
      title: item.title,
      createdAt: item.publishedOrUpdatedAt,
      score: {
        total: null,
        breakdown: [],
        scoringConfigVersion: this.configuration.scoring.config.version,
        unscoredReason: "Not scored",
      },
      categories: this.configuration.categories.selectFor(item),
    };
    return this.processors.scorer.score(
      topic,
      this.configuration.scoring.valuesFor(item),
    );
  }
  private async commitStatus(
    run: PipelineRun,
    nextStatus: PipelineRun["workStatus"],
    records: Parameters<Repository["commitGuardedTransition"]>[0]["records"],
    blockedReason?: string,
    activeDraftRevisionId: string | undefined = run.activeDraftRevisionId,
  ): Promise<PipelineRun> {
    const outcome = await this.mvpRepository.commitGuardedTransition({
      pipelineRunId: run.id,
      expectedVersion: run.version,
      expectedStage: run.stage,
      expectedStatus: run.workStatus,
      nextStage: run.stage,
      nextStatus,
      ...(activeDraftRevisionId === undefined
        ? {}
        : { nextActiveDraftRevisionId: activeDraftRevisionId }),
      ...(blockedReason === undefined ? {} : { blockedReason }),
      actorType: "System",
      ...(activeDraftRevisionId === undefined
        ? {}
        : { artifactRevisionId: activeDraftRevisionId }),
      records,
      idempotencyKey: `${nextStatus}:${run.id}:${run.version}`,
    });
    if (outcome.kind === "Conflict") {
      throw new Error(`Guarded ${run.stage} status transition conflicted`);
    }
    return outcome.run;
  }

  private async commitEvidenceTransition(
    run: PipelineRun,
    nextStage: PipelineRun["stage"],
    records: Parameters<Repository["commitGuardedTransition"]>[0]["records"],
    artifactRevisionId?: string,
    nextActiveDraftRevisionId?: string,
  ): Promise<PipelineRun> {
    const currentIndex = SUCCESSFUL_WORKFLOW_STAGES.indexOf(
      run.stage as (typeof SUCCESSFUL_WORKFLOW_STAGES)[number],
    );
    if (
      currentIndex < 0 ||
      SUCCESSFUL_WORKFLOW_STAGES[currentIndex + 1] !== nextStage
    ) {
      throw new Error(
        `MVP orchestration requires an adjacent transition, received ${run.stage} -> ${nextStage}`,
      );
    }
    const outcome = await this.mvpRepository.commitGuardedTransition({
      pipelineRunId: run.id,
      expectedVersion: run.version,
      expectedStage: run.stage,
      expectedStatus: run.workStatus,
      nextStage,
      nextStatus: "Ready",
      ...(nextActiveDraftRevisionId === undefined ? {} : { nextActiveDraftRevisionId }),
      actorType: "System",
      ...(artifactRevisionId === undefined ? {} : { artifactRevisionId }),
      records,
      idempotencyKey: `${nextStage}:${run.id}:${run.version}`,
    });
    if (outcome.kind === "Conflict") {
      throw new Error(`Guarded ${run.stage} -> ${nextStage} transition conflicted`);
    }
    return outcome.run;
  }

  private assertVerificationBinding(
    report: VerificationReport,
    revision: DraftRevision,
    research: ResearchResult,
  ): void {
    if (
      report.draftRevisionId !== revision.id ||
      report.contentHash !== revision.contentHash ||
      report.researchResultId !== research.id
    ) {
      throw new Error("Verification report is not bound to the exact active revision");
    }
  }
}

export interface MvpApplication {
  readonly repository: SqliteRepository;
  readonly collectionState: SqliteCollectionStateStore;
  readonly registry: SourceRegistry;
  readonly collector: SourceCollector;
  readonly scorer: TopicScorer;
  readonly researchAggregator: ResearchAggregator;
  readonly generator: ContentGenerator;
  readonly verification: VerificationEngine;
  readonly renderer: PlatformArtifactRenderer;
  readonly complianceChecker: ComplianceChecker;
  readonly pipeline: MvpContentPipeline;
  readonly output: CopyReadyExporter;
  readonly dashboardApi: ReviewDashboardApi;
  readonly dashboardHttpHandler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>;
  close(): void;
}

/** Phase 1 composition root. No publisher, credentials, or external-write adapter exists here. */
export function createMvpApplication(
  config: MvpCompositionConfig,
  adapters: MvpExternalAdapters,
): MvpApplication {
  const database = new Database(config.sqlitePath ?? ":memory:");
  const repository = new SqliteRepository(database, {
    now: () => (config.now?.() ?? new Date()).toISOString(),
  });
  try {
    const collectionState = new SqliteCollectionStateStore(database);
    const registry = new SourceRegistry(config.sources);
    const collector = new SourceCollector(registry, adapters.sourceFetcher, collectionState);
    const scorer = new TopicScorer(config.scoring.config);
    const researchAggregator = new ResearchAggregator(adapters.sourceFetcher, {
      now: config.now,
    });
    const generator = new ContentGenerator(adapters.modelA, { now: config.now });
    const verification = new VerificationEngine(
      adapters.modelACorrection,
      adapters.modelB,
      { now: config.now },
    );
    const renderer = new PlatformArtifactRenderer({
      rendererVersion: config.rendering.rendererVersion,
      now: () => (config.now?.() ?? new Date()).toISOString(),
    });
    const complianceBuffer = new PipelineComplianceResultBuffer();
    const complianceChecker = new ComplianceChecker({
      persistence: complianceBuffer,
      evaluatorVersion: config.compliance.evaluatorVersion,
      now: config.now,
    });
    const processors: MvpProcessors = {
      collector,
      scorer,
      researchAggregator,
      generator,
      verification,
      renderer,
      complianceChecker,
      complianceBuffer,
    };
    const pipeline = new MvpContentPipeline(
      repository,
      config.categories.allowed,
      processors,
      config,
      config.pipeline,
      config.now,
    );
    const output = new CopyReadyExporter(repository, {
      now: () => (config.now?.() ?? new Date()).toISOString(),
    });
    const dashboardApi = new ReviewDashboardApi(repository, pipeline, output, {
      now: () => (config.now?.() ?? new Date()).toISOString(),
    });
    const dashboardHttpHandler = createReviewDashboardHttpHandler(
      dashboardApi,
      config.dashboardHttp,
    );
    return {
      repository,
      collectionState,
      registry,
      collector,
      scorer,
      researchAggregator,
      generator,
      verification,
      renderer,
      complianceChecker,
      pipeline,
      output,
      dashboardApi,
      dashboardHttpHandler,
      close: () => repository.close(),
    };
  } catch (error) {
    repository.close();
    throw error;
  }
}

function stableTopicId(sourceId: string, externalId: string): string {
  return `topic-${Buffer.from(`${sourceId}\u0000${externalId}`, "utf8").toString("base64url")}`;
}
