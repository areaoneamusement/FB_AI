import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "../src/adapters/in-memory-repository.js";
import type {
  GuardedTransitionOutcome,
  OutputPort,
  Repository,
} from "../src/adapters/ports.js";
import type {
  ComplianceResult,
  ContentDraft,
  DraftRevision,
  PlatformArtifact,
  ResearchResult,
  Topic,
  VerificationReport,
} from "../src/domain/content.js";
import type {
  PipelineRun,
  WorkStatus,
  WorkflowStage,
} from "../src/domain/workflow.js";
import {
  type AuthenticatedOperator,
  DashboardApiError,
  ReviewDashboardApi,
  hashDraftContent,
} from "../src/dashboard/review-dashboard-api.js";
import { ContentPipeline } from "../src/pipeline/content-pipeline.js";

const CREATED = "2025-07-01T10:00:00.000Z";
const UPDATED = "2025-07-01T10:05:00.000Z";

const RUN_ID = "run-1";
const TOPIC_ID = "topic-1";
const DRAFT_ID = "draft-1";
const REVISION_ID = "revision-1";
const REPORT_ID = "report-1";
const ARTIFACT_ID = "artifact-1";
const ARTIFACT_HASH = "artifact-hash-1";
const COMPLIANCE_ID = "compliance-1";
const SOURCE_URL = "https://example.test/source";

const ALL_STAGES = [
  "Collected",
  "Scored",
  "Researched",
  "Generated",
  "Verified",
  "ComplianceChecked",
  "PendingApproval",
  "Approved",
  "Rejected",
] as const satisfies readonly WorkflowStage[];

const topic: Topic = {
  id: TOPIC_ID,
  sourceRef: {
    sourceId: "source-1",
    captureId: "capture-1",
    url: SOURCE_URL,
    capturedAt: CREATED,
    termsVersion: "terms-v1",
  },
  externalId: "external-1",
  title: "AI update",
  createdAt: CREATED,
  score: { total: 90, breakdown: [], scoringConfigVersion: "score-v1" },
  categories: ["AI Tools"],
};

const research: ResearchResult = {
  id: "research-1",
  topicId: TOPIC_ID,
  items: [],
  status: "Ok",
  unreachableSources: [],
};

const BASE_CONTENT: ContentDraft = {
  topicId: TOPIC_ID,
  facebookPost: "A".repeat(50),
  guide: [{
    heading: "Guide",
    body: "Body",
    imageSuggestions: [{ description: "Detailed image suggestion" }],
  }],
  videoScript: { intro: "Intro", body: "Body", conclusion: "Conclusion" },
  originLinks: [SOURCE_URL],
  language: "vi",
};

const revisionFixture: DraftRevision = {
  id: REVISION_ID,
  draftId: DRAFT_ID,
  revision: 1,
  content: BASE_CONTENT,
  contentHash: hashDraftContent(BASE_CONTENT),
  createdBy: "System",
  createdAt: CREATED,
};

const reportFixture: VerificationReport = {
  id: REPORT_ID,
  draftRevisionId: REVISION_ID,
  contentHash: revisionFixture.contentHash,
  researchResultId: research.id,
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

const artifactFixture: PlatformArtifact = {
  id: ARTIFACT_ID,
  draftRevisionId: REVISION_ID,
  platform: "Facebook_Page",
  rendererVersion: "renderer-v1",
  body: "immutable approved bytes",
  metadata: {},
  attribution: SOURCE_URL,
  imageSuggestions: [],
  artifactHash: ARTIFACT_HASH,
  createdAt: CREATED,
};

const complianceFixture: ComplianceResult = {
  id: COMPLIANCE_ID,
  artifactId: ARTIFACT_ID,
  artifactHash: ARTIFACT_HASH,
  draftRevisionId: REVISION_ID,
  platform: "Facebook_Page",
  ruleSetVersion: "rules-v1",
  sourceTermsVersions: ["terms-v1"],
  evaluatorVersion: "evaluator-v1",
  passed: true,
  violatedRuleIds: [],
  attributionOk: true,
  copyrightOk: true,
  reasons: [],
  checkedAt: CREATED,
};

const exportOnlyOutput: OutputPort = {
  deliver: async () => ({ status: "Exported" as const }),
};

/** Every fixture reaches its stage through exactly one guarded transition, so version is always 1. */
const FIXTURE_VERSION = 1;

interface Harness {
  readonly repository: InMemoryRepository;
  readonly api: ReviewDashboardApi;
}

function statusFor(stage: WorkflowStage): WorkStatus {
  return stage === "Rejected" ? "Rejected" : "Ready";
}

async function setup(
  stage: WorkflowStage,
  repositoryOverride?: (inner: InMemoryRepository) => Repository,
): Promise<Harness> {
  const repository = new InMemoryRepository({ now: () => UPDATED });
  const run: PipelineRun = {
    id: RUN_ID,
    topicId: TOPIC_ID,
    stage: "Collected",
    workStatus: "Ready",
    version: 0,
    categories: topic.categories,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
  await repository.createPipelineRun({ run, topic, idempotencyKey: "create-run" });
  await repository.commitGuardedTransition({
    pipelineRunId: RUN_ID,
    expectedVersion: 0,
    expectedStage: "Collected",
    expectedStatus: "Ready",
    nextStage: stage,
    nextStatus: statusFor(stage),
    nextActiveDraftRevisionId: REVISION_ID,
    actorType: "System",
    artifactRevisionId: REVISION_ID,
    records: {
      researchResults: [research],
      draftRevisions: [revisionFixture],
      verificationReports: [reportFixture],
      platformArtifacts: [artifactFixture],
      complianceResults: [complianceFixture],
    },
    idempotencyKey: "prepare-stage",
  });
  const pipeline = new ContentPipeline(repository, ["AI Tools"], { now: () => UPDATED });
  const api = new ReviewDashboardApi(
    repositoryOverride === undefined ? repository : repositoryOverride(repository),
    pipeline,
    exportOnlyOutput,
    { now: () => UPDATED },
  );
  return { repository, api };
}

/** Delegating repository whose workflow commit always fails, simulating a save failure. */
function saveFailingRepository(inner: Repository, failure: Error): Repository {
  return {
    createPipelineRun: (command) => inner.createPipelineRun(command),
    getTopic: (id) => inner.getTopic(id),
    getResearchResult: (id) => inner.getResearchResult(id),
    getDraftRevision: (id) => inner.getDraftRevision(id),
    getVerificationReport: (id) => inner.getVerificationReport(id),
    getPlatformArtifact: (id) => inner.getPlatformArtifact(id),
    getComplianceResult: (id) => inner.getComplianceResult(id),
    getApproval: (id) => inner.getApproval(id),
    getPipelineRun: (id) => inner.getPipelineRun(id),
    listPipelineRuns: () => inner.listPipelineRuns(),
    listVerificationReportsByDraftRevision: (id) =>
      inner.listVerificationReportsByDraftRevision(id),
    listPlatformArtifactsByDraftRevision: (id) =>
      inner.listPlatformArtifactsByDraftRevision(id),
    listComplianceResultsByDraftRevision: (id) =>
      inner.listComplianceResultsByDraftRevision(id),
    listApprovalsByPipelineRun: (id) => inner.listApprovalsByPipelineRun(id),
    listTransitions: (id) => inner.listTransitions(id),
    getDelivery: (id) => inner.getDelivery(id),
    getDeliveryByIdempotencyKey: (key) => inner.getDeliveryByIdempotencyKey(key),
    listDeliveriesByApproval: (id) => inner.listDeliveriesByApproval(id),
    commitGuardedTransition: (): Promise<GuardedTransitionOutcome> => {
      throw failure;
    },
    recordDelivery: (record) => inner.recordDelivery(record),
  };
}

interface StateSnapshot {
  readonly run: PipelineRun | undefined;
  readonly activeRevision: DraftRevision | undefined;
  readonly transitions: readonly unknown[];
}

async function snapshot(repository: InMemoryRepository): Promise<StateSnapshot> {
  const run = await repository.getPipelineRun(RUN_ID);
  return {
    run,
    activeRevision:
      run?.activeDraftRevisionId === undefined
        ? undefined
        : await repository.getDraftRevision(run.activeDraftRevisionId),
    transitions: await repository.listTransitions(RUN_ID),
  };
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : `NO_CODE(${String(error)})`;
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * Every palette entry is exactly one Unicode code point, so generated text has an exact
 * code-point length while astral entries make the UTF-16 `.length` strictly larger.
 */
const PALETTES = {
  ascii: ["x"],
  unicode: ["a", "Ế", "\u0301", "\u{1F600}", "ạ", "Đ", "\u{1F1FB}", "n"],
  combining: ["e", "\u0301", "\u0323", "ơ"],
  astral: ["\u{1F600}", "\u{1F9E0}", "\u{1F1FB}", "\u{1D400}"],
  blank: [" "],
} as const;

type Flavor = keyof typeof PALETTES;

function textOfCodePoints(length: number, flavor: Flavor, offset: number): string {
  const palette = PALETTES[flavor];
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += palette[(index + offset) % palette.length];
  }
  return text;
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

const FIELD_NAMES = [
  "facebookPost",
  "guideHeading",
  "guideBody",
  "imageSuggestion",
  "videoIntro",
  "videoBody",
  "videoConclusion",
  "originLink",
  "language",
  "brandVoiceVersion",
] as const;

type FieldName = (typeof FIELD_NAMES)[number];

function withField(field: FieldName, value: string): ContentDraft {
  const section = BASE_CONTENT.guide[0];
  switch (field) {
    case "facebookPost":
      return { ...BASE_CONTENT, facebookPost: value };
    case "guideHeading":
      return { ...BASE_CONTENT, guide: [{ ...section, heading: value }] };
    case "guideBody":
      return { ...BASE_CONTENT, guide: [{ ...section, body: value }] };
    case "imageSuggestion":
      return {
        ...BASE_CONTENT,
        guide: [{ ...section, imageSuggestions: [{ description: value }] }],
      };
    case "videoIntro":
      return {
        ...BASE_CONTENT,
        videoScript: { ...BASE_CONTENT.videoScript, intro: value },
      };
    case "videoBody":
      return {
        ...BASE_CONTENT,
        videoScript: { ...BASE_CONTENT.videoScript, body: value },
      };
    case "videoConclusion":
      return {
        ...BASE_CONTENT,
        videoScript: { ...BASE_CONTENT.videoScript, conclusion: value },
      };
    case "originLink":
      return { ...BASE_CONTENT, originLinks: [SOURCE_URL, value] };
    case "language":
      return { ...BASE_CONTENT, language: value };
    case "brandVoiceVersion":
      return { ...BASE_CONTENT, brandVoiceVersion: value };
  }
}

/** The longest editable field value, measured in Unicode code points. */
function longestFieldCodePoints(content: ContentDraft): number {
  const values = [
    content.facebookPost,
    content.videoScript.intro,
    content.videoScript.body,
    content.videoScript.conclusion,
    content.language,
    ...(content.brandVoiceVersion === undefined ? [] : [content.brandVoiceVersion]),
    ...content.originLinks,
    ...content.guide.flatMap((section) => [
      section.heading,
      section.body,
      ...section.imageSuggestions.map((suggestion) => suggestion.description),
    ]),
  ];
  return Math.max(...values.map(codePoints));
}

const VALID_OPERATORS: readonly AuthenticatedOperator[] = [
  { id: "operator-1", role: "Operator" },
  { id: "admin-1", role: "Admin" },
];

/** Unauthenticated or unauthorized actors that must never mutate a review. */
const INVALID_OPERATORS: readonly AuthenticatedOperator[] = [
  { id: "   ", role: "Operator" },
  { id: "", role: "Admin" },
  { id: "guest-1", role: "Viewer" } as unknown as AuthenticatedOperator,
  undefined as unknown as AuthenticatedOperator,
];

const operatorArbitrary = fc.oneof(
  fc.constantFrom(...VALID_OPERATORS).map((operator) => ({ operator, valid: true })),
  fc.constantFrom(...INVALID_OPERATORS).map((operator) => ({ operator, valid: false })),
);

/** 4999/5000/5001 are the exact editable-field boundaries named in the design. */
const fieldLengthArbitrary = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(4_999, 5_000, 5_001) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 5_200 }) },
);

/** 0/1/1000/1001 are the exact rejection-note boundaries named in the design. */
const noteLengthArbitrary = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(0, 1, 1_000, 1_001) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 1_100 }) },
);

const stageArbitrary = fc.constantFrom(...ALL_STAGES);
const expectedVersionArbitrary = fc.constantFrom(
  FIXTURE_VERSION,
  FIXTURE_VERSION - 1,
  FIXTURE_VERSION + 1,
);
const flavorArbitrary = fc.constantFrom<Flavor>("ascii", "unicode", "combining", "astral");
const offsetArbitrary = fc.integer({ min: 0, max: 7 });

describe("generator strength", () => {
  it("builds exact code-point lengths where UTF-16 length differs for astral text", () => {
    for (const length of [0, 1, 1_000, 1_001, 4_999, 5_000, 5_001]) {
      for (const flavor of ["ascii", "unicode", "combining", "astral"] as const) {
        const text = textOfCodePoints(length, flavor, 0);
        expect(codePoints(text)).toBe(length);
      }
    }
    expect(textOfCodePoints(1_000, "astral", 0).length).toBeGreaterThan(1_000);
    expect(textOfCodePoints(1_000, "unicode", 0).length).toBeGreaterThan(1_000);
    expect(textOfCodePoints(1_000, "combining", 0).length).toBe(1_000);
    expect(textOfCodePoints(5_000, "unicode", 0).length).toBeGreaterThan(5_000);
  });
});

describe("ReviewDashboardApi properties", () => {
  // Feature: fb-ai, Property 29: Edits are bounded and only allowed while pending
  // **Validates: Requirements 8.2**
  it("accepts an edit only for a bounded field set at the current PendingApproval version", async () => {
    await fc.assert(
      fc.asyncProperty(
        stageArbitrary,
        expectedVersionArbitrary,
        operatorArbitrary,
        fc.constantFrom(...FIELD_NAMES),
        fieldLengthArbitrary,
        flavorArbitrary,
        offsetArbitrary,
        async (stage, expectedVersion, actor, field, length, flavor, offset) => {
          const { repository, api } = await setup(stage);
          const before = await snapshot(repository);
          const content = withField(field, textOfCodePoints(length, flavor, offset));
          const nextRevisionId = `${DRAFT_ID}:revision:2:${hashDraftContent(content).slice(0, 12)}`;
          const editable = stage === "PendingApproval" && expectedVersion === FIXTURE_VERSION;
          const expectedCode = !actor.valid
            ? "AUTHORIZATION_REQUIRED"
            : !editable
              ? expectedVersion === FIXTURE_VERSION
                ? "INVALID_STATE"
                : "CONFLICT"
              : longestFieldCodePoints(content) > 5_000
                ? "INVALID_EDIT"
                : undefined;
          const command = {
            operator: actor.operator,
            expectedVersion,
            idempotencyKey: "edit-1",
            patch: { content },
          };

          if (expectedCode !== undefined) {
            const error = await captureError(() => api.editDraft(RUN_ID, command));
            expect(errorCode(error)).toBe(expectedCode);
            // A refused edit is a true no-op: stage, version, active revision, content, history.
            expect(await snapshot(repository)).toEqual(before);
            expect(await repository.getDraftRevision(nextRevisionId)).toBeUndefined();
            return;
          }

          const saved = await api.editDraft(RUN_ID, command);
          expect(saved).toMatchObject({
            id: nextRevisionId,
            draftId: DRAFT_ID,
            revision: 2,
            parentRevisionId: REVISION_ID,
            createdBy: "Operator",
            actorId: actor.operator.id,
            contentHash: hashDraftContent(content),
          });
          expect(saved.content).toEqual(content);
          expect(await repository.getDraftRevision(REVISION_ID)).toEqual(revisionFixture);
          expect(await repository.getPipelineRun(RUN_ID)).toMatchObject({
            stage: "Generated",
            workStatus: "Ready",
            version: FIXTURE_VERSION + 1,
            activeDraftRevisionId: nextRevisionId,
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: fb-ai, Property 30: Reject-with-note validity and persistence
  // **Validates: Requirements 8.4, 8.5**
  it("rejects only with a persisted 1..1000 character note and otherwise changes nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        stageArbitrary,
        expectedVersionArbitrary,
        operatorArbitrary,
        noteLengthArbitrary,
        fc.constantFrom<Flavor>("ascii", "unicode", "combining", "astral", "blank"),
        offsetArbitrary,
        async (stage, expectedVersion, actor, length, flavor, offset) => {
          const { repository, api } = await setup(stage);
          const before = await snapshot(repository);
          const note = textOfCodePoints(length, flavor, offset);
          const trimmed = note.trim();
          const noteValid = codePoints(trimmed) >= 1 && codePoints(trimmed) <= 1_000;
          const current = stage === "PendingApproval" && expectedVersion === FIXTURE_VERSION;
          const expectedCode = !actor.valid
            ? "AUTHORIZATION_REQUIRED"
            : !noteValid
              ? "INVALID_REJECTION"
              : !current
                ? "CONFLICT"
                : undefined;
          const command = {
            operator: actor.operator,
            expectedVersion,
            note,
            idempotencyKey: "reject-1",
          };

          if (expectedCode !== undefined) {
            const error = await captureError(() => api.reject(RUN_ID, command));
            expect(errorCode(error)).toBe(expectedCode);
            // A refused rejection is a true no-op: stage, version, active revision, content, history.
            expect(await snapshot(repository)).toEqual(before);
            return;
          }

          const run = await api.reject(RUN_ID, command);
          expect(run).toMatchObject({
            stage: "Rejected",
            workStatus: "Rejected",
            version: FIXTURE_VERSION + 1,
            activeDraftRevisionId: REVISION_ID,
            blockedReason: `[PendingApproval] ${trimmed}`,
          });
          const transitions = await repository.listTransitions(RUN_ID);
          expect(transitions.at(-1)).toMatchObject({
            fromStage: "PendingApproval",
            toStage: "Rejected",
            actorType: "Operator",
            actorId: actor.operator.id,
            reason: trimmed,
          });
          expect(await repository.getDraftRevision(REVISION_ID)).toEqual(revisionFixture);
        },
      ),
      { numRuns: 200 },
    );
  });
});

const contentArbitrary = fc
  .record({
    flavor: flavorArbitrary,
    offset: offsetArbitrary,
    postLength: fc.oneof(
      { weight: 3, arbitrary: fc.constantFrom(4_999, 5_000) },
      { weight: 2, arbitrary: fc.integer({ min: 1, max: 300 }) },
    ),
    fieldLength: fc.oneof(
      { weight: 3, arbitrary: fc.constantFrom(4_999, 5_000) },
      { weight: 2, arbitrary: fc.integer({ min: 1, max: 120 }) },
    ),
    sectionCount: fc.integer({ min: 1, max: 3 }),
    language: fc.constantFrom("vi", "en", "vi-VN"),
    brandVoiceVersion: fc.option(fc.constantFrom("voice-v1", "văn-phong-v2"), {
      nil: undefined,
    }),
  })
  .map(({ flavor, offset, postLength, fieldLength, sectionCount, language, brandVoiceVersion }): ContentDraft => ({
    topicId: TOPIC_ID,
    facebookPost: textOfCodePoints(postLength, flavor, offset),
    guide: Array.from({ length: sectionCount }, (_unused, index) => ({
      heading: textOfCodePoints(Math.min(fieldLength, 80), flavor, offset + index),
      body: textOfCodePoints(fieldLength, flavor, offset + index),
      imageSuggestions: [{
        description: textOfCodePoints(Math.min(fieldLength, 500), flavor, index),
      }],
    })),
    videoScript: {
      intro: textOfCodePoints(fieldLength, flavor, offset),
      body: textOfCodePoints(fieldLength, flavor, offset + 1),
      conclusion: textOfCodePoints(fieldLength, flavor, offset + 2),
    },
    originLinks: [SOURCE_URL],
    language,
    ...(brandVoiceVersion === undefined ? {} : { brandVoiceVersion }),
  }));

describe("ReviewDashboardApi edit round-trip", () => {
  // Feature: fb-ai, Property 31: Saved edits round-trip
  // **Validates: Requirements 8.8**
  it("stores an edit as immutable revision N+1, returns to Generated, and reloads exactly", async () => {
    await fc.assert(
      fc.asyncProperty(
        contentArbitrary,
        fc.constantFrom(...VALID_OPERATORS),
        async (content, operator) => {
          const { repository, api } = await setup("PendingApproval");

          const saved = await api.editDraft(RUN_ID, {
            operator,
            expectedVersion: FIXTURE_VERSION,
            idempotencyKey: "edit-1",
            patch: { content },
          });

          expect(saved).toMatchObject({
            draftId: DRAFT_ID,
            revision: 2,
            parentRevisionId: REVISION_ID,
            createdBy: "Operator",
            actorId: operator.id,
            contentHash: hashDraftContent(content),
          });
          // Revision N stays immutable.
          expect(await repository.getDraftRevision(REVISION_ID)).toEqual(revisionFixture);

          // Reloading yields exactly the saved content and returns to Generated for re-verification.
          const reloaded = await api.getDraft(RUN_ID);
          expect(reloaded.revision).toEqual(saved);
          expect(reloaded.revision.content).toEqual(content);
          expect(reloaded.run).toMatchObject({
            stage: "Generated",
            workStatus: "Ready",
            version: FIXTURE_VERSION + 1,
            activeDraftRevisionId: saved.id,
          });

          // Prior verification/compliance evidence cannot authorize the new revision.
          expect(reloaded.verification).toBeUndefined();
          expect(reloaded.artifacts).toEqual([]);
          expect(reloaded.compliance).toEqual([]);
          expect(await repository.listVerificationReportsByDraftRevision(saved.id)).toEqual([]);
          expect(await repository.listPlatformArtifactsByDraftRevision(saved.id)).toEqual([]);
          expect(await repository.listComplianceResultsByDraftRevision(saved.id)).toEqual([]);
          // The superseded evidence is retained for audit.
          expect(
            await repository.listVerificationReportsByDraftRevision(REVISION_ID),
          ).toHaveLength(1);

          // Approval eligibility is cleared for both the old and the new revision.
          const approvalBase = {
            operator,
            expectedVersion: FIXTURE_VERSION + 1,
            confirmed: true as const,
            verificationReportId: REPORT_ID,
            complianceResultIds: [COMPLIANCE_ID],
            artifactIds: [ARTIFACT_ID],
            artifactHashes: [ARTIFACT_HASH],
          };
          expect(errorCode(await captureError(() => api.approve(RUN_ID, {
            ...approvalBase,
            draftRevisionId: REVISION_ID,
            contentHash: revisionFixture.contentHash,
            idempotencyKey: "approve-old-revision",
          })))).toBe("EVIDENCE_MISMATCH");
          expect(errorCode(await captureError(() => api.approve(RUN_ID, {
            ...approvalBase,
            draftRevisionId: saved.id,
            contentHash: saved.contentHash,
            idempotencyKey: "approve-new-revision",
          })))).toBe("EVIDENCE_MISMATCH");
          expect(await repository.listApprovalsByPipelineRun(RUN_ID)).toEqual([]);

          // A stale-version edit conflicts instead of overwriting another Operator's work.
          const afterEdit = await snapshot(repository);
          expect(errorCode(await captureError(() => api.editDraft(RUN_ID, {
            operator,
            expectedVersion: FIXTURE_VERSION,
            idempotencyKey: "edit-stale",
            patch: { content: BASE_CONTENT },
          })))).toBe("CONFLICT");
          expect(await snapshot(repository)).toEqual(afterEdit);
        },
      ),
      { numRuns: 120 },
    );
  });

  // Task 14.5 unit test
  // **Validates: Requirements 8.9**
  it("preserves the pre-edit active revision and reports SAVE_FAILED when the save fails", async () => {
    const failure = new Error("transaction rolled back");
    const { repository, api } = await setup("PendingApproval", (inner) =>
      saveFailingRepository(inner, failure));
    const before = await snapshot(repository);
    const edited: ContentDraft = {
      ...BASE_CONTENT,
      facebookPost: "Nội dung đã chỉnh sửa 🙂",
    };

    const error = await captureError(() => api.editDraft(RUN_ID, {
      operator: VALID_OPERATORS[0],
      expectedVersion: FIXTURE_VERSION,
      idempotencyKey: "edit-save-failure",
      patch: { content: edited },
    }));

    expect(error).toBeInstanceOf(DashboardApiError);
    expect(errorCode(error)).toBe("SAVE_FAILED");
    expect((error as DashboardApiError).cause).toBe(failure);
    expect(await snapshot(repository)).toEqual(before);
    expect(await repository.getPipelineRun(RUN_ID)).toMatchObject({
      stage: "PendingApproval",
      workStatus: "Ready",
      version: FIXTURE_VERSION,
      activeDraftRevisionId: REVISION_ID,
    });
    expect(await repository.getDraftRevision(REVISION_ID)).toEqual(revisionFixture);
    expect(
      await repository.getDraftRevision(
        `${DRAFT_ID}:revision:2:${hashDraftContent(edited).slice(0, 12)}`,
      ),
    ).toBeUndefined();
  });
});
