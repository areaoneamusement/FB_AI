import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  ComplianceResult,
  DraftRevision,
  PlatformArtifact,
  ResearchResult,
  Topic,
  VerificationReport,
} from "../src/domain/content.js";
import {
  SUCCESSFUL_WORKFLOW_STAGES,
  WORKFLOW_STAGE_INDEX,
  type ApprovalRecord,
  type PipelineRun,
  type SuccessfulWorkflowStage,
  type WorkStatus,
  type WorkflowStage,
} from "../src/domain/workflow.js";
import { InMemoryRepository } from "../src/adapters/in-memory-repository.js";
import {
  AUTOMATIC_WORKFLOW_STAGES,
  ContentPipeline,
  PipelineCommandError,
  type ApprovalCommand,
  type AutomaticWorkflowStage,
} from "../src/pipeline/content-pipeline.js";

const NOW = "2025-01-01T00:10:00.000Z";
const START = "2025-01-01T00:05:00.000Z";
const RUN_ID = "run-1";
const TOPIC_ID = "topic-1";
const RESEARCH_ID = "research-1";
const REVISION_ID = "revision-1";
const CONTENT_HASH = "content-hash-1";
const REPORT_ID = "report-1";
const ARTIFACT_1_ID = "artifact-1";
const ARTIFACT_2_ID = "artifact-2";
const ARTIFACT_1_HASH = "artifact-hash-1";
const ARTIFACT_2_HASH = "artifact-hash-2";
const COMPLIANCE_1_ID = "compliance-1";
const COMPLIANCE_2_ID = "compliance-2";
const APPROVAL_ID = "approval-1";
const OPERATOR_ID = "operator-1";

/** Predefined configured category set (six entries so a 6-unique case exists). */
const CONFIGURED_CATEGORIES = [
  "AI Tools",
  "AI Skills",
  "AI News",
  "AI Research",
  "AI Ethics",
  "AI Business",
] as const;

const OUT_OF_SET_CATEGORIES = ["Unknown", "Công cụ lạ", "", "  "] as const;

const ALL_STAGES = [
  ...SUCCESSFUL_WORKFLOW_STAGES,
  "Rejected",
] as const satisfies readonly WorkflowStage[];

type IntentStage = Exclude<SuccessfulWorkflowStage, "Collected">;

const INTENT_STAGES = [
  "Scored",
  "Researched",
  "Generated",
  "Verified",
  "ComplianceChecked",
  "PendingApproval",
  "Approved",
] as const satisfies readonly IntentStage[];

const INTENT_PREDECESSOR: Readonly<Record<IntentStage, SuccessfulWorkflowStage>> = {
  Scored: "Collected",
  Researched: "Scored",
  Generated: "Researched",
  Verified: "Generated",
  ComplianceChecked: "Verified",
  PendingApproval: "ComplianceChecked",
  Approved: "PendingApproval",
};

function topic(categories: readonly string[]): Topic {
  return {
    id: TOPIC_ID,
    sourceRef: {
      sourceId: "source-1",
      captureId: "capture-1",
      url: "https://example.com/source",
      capturedAt: NOW,
      termsVersion: "terms-v1",
    },
    externalId: "external-1",
    title: "Chủ đề AI",
    createdAt: START,
    score: {
      total: 90,
      breakdown: [
        { criterionId: "relevance", componentValue: 90, weightPercent: 100 },
      ],
      scoringConfigVersion: "score-v1",
    },
    categories,
  };
}

function research(): ResearchResult {
  return {
    id: RESEARCH_ID,
    topicId: TOPIC_ID,
    items: [],
    status: "Ok",
    unreachableSources: [],
  };
}

function revision(): DraftRevision {
  return {
    id: REVISION_ID,
    draftId: "draft-1",
    revision: 1,
    content: {
      topicId: TOPIC_ID,
      facebookPost: "A".repeat(50),
      guide: [],
      videoScript: { intro: "intro", body: "body", conclusion: "end" },
      originLinks: ["https://example.com/source"],
      language: "vi",
    },
    contentHash: CONTENT_HASH,
    createdBy: "System",
    createdAt: NOW,
  };
}

function report(): VerificationReport {
  return {
    id: REPORT_ID,
    draftRevisionId: REVISION_ID,
    contentHash: CONTENT_HASH,
    researchResultId: RESEARCH_ID,
    round: 1,
    modelB: {
      provider: "provider-b",
      model: "model-b",
      promptVersion: "prompt-v1",
      configurationVersion: "config-v1",
    },
    findings: [],
    passed: true,
  };
}

function artifact(
  id: string,
  artifactHash: string,
  platform: PlatformArtifact["platform"],
): PlatformArtifact {
  return {
    id,
    draftRevisionId: REVISION_ID,
    platform,
    rendererVersion: "renderer-v1",
    body: `approved bytes ${id}`,
    metadata: {},
    attribution: "Nguồn: example.com",
    imageSuggestions: [],
    artifactHash,
    createdAt: NOW,
  };
}

function compliance(
  id: string,
  artifactId: string,
  artifactHash: string,
  platform: ComplianceResult["platform"],
): ComplianceResult {
  return {
    id,
    artifactId,
    artifactHash,
    draftRevisionId: REVISION_ID,
    platform,
    ruleSetVersion: "rules-v1",
    sourceTermsVersions: ["terms-v1"],
    evaluatorVersion: "evaluator-v1",
    passed: true,
    violatedRuleIds: [],
    attributionOk: true,
    copyrightOk: true,
    reasons: [],
    checkedAt: NOW,
  };
}

function approvalRecord(): ApprovalRecord {
  return {
    id: APPROVAL_ID,
    pipelineRunId: RUN_ID,
    draftRevisionId: REVISION_ID,
    contentHash: CONTENT_HASH,
    approvedArtifactIds: [ARTIFACT_1_ID],
    approvedArtifactHashes: [ARTIFACT_1_HASH],
    operatorId: OPERATOR_ID,
    approvedAt: NOW,
  };
}

function newRepository(): InMemoryRepository {
  return new InMemoryRepository({ now: () => NOW });
}

function newPipeline(
  repository: InMemoryRepository,
  retryBudget = 3,
): ContentPipeline {
  return new ContentPipeline(repository, [...CONFIGURED_CATEGORIES], {
    automaticStageRetryBudgets: {
      Scored: retryBudget,
      Researched: retryBudget,
      Generated: retryBudget,
      Verified: retryBudget,
      ComplianceChecked: retryBudget,
    },
    now: () => NOW,
  });
}

interface Scenario {
  readonly repository: InMemoryRepository;
  readonly pipeline: ContentPipeline;
  readonly run: PipelineRun;
}

/**
 * Seeds a run directly at the repository level so a property can start from any
 * stage (including terminal `Rejected`) with complete, exact evidence attached.
 * Repository seeding intentionally bypasses pipeline guards; the assertions below
 * exercise the guards themselves.
 */
async function seed(options: {
  readonly stage: WorkflowStage;
  readonly status?: WorkStatus;
  readonly includeApproval?: boolean;
  readonly retryBudget?: number;
}): Promise<Scenario> {
  const repository = newRepository();
  const pipeline = newPipeline(repository, options.retryBudget ?? 3);
  const status = options.status ?? "Ready";
  await repository.createPipelineRun({
    run: {
      id: RUN_ID,
      topicId: TOPIC_ID,
      stage: "Collected",
      workStatus: "Ready",
      version: 0,
      categories: [CONFIGURED_CATEGORIES[0]],
      createdAt: START,
      updatedAt: START,
    },
    topic: topic([CONFIGURED_CATEGORIES[0]]),
    idempotencyKey: "seed-create",
  });
  const outcome = await repository.commitGuardedTransition({
    pipelineRunId: RUN_ID,
    expectedVersion: 0,
    expectedStage: "Collected",
    expectedStatus: "Ready",
    nextStage: options.stage,
    nextStatus: status,
    nextActiveDraftRevisionId: REVISION_ID,
    actorType: "System",
    idempotencyKey: "seed-transition",
    records: {
      researchResults: [research()],
      draftRevisions: [revision()],
      verificationReports: [report()],
      platformArtifacts: [
        artifact(ARTIFACT_1_ID, ARTIFACT_1_HASH, "Facebook_Page"),
        artifact(ARTIFACT_2_ID, ARTIFACT_2_HASH, "YouTube"),
      ],
      complianceResults: [
        compliance(COMPLIANCE_1_ID, ARTIFACT_1_ID, ARTIFACT_1_HASH, "Facebook_Page"),
        compliance(COMPLIANCE_2_ID, ARTIFACT_2_ID, ARTIFACT_2_HASH, "YouTube"),
      ],
      ...(options.includeApproval === true
        ? { approvals: [approvalRecord()] }
        : {}),
    },
  });
  if (outcome.kind === "Conflict") throw new Error("seeding conflicted");
  return { repository, pipeline, run: outcome.run };
}

interface StateSnapshot {
  readonly stage: WorkflowStage | undefined;
  readonly status: WorkStatus | undefined;
  readonly version: number | undefined;
  readonly activeDraftRevisionId: string | undefined;
  readonly transitionCount: number;
}

async function snapshot(repository: InMemoryRepository): Promise<StateSnapshot> {
  const run = await repository.getPipelineRun(RUN_ID);
  const transitions = await repository.listTransitions(RUN_ID);
  return {
    stage: run?.stage,
    status: run?.workStatus,
    version: run?.version,
    activeDraftRevisionId: run?.activeDraftRevisionId,
    transitionCount: transitions.length,
  };
}

async function evidenceSnapshot(repository: InMemoryRepository) {
  return {
    research: await repository.getResearchResult(RESEARCH_ID),
    revision: await repository.getDraftRevision(REVISION_ID),
    report: await repository.getVerificationReport(REPORT_ID),
    artifact1: await repository.getPlatformArtifact(ARTIFACT_1_ID),
    artifact2: await repository.getPlatformArtifact(ARTIFACT_2_ID),
    compliance1: await repository.getComplianceResult(COMPLIANCE_1_ID),
    compliance2: await repository.getComplianceResult(COMPLIANCE_2_ID),
    transitions: await repository.listTransitions(RUN_ID),
  };
}

/** Issues the single intent command that owns `into`, from an explicit expectation. */
async function issueIntent(
  scenario: Scenario,
  into: IntentStage,
  expectation: {
    readonly expectedVersion: number;
    readonly expectedStage: WorkflowStage;
    readonly expectedStatus: WorkStatus;
  },
): Promise<PipelineRun | ApprovalRecord> {
  const base = {
    pipelineRunId: RUN_ID,
    expectedVersion: expectation.expectedVersion,
    expectedStage: expectation.expectedStage,
    expectedStatus: expectation.expectedStatus,
    idempotencyKey: `intent-${into}`,
  };
  const pipeline = scenario.pipeline;
  switch (into) {
    case "Scored":
      return pipeline.completeScoring({ ...base, topicId: TOPIC_ID, scoreId: "score-1" });
    case "Researched":
      return pipeline.completeResearch({ ...base, researchResultId: RESEARCH_ID });
    case "Generated":
      return pipeline.completeGeneration({ ...base, draftRevisionId: REVISION_ID });
    case "Verified":
      return pipeline.completeVerification({ ...base, reportId: REPORT_ID });
    case "ComplianceChecked":
      return pipeline.completeCompliance({ ...base, artifactResultIds: [COMPLIANCE_1_ID] });
    case "PendingApproval":
      return pipeline.submitForReview({ ...base });
    case "Approved":
      return pipeline.approve({
        ...base,
        operatorId: OPERATOR_ID,
        confirmed: true,
        draftRevisionId: REVISION_ID,
        contentHash: CONTENT_HASH,
        verificationReportId: REPORT_ID,
        complianceResultIds: [COMPLIANCE_1_ID],
        artifactIds: [ARTIFACT_1_ID],
        artifactHashes: [ARTIFACT_1_HASH],
      });
  }
}

/** Every stage as a starting point (including `Rejected`) against every intent. */
const ADVANCE_EXAMPLES: readonly [WorkflowStage, IntentStage, boolean][] =
  ALL_STAGES.flatMap((from) =>
    INTENT_STAGES.flatMap((into) => [
      [from, into, false] as [WorkflowStage, IntentStage, boolean],
      [from, into, true] as [WorkflowStage, IntentStage, boolean],
    ]),
  );

describe("Content_Pipeline stage advancement", () => {
  // Feature: fb-ai, Property 24: Advancing moves exactly one adjacent stage, never skipping
  it("moves exactly one adjacent stage and refuses every non-adjacent pair", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_STAGES),
        fc.constantFrom(...INTENT_STAGES),
        fc.boolean(),
        async (from, into, forgeExpectedStage) => {
          const scenario = await seed({ stage: from });
          const before = await snapshot(scenario.repository);
          const adjacent = INTENT_PREDECESSOR[into] === from;
          const expectedStage = forgeExpectedStage
            ? INTENT_PREDECESSOR[into]
            : from;
          const expectation = {
            expectedVersion: scenario.run.version,
            expectedStage,
            expectedStatus: scenario.run.workStatus,
          };
          const legal = adjacent && expectedStage === from;

          if (legal) {
            await issueIntent(scenario, into, expectation);
            const after = await snapshot(scenario.repository);
            expect(after.stage).toBe(into);
            expect(after.version).toBe((before.version ?? 0) + 1);
            expect(after.transitionCount).toBe(before.transitionCount + 1);
            const transitions = await scenario.repository.listTransitions(RUN_ID);
            const applied = transitions[transitions.length - 1];
            expect(applied.fromStage).toBe(from);
            expect(applied.toStage).toBe(into);
            expect(
              WORKFLOW_STAGE_INDEX[into] -
                WORKFLOW_STAGE_INDEX[from as SuccessfulWorkflowStage],
            ).toBe(1);
            return;
          }

          await expect(issueIntent(scenario, into, expectation)).rejects.toBeInstanceOf(
            PipelineCommandError,
          );
          expect(await snapshot(scenario.repository)).toEqual(before);
        },
      ),
      { numRuns: 300, examples: [...ADVANCE_EXAMPLES] },
    );
  });
});

describe("Content_Pipeline rejection", () => {
  const reasonArb = fc.oneof(
    fc.constantFrom(
      "",
      "a",
      "a".repeat(500),
      "a".repeat(501),
      "a".repeat(1_000),
      "a".repeat(1_001),
      "   ",
      "  bị lỗi kiểm chứng  ",
    ),
    fc.string({ minLength: 0, maxLength: 24 }),
  );

  /** Reason-length boundaries 0/1/500/501 (plus 1000/1001) for both actor types. */
  const REJECTION_EXAMPLES: readonly [
    WorkflowStage,
    WorkflowStage,
    string,
    "System" | "Operator",
    string,
  ][] = ["", "a", "a".repeat(500), "a".repeat(501), "a".repeat(1_000), "a".repeat(1_001), "   "]
    .flatMap((reason) =>
      (["System", "Operator"] as const).flatMap(
        (actorType) =>
          [
            ["Generated", "Generated", reason, actorType, OPERATOR_ID],
            ["Generated", "Verified", reason, actorType, OPERATOR_ID],
            ["Rejected", "Rejected", reason, actorType, OPERATOR_ID],
            ["PendingApproval", "PendingApproval", reason, actorType, ""],
          ] as [WorkflowStage, WorkflowStage, string, "System" | "Operator", string][],
      ),
    );

  // Feature: fb-ai, Property 25: Rejection is recorded without destroying data
  it("records a valid reason with the failing stage id and never destroys evidence", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_STAGES),
        fc.constantFrom(...ALL_STAGES),
        reasonArb,
        fc.constantFrom("System" as const, "Operator" as const),
        fc.constantFrom(OPERATOR_ID, ""),
        async (from, failingStage, reason, actorType, actorId) => {
          const scenario = await seed({ stage: from });
          const before = await snapshot(scenario.repository);
          const beforeEvidence = await evidenceSnapshot(scenario.repository);
          const trimmed = reason.trim();
          const maximum = actorType === "Operator" ? 1_000 : 500;
          const valid =
            from !== "Rejected" &&
            failingStage === from &&
            trimmed.length >= 1 &&
            trimmed.length <= maximum &&
            (actorType !== "Operator" || actorId.trim().length > 0);

          const command = {
            pipelineRunId: RUN_ID,
            expectedVersion: scenario.run.version,
            expectedStage: from,
            expectedStatus: scenario.run.workStatus,
            failingStage,
            reason,
            actorType,
            actorId,
            idempotencyKey: "reject-1",
          };

          if (!valid) {
            await expect(scenario.pipeline.reject(command)).rejects.toBeInstanceOf(
              PipelineCommandError,
            );
            expect(await snapshot(scenario.repository)).toEqual(before);
            expect(await evidenceSnapshot(scenario.repository)).toEqual(beforeEvidence);
            return;
          }

          const rejected = await scenario.pipeline.reject(command);
          expect(rejected.stage).toBe("Rejected");
          expect(rejected.workStatus).toBe("Rejected");
          expect(rejected.blockedReason).toBe(`[${failingStage}] ${trimmed}`);
          expect(rejected.blockedReason).toContain(failingStage);
          expect(rejected.activeDraftRevisionId).toBe(REVISION_ID);
          expect(rejected.version).toBe((before.version ?? 0) + 1);

          const after = await evidenceSnapshot(scenario.repository);
          expect(after.research).toEqual(beforeEvidence.research);
          expect(after.revision).toEqual(beforeEvidence.revision);
          expect(after.report).toEqual(beforeEvidence.report);
          expect(after.artifact1).toEqual(beforeEvidence.artifact1);
          expect(after.artifact2).toEqual(beforeEvidence.artifact2);
          expect(after.compliance1).toEqual(beforeEvidence.compliance1);
          expect(after.compliance2).toEqual(beforeEvidence.compliance2);
          expect(after.transitions.slice(0, beforeEvidence.transitions.length)).toEqual(
            beforeEvidence.transitions,
          );
          const appended = after.transitions[after.transitions.length - 1];
          expect(appended.toStage).toBe("Rejected");
          expect(appended.fromStage).toBe(from);
          expect(appended.reason).toBe(trimmed);
        },
      ),
      { numRuns: 300, examples: [...REJECTION_EXAMPLES] },
    );
  });
});

describe("Content_Pipeline topic categories", () => {
  const categoryValueArb = fc.constantFrom(
    ...CONFIGURED_CATEGORIES,
    ...OUT_OF_SET_CATEGORIES,
  );

  const categoriesArb = fc.oneof(
    fc.array(categoryValueArb, { minLength: 0, maxLength: 7 }),
    // Explicit boundary counts 0, 1, 5, 6 and duplicate/out-of-set shapes.
    fc.constantFrom<readonly string[]>(
      [],
      [CONFIGURED_CATEGORIES[0]],
      [...CONFIGURED_CATEGORIES].slice(0, 5),
      [...CONFIGURED_CATEGORIES],
      [CONFIGURED_CATEGORIES[0], CONFIGURED_CATEGORIES[0]],
      [CONFIGURED_CATEGORIES[1], "Unknown"],
      [...CONFIGURED_CATEGORIES].slice(0, 4).concat(CONFIGURED_CATEGORIES[0]),
      ["Unknown"],
    ),
  );

  /** Counts 0, 1, 5 and 6 plus duplicate and out-of-set shapes. */
  const CATEGORY_EXAMPLES: readonly [readonly string[]][] = [
    [[]],
    [[CONFIGURED_CATEGORIES[0]]],
    [[...CONFIGURED_CATEGORIES].slice(0, 5)],
    [[...CONFIGURED_CATEGORIES]],
    [[CONFIGURED_CATEGORIES[0], CONFIGURED_CATEGORIES[0]]],
    [[...CONFIGURED_CATEGORIES].slice(0, 4).concat(CONFIGURED_CATEGORIES[0])],
    [[CONFIGURED_CATEGORIES[1], "Unknown"]],
    [["Unknown"]],
    [[""]],
    [["  "]],
    [[CONFIGURED_CATEGORIES[2], "Công cụ lạ"]],
  ];

  // Feature: fb-ai, Property 26: Every topic has 1-5 categories from the predefined set
  it("accepts exactly 1 to 5 unique configured categories and persists them", async () => {
    await fc.assert(
      fc.asyncProperty(categoriesArb, async (requested) => {
        const repository = newRepository();
        const pipeline = newPipeline(repository);
        const unique = new Set(requested);
        const valid =
          requested.length >= 1 &&
          requested.length <= 5 &&
          unique.size === requested.length &&
          requested.every((category) =>
            (CONFIGURED_CATEGORIES as readonly string[]).includes(category),
          );

        if (!valid) {
          expect(() => pipeline.assignCategories(requested)).toThrow(PipelineCommandError);
          await expect(
            pipeline.start({
              pipelineRunId: RUN_ID,
              topic: topic([]),
              categories: requested,
              idempotencyKey: "start-1",
              createdAt: START,
            }),
          ).rejects.toBeInstanceOf(PipelineCommandError);
          expect(await repository.getPipelineRun(RUN_ID)).toBeUndefined();
          expect(await repository.getTopic(TOPIC_ID)).toBeUndefined();
          return;
        }

        expect(pipeline.assignCategories(requested)).toEqual(requested);
        const started = await pipeline.start({
          pipelineRunId: RUN_ID,
          topic: topic([]),
          categories: requested,
          idempotencyKey: "start-1",
          createdAt: START,
        });
        expect(started.categories).toEqual(requested);
        expect(started.categories.length).toBeGreaterThanOrEqual(1);
        expect(started.categories.length).toBeLessThanOrEqual(5);
        expect(new Set(started.categories).size).toBe(started.categories.length);
        for (const category of started.categories) {
          expect(CONFIGURED_CATEGORIES).toContain(category);
        }
        expect((await repository.getTopic(TOPIC_ID))?.categories).toEqual(requested);
      }),
      { numRuns: 200, examples: [...CATEGORY_EXAMPLES] },
    );
  });
});

/** Every stage crossed with known/unknown approvals, artifacts and mismatched hashes. */
const DELIVERY_EXAMPLES: readonly [WorkflowStage, string, string, string][] =
  ALL_STAGES.flatMap((stage) =>
    [APPROVAL_ID, "approval-missing"].flatMap((approvalId) =>
      [ARTIFACT_1_ID, ARTIFACT_2_ID, "artifact-missing"].flatMap((artifactId) =>
        [ARTIFACT_1_HASH, ARTIFACT_2_HASH, "stale-hash"].map(
          (artifactHash) =>
            [stage, approvalId, artifactId, artifactHash] as [
              WorkflowStage,
              string,
              string,
              string,
            ],
        ),
      ),
    ),
  );

describe("Content_Pipeline approval gate", () => {
  // Feature: fb-ai, Property 27: Approval gate blocks all output before approval
  it("authorizes delivery only for an Approved run and an exact approved artifact hash", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_STAGES),
        fc.constantFrom(APPROVAL_ID, "approval-missing"),
        fc.constantFrom(ARTIFACT_1_ID, ARTIFACT_2_ID, "artifact-missing"),
        fc.constantFrom(ARTIFACT_1_HASH, ARTIFACT_2_HASH, "stale-hash"),
        async (stage, approvalId, artifactId, artifactHash) => {
          const scenario = await seed({ stage, includeApproval: true });
          const before = await snapshot(scenario.repository);
          const command = {
            pipelineRunId: RUN_ID,
            approvalId,
            artifactId,
            artifactHash,
          };

          const expected =
            stage === "Approved" &&
            approvalId === APPROVAL_ID &&
            artifactId === ARTIFACT_1_ID &&
            artifactHash === ARTIFACT_1_HASH;

          expect(await scenario.pipeline.canDeliver(command)).toBe(expected);
          const authorization = await scenario.pipeline.authorizeDelivery(command);
          expect(authorization.allowed).toBe(expected);
          if (!authorization.allowed) {
            expect(authorization.errorCode).toBe(
              stage === "Approved"
                ? "APPROVAL_ARTIFACT_MISMATCH"
                : "CONTENT_NOT_APPROVED",
            );
            expect(authorization.message.length).toBeGreaterThan(0);
          }
          // The gate is a read: it never mutates workflow state.
          expect(await snapshot(scenario.repository)).toEqual(before);
        },
      ),
      { numRuns: 300, examples: [...DELIVERY_EXAMPLES] },
    );
  });

  // Feature: fb-ai, Property 27: Approval gate blocks all output before approval
  it("refuses delivery in every automatic stage even with complete approval evidence", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<AutomaticWorkflowStage>(...AUTOMATIC_WORKFLOW_STAGES),
        fc.constantFrom<WorkStatus>("Ready", "InProgress", "RetryableBlocked"),
        async (stage, status) => {
          const scenario = await seed({ stage, status, includeApproval: true });
          expect(
            await scenario.pipeline.authorizeDelivery({
              pipelineRunId: RUN_ID,
              approvalId: APPROVAL_ID,
              artifactId: ARTIFACT_1_ID,
              artifactHash: ARTIFACT_1_HASH,
            }),
          ).toEqual({
            allowed: false,
            errorCode: "CONTENT_NOT_APPROVED",
            message: "Content is not approved for output or delivery",
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});

type Attempt =
  | { readonly kind: "valid-approval" }
  | { readonly kind: "unconfirmed" }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "stale-version" }
  | { readonly kind: "content-hash-mismatch" }
  | { readonly kind: "artifact-hash-mismatch" }
  | { readonly kind: "artifact-outside-compliance" }
  | { readonly kind: "duplicate-artifacts" }
  | { readonly kind: "empty-artifacts" }
  | { readonly kind: "stale-report" }
  | { readonly kind: "wrong-intent"; readonly into: IntentStage }
  | { readonly kind: "reject-invalid-note"; readonly note: string }
  | { readonly kind: "read-only-gate" };

describe("Content_Pipeline explicit approval", () => {
  const ATTEMPTS: readonly Attempt[] = [
    { kind: "valid-approval" },
    { kind: "unconfirmed" },
    { kind: "unauthenticated" },
    { kind: "stale-version" },
    { kind: "content-hash-mismatch" },
    { kind: "artifact-hash-mismatch" },
    { kind: "artifact-outside-compliance" },
    { kind: "duplicate-artifacts" },
    { kind: "empty-artifacts" },
    { kind: "stale-report" },
    { kind: "read-only-gate" },
    ...(
      [
        "Scored",
        "Researched",
        "Generated",
        "Verified",
        "ComplianceChecked",
        "PendingApproval",
      ] as const
    ).map((into) => ({ kind: "wrong-intent", into }) as Attempt),
    ...["", "   ", "a".repeat(1_001)].map(
      (note) => ({ kind: "reject-invalid-note", note }) as Attempt,
    ),
  ];

  const attemptArb: fc.Arbitrary<Attempt> = fc.constantFrom(...ATTEMPTS);

  async function attempt(scenario: Scenario, action: Attempt): Promise<void> {
    const base = {
      pipelineRunId: RUN_ID,
      expectedVersion: scenario.run.version,
      expectedStage: "PendingApproval" as const,
      expectedStatus: scenario.run.workStatus,
      idempotencyKey: `attempt-${action.kind}`,
    };
    const approval = {
      ...base,
      operatorId: OPERATOR_ID,
      confirmed: true as const,
      draftRevisionId: REVISION_ID,
      contentHash: CONTENT_HASH,
      verificationReportId: REPORT_ID,
      complianceResultIds: [COMPLIANCE_1_ID],
      artifactIds: [ARTIFACT_1_ID],
      artifactHashes: [ARTIFACT_1_HASH],
    };
    switch (action.kind) {
      case "valid-approval":
        await scenario.pipeline.approve(approval);
        return;
      case "unconfirmed":
        await scenario.pipeline.approve({
          ...approval,
          confirmed: false,
        } as unknown as ApprovalCommand);
        return;
      case "unauthenticated":
        await scenario.pipeline.approve({ ...approval, operatorId: "" });
        return;
      case "stale-version":
        await scenario.pipeline.approve({ ...approval, expectedVersion: scenario.run.version - 1 });
        return;
      case "content-hash-mismatch":
        await scenario.pipeline.approve({ ...approval, contentHash: "stale-content-hash" });
        return;
      case "artifact-hash-mismatch":
        await scenario.pipeline.approve({ ...approval, artifactHashes: ["stale-hash"] });
        return;
      case "artifact-outside-compliance":
        await scenario.pipeline.approve({
          ...approval,
          artifactIds: [ARTIFACT_2_ID],
          artifactHashes: [ARTIFACT_2_HASH],
        });
        return;
      case "duplicate-artifacts":
        await scenario.pipeline.approve({
          ...approval,
          artifactIds: [ARTIFACT_1_ID, ARTIFACT_1_ID],
          artifactHashes: [ARTIFACT_1_HASH, ARTIFACT_1_HASH],
          complianceResultIds: [COMPLIANCE_1_ID, COMPLIANCE_1_ID],
        });
        return;
      case "empty-artifacts":
        await scenario.pipeline.approve({
          ...approval,
          artifactIds: [],
          artifactHashes: [],
          complianceResultIds: [],
        });
        return;
      case "stale-report":
        await scenario.pipeline.approve({
          ...approval,
          verificationReportId: "report-missing",
        });
        return;
      case "wrong-intent":
        await issueIntent(scenario, action.into, {
          expectedVersion: scenario.run.version,
          expectedStage: "PendingApproval",
          expectedStatus: scenario.run.workStatus,
        });
        return;
      case "reject-invalid-note":
        await scenario.pipeline.reject({
          ...base,
          failingStage: "PendingApproval",
          reason: action.note,
          actorType: "Operator",
          actorId: OPERATOR_ID,
        });
        return;
      case "read-only-gate":
        expect(
          await scenario.pipeline.canDeliver({
            pipelineRunId: RUN_ID,
            approvalId: APPROVAL_ID,
            artifactId: ARTIFACT_1_ID,
            artifactHash: ARTIFACT_1_HASH,
          }),
        ).toBe(false);
        return;
    }
  }

  // Feature: fb-ai, Property 28: PendingApproval transitions to Approved only on explicit approval
  it("leaves PendingApproval untouched for every command except a confirmed exact approval", async () => {
    await fc.assert(
      fc.asyncProperty(attemptArb, async (action) => {
        const scenario = await seed({ stage: "PendingApproval" });
        const before = await snapshot(scenario.repository);

        if (action.kind === "valid-approval") {
          await attempt(scenario, action);
          const after = await snapshot(scenario.repository);
          expect(after.stage).toBe("Approved");
          expect(after.status).toBe("Ready");
          expect(after.version).toBe((before.version ?? 0) + 1);
          expect(after.transitionCount).toBe(before.transitionCount + 1);
          const approvals = await scenario.repository.listApprovalsByPipelineRun(RUN_ID);
          expect(approvals).toHaveLength(1);
          expect(approvals[0]).toMatchObject({
            operatorId: OPERATOR_ID,
            draftRevisionId: REVISION_ID,
            contentHash: CONTENT_HASH,
            approvedArtifactIds: [ARTIFACT_1_ID],
            approvedArtifactHashes: [ARTIFACT_1_HASH],
          });
          return;
        }

        if (action.kind === "read-only-gate") {
          await attempt(scenario, action);
        } else {
          await expect(attempt(scenario, action)).rejects.toBeInstanceOf(
            PipelineCommandError,
          );
        }
        const after = await snapshot(scenario.repository);
        expect(after.stage).toBe("PendingApproval");
        expect(after).toEqual(before);
        expect(await scenario.repository.listApprovalsByPipelineRun(RUN_ID)).toHaveLength(0);
        expect(
          await scenario.pipeline.canDeliver({
            pipelineRunId: RUN_ID,
            approvalId: `${RUN_ID}:approval:attempt-${action.kind}`,
            artifactId: ARTIFACT_1_ID,
            artifactHash: ARTIFACT_1_HASH,
          }),
        ).toBe(false);
      }),
      { numRuns: 300, examples: ATTEMPTS.map((action) => [action] as [Attempt]) },
    );
  });
});

describe("Content_Pipeline automatic stage timeout (Requirement 7.7)", () => {
  const timedOutCommand = (
    stage: AutomaticWorkflowStage,
    attempt: number,
    expected: { readonly version: number; readonly status: WorkStatus },
  ) => ({
    pipelineRunId: RUN_ID,
    expectedVersion: expected.version,
    expectedStage: stage,
    expectedStatus: expected.status,
    stage,
    attempt,
    startedAt: START,
    timedOutAt: NOW,
    idempotencyKey: `timeout-${stage}-${attempt}`,
  });

  it("blocks retryably while the configured stage retry budget remains", async () => {
    for (const stage of AUTOMATIC_WORKFLOW_STAGES) {
      const scenario = await seed({ stage, status: "InProgress", retryBudget: 3 });
      const blocked = await scenario.pipeline.handleAutomaticStageTimeout(
        timedOutCommand(stage, 1, { version: scenario.run.version, status: "InProgress" }),
      );
      expect(blocked.stage).toBe(stage);
      expect(blocked.workStatus).toBe("RetryableBlocked");
      expect(blocked.activeDraftRevisionId).toBe(REVISION_ID);
      expect(blocked.blockedReason).toContain(stage);
      expect(blocked.blockedReason).toContain("300 seconds");
      expect(blocked.blockedReason).toContain("retry remains");
      expect(await scenario.repository.getDraftRevision(REVISION_ID)).toEqual(revision());
    }
  });

  it("rejects terminally with a timeout reason and stage id only on budget exhaustion", async () => {
    const scenario = await seed({ stage: "Generated", status: "InProgress", retryBudget: 2 });
    const blocked = await scenario.pipeline.handleAutomaticStageTimeout(
      timedOutCommand("Generated", 1, { version: scenario.run.version, status: "InProgress" }),
    );
    expect(blocked.workStatus).toBe("RetryableBlocked");
    expect(blocked.stage).toBe("Generated");

    const rejected = await scenario.pipeline.handleAutomaticStageTimeout(
      timedOutCommand("Generated", 2, { version: blocked.version, status: "RetryableBlocked" }),
    );
    expect(rejected.stage).toBe("Rejected");
    expect(rejected.workStatus).toBe("Rejected");
    expect(rejected.blockedReason).toContain("[Generated]");
    expect(rejected.blockedReason).toContain("timed out after 300 seconds");
    expect(rejected.blockedReason).toContain("retry budget exhausted");
    expect(rejected.activeDraftRevisionId).toBe(REVISION_ID);
    expect(await scenario.repository.getDraftRevision(REVISION_ID)).toEqual(revision());
    expect(await scenario.repository.getVerificationReport(REPORT_ID)).toEqual(report());
  });

  it("rejects on the first timeout when the configured budget is a single attempt", async () => {
    const scenario = await seed({ stage: "Verified", status: "InProgress", retryBudget: 1 });
    const rejected = await scenario.pipeline.handleAutomaticStageTimeout(
      timedOutCommand("Verified", 1, { version: scenario.run.version, status: "InProgress" }),
    );
    expect(rejected.stage).toBe("Rejected");
    expect(rejected.blockedReason).toContain("[Verified]");
    expect(rejected.blockedReason).toContain("retry budget exhausted");
  });

  it("treats exactly 300 seconds as timed out and less than 300 seconds as not timed out", async () => {
    const scenario = await seed({ stage: "Researched", status: "InProgress", retryBudget: 3 });
    await expect(
      scenario.pipeline.handleAutomaticStageTimeout({
        ...timedOutCommand("Researched", 1, {
          version: scenario.run.version,
          status: "InProgress",
        }),
        startedAt: "2025-01-01T00:05:00.001Z",
      }),
    ).rejects.toMatchObject({ code: "NOT_TIMED_OUT" });
    expect((await scenario.repository.getPipelineRun(RUN_ID))?.workStatus).toBe("InProgress");

    const blocked = await scenario.pipeline.handleAutomaticStageTimeout(
      timedOutCommand("Researched", 1, { version: scenario.run.version, status: "InProgress" }),
    );
    expect(blocked.workStatus).toBe("RetryableBlocked");
  });

  it("refuses a timeout command that does not match the current automatic stage", async () => {
    const scenario = await seed({ stage: "Generated", status: "InProgress", retryBudget: 3 });
    await expect(
      scenario.pipeline.handleAutomaticStageTimeout({
        ...timedOutCommand("Verified", 1, { version: scenario.run.version, status: "InProgress" }),
        expectedStage: "Generated",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(await scenario.repository.listTransitions(RUN_ID)).toHaveLength(1);
  });
});
