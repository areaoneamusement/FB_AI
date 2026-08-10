import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ModelBCritiquePort,
  ModelBCritiqueRequest,
  ModelBCritiqueResponse,
  ModelCallControl,
} from "../src/adapters/ports.js";
import type {
  Claim,
  ContentDraft,
  DraftRevision,
  ReproducibilityMetadata,
  ResearchItem,
  ResearchKind,
  ResearchResult,
  SourceReference,
  VerificationFinding,
  VerificationReport,
} from "../src/domain/index.js";
import { hashGenerationValue } from "../src/pipeline/content-generator.js";
import {
  DEFAULT_VERIFICATION_MAX_ROUNDS,
  VerificationEngine,
  VerificationInputError,
  extractClaims,
  type ModelACorrectionPort,
  type VerificationEngineDependencies,
  type VerificationOperations,
  type VerificationResult,
  type VerifyDraftCommand,
} from "../src/pipeline/verification-engine.js";

const RUNS = 100;
const NOW = new Date("2025-05-01T10:00:00.000Z");
const TOPIC_ID = "topic-kiem-chung";

const MODEL_B: ReproducibilityMetadata = {
  provider: "provider-b",
  model: "critic-b",
  promptVersion: "verify-v2",
  configurationVersion: "config-v4",
};
const MODEL_A: ReproducibilityMetadata = {
  provider: "provider-a",
  model: "corrector-a",
  promptVersion: "correct-v1",
  configurationVersion: "config-v2",
};

/** A reference that is deliberately absent from every generated corpus. */
const FOREIGN_REFERENCE: SourceReference = {
  sourceId: "source-ngoai-corpus",
  captureId: "capture-ngoai-corpus",
  url: "https://khong-co-trong-corpus.test/tham-chieu",
  capturedAt: "2025-04-30T00:00:00.000Z",
  termsVersion: "terms-foreign",
};

// ---------------------------------------------------------------------------
// Vietnamese / non-ASCII prose builders.
//
// Sentence terminators include `。！？` and separators include CRLF so the
// deterministic claim extractor is exercised on the exact boundary characters
// the design names.
// ---------------------------------------------------------------------------

const WORDS = [
  "Công cụ AI mới ra mắt",
  "Phiên bản cập nhật chạy nhanh hơn",
  "Mô hình nguồn mở 🚀 hỗ trợ tiếng Việt",
  "Dữ liệu được trích từ nguồn gốc",
  "Bản ghi kiểm chứng đã lưu lại",
] as const;
const TERMINATORS = [".", "!", "?", "。", "！", "？"] as const;
const SEPARATORS = [" ", "\r\n", "\n", "\r", "  "] as const;

interface SentenceSpec {
  readonly word: number;
  readonly terminator: number;
  readonly separator: number;
}

const sentenceSpec: fc.Arbitrary<SentenceSpec> = fc.record({
  word: fc.nat({ max: WORDS.length - 1 }),
  terminator: fc.nat({ max: TERMINATORS.length - 1 }),
  separator: fc.nat({ max: SEPARATORS.length - 1 }),
});

function proseOf(specs: readonly SentenceSpec[]): string {
  return specs
    .map(
      (spec) =>
        `${WORDS[spec.word]}${TERMINATORS[spec.terminator]}${SEPARATORS[spec.separator]}`,
    )
    .join("");
}

function sentence(index: number): string {
  return `${WORDS[index % WORDS.length]}${TERMINATORS[index % TERMINATORS.length]}`;
}

/**
 * A draft whose only prose lives in the Facebook post, so the generated claim
 * count starts at 1 and grows with the sentence list.
 */
function minimalContent(specs: readonly SentenceSpec[]): ContentDraft {
  return {
    topicId: TOPIC_ID,
    facebookPost: proseOf(specs),
    guide: [],
    videoScript: { intro: "", body: "", conclusion: "" },
    originLinks: [reference(0).url],
    language: "vi",
  };
}

/** A draft that also satisfies every Requirement 4 format bound, so Model A corrections are accepted. */
function fullContent(specs: readonly SentenceSpec[]): ContentDraft {
  return {
    topicId: TOPIC_ID,
    facebookPost: `${proseOf(specs)}Bản nháp tiếng Việt này đủ dài để đưa vào kiểm chứng nội dung。`,
    guide: [0, 1, 2].map((index) => ({
      heading: `Phần ${index + 1} kiểm chứng`,
      body: `${proseOf(specs)}${sentence(index)}`,
      imageSuggestions: [
        { description: `Minh họa chi tiết cho phần ${index + 1} kèm nguồn rõ ràng` },
      ],
    })),
    videoScript: {
      intro: sentence(0),
      body: sentence(1),
      conclusion: sentence(2),
    },
    originLinks: [reference(0).url],
    language: "vi",
  };
}

function reference(index: number): SourceReference {
  return {
    sourceId: `source-${index}`,
    captureId: `capture-${index}`,
    url: `https://example.test/nguon-${index}`,
    capturedAt: "2025-05-01T09:00:00.000Z",
    termsVersion: `terms-v${index}`,
  };
}

function makeRevision(
  content: ContentDraft,
  overrides: Partial<DraftRevision> = {},
): DraftRevision {
  return {
    id: "revision-1",
    draftId: "draft-1",
    revision: 1,
    content,
    contentHash: hashGenerationValue(content),
    createdBy: "System",
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Research corpora: all-Inferred, all-source-backed, and mixed.
// ---------------------------------------------------------------------------

const researchKind = fc.constantFrom<ResearchKind>(
  "Quoted",
  "Summarized",
  "Inferred",
);

const corpusKinds: fc.Arbitrary<readonly ResearchKind[]> = fc.oneof(
  fc.array(researchKind, { minLength: 1, maxLength: 4 }),
  // All inferred: context only, never independent factual evidence.
  fc.array(fc.constant<ResearchKind>("Inferred"), { minLength: 1, maxLength: 3 }),
  // All source-backed.
  fc.array(fc.constantFrom<ResearchKind>("Quoted", "Summarized"), {
    minLength: 1,
    maxLength: 3,
  }),
  // Mixed by construction.
  fc
    .tuple(
      fc.constantFrom<ResearchKind>("Quoted", "Summarized"),
      fc.constant<ResearchKind>("Inferred"),
    )
    .map(([backed, inferred]) => [backed, inferred] as readonly ResearchKind[]),
);

function researchOf(kinds: readonly ResearchKind[]): ResearchResult {
  const items: ResearchItem[] = kinds.map((kind, index) => ({
    id: `research-item-${index}`,
    content: `Mục research ${index} về công cụ AI.`,
    kind,
    evidenceRefs: [reference(index)],
    ...(kind === "Inferred" ? { modelProvenance: MODEL_B } : {}),
  }));
  return {
    id: "research-1",
    topicId: TOPIC_ID,
    items,
    status: "Ok",
    unreachableSources: [],
  };
}

function corpusKeys(research: ResearchResult): ReadonlySet<string> {
  return new Set(
    research.items.flatMap((item) =>
      item.evidenceRefs.map((entry) => referenceKey(entry)),
    ),
  );
}

function sourceBackedKeys(research: ResearchResult): ReadonlySet<string> {
  return new Set(
    research.items
      .filter((item) => item.kind !== "Inferred")
      .flatMap((item) => item.evidenceRefs.map((entry) => referenceKey(entry))),
  );
}

function referenceKey(entry: SourceReference): string {
  return JSON.stringify([
    entry.sourceId,
    entry.captureId,
    entry.url,
    entry.capturedAt,
    entry.termsVersion,
  ]);
}

// ---------------------------------------------------------------------------
// Model B response plans plus an independent model of the accepted outcome.
// ---------------------------------------------------------------------------

type Verdict = VerificationFinding["verdict"];
type DescriptionMode = "text" | "missing" | "whitespace";
type EvidenceMode = "corpus" | "foreign" | "none";
type CoverageMode = "complete" | "dropLast" | "duplicateFirst" | "unknownId" | "extra";

interface FindingPlan {
  readonly verdict: Verdict;
  readonly itemIndex: number;
  readonly description: DescriptionMode;
  readonly evidence: EvidenceMode;
}

const findingPlan: fc.Arbitrary<FindingPlan> = fc.record({
  verdict: fc.constantFrom<Verdict>("Pass", "Contradiction", "Unsupported"),
  itemIndex: fc.nat({ max: 5 }),
  description: fc.constantFrom<DescriptionMode>("text", "missing", "whitespace"),
  evidence: fc.constantFrom<EvidenceMode>("corpus", "corpus", "foreign", "none"),
});

type Expectation =
  | { readonly kind: "Finding"; readonly verdict: Verdict }
  | { readonly kind: "Invalid" };

/** The accepted outcome for a single planned finding, derived from Requirement 5.2/5.3. */
function classify(plan: FindingPlan, research: ResearchResult): Expectation {
  if (plan.evidence !== "corpus") return { kind: "Invalid" };
  const item = research.items[plan.itemIndex % research.items.length];
  const sourceBacked = item.kind !== "Inferred";
  if (plan.verdict === "Pass") {
    // Inferred research alone can never substantiate a Pass.
    return sourceBacked
      ? { kind: "Finding", verdict: "Pass" }
      : { kind: "Finding", verdict: "Unsupported" };
  }
  if (plan.verdict === "Contradiction" && !sourceBacked) return { kind: "Invalid" };
  return plan.description === "text"
    ? { kind: "Finding", verdict: plan.verdict }
    : { kind: "Invalid" };
}

function planFor(plans: readonly FindingPlan[], index: number): FindingPlan {
  return plans[index % plans.length];
}

function expectedVerdicts(
  claims: readonly Claim[],
  research: ResearchResult,
  plans: readonly FindingPlan[],
): readonly Expectation[] {
  return claims.map((_claim, index) => classify(planFor(plans, index), research));
}

function findingsFor(
  claims: readonly Claim[],
  research: ResearchResult,
  plans: readonly FindingPlan[],
  options: { readonly coverage: CoverageMode; readonly shuffle: boolean },
): readonly VerificationFinding[] {
  const findings: VerificationFinding[] = claims.map((claim, index) => {
    const plan = planFor(plans, index);
    const item = research.items[plan.itemIndex % research.items.length];
    const evidenceRefs =
      plan.evidence === "corpus"
        ? [item.evidenceRefs[0]]
        : plan.evidence === "foreign"
          ? [FOREIGN_REFERENCE]
          : [];
    const description =
      plan.description === "text"
        ? `Nguồn research mô tả khác với phát biểu ${index}.`
        : plan.description === "whitespace"
          ? "   "
          : undefined;
    return {
      claimId: claim.id,
      verdict: plan.verdict,
      evidenceRefs,
      ...(description === undefined ? {} : { description }),
    };
  });

  const tampered = applyCoverage(findings, options.coverage);
  return options.shuffle ? [...tampered].reverse() : tampered;
}

function applyCoverage(
  findings: readonly VerificationFinding[],
  coverage: CoverageMode,
): readonly VerificationFinding[] {
  switch (coverage) {
    case "complete":
      return findings;
    case "dropLast":
      return findings.slice(0, findings.length - 1);
    case "duplicateFirst":
      return [...findings.slice(0, findings.length - 1), findings[0]];
    case "unknownId":
      return [
        ...findings.slice(0, findings.length - 1),
        { ...findings[findings.length - 1], claimId: "claim-khong-ton-tai" },
      ];
    case "extra":
      return [
        ...findings,
        { ...findings[0], claimId: "claim-them-ngoai-danh-sach" },
      ];
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type CritiqueHandler = (
  request: ModelBCritiqueRequest,
  control: ModelCallControl,
) => ModelBCritiqueResponse | Promise<ModelBCritiqueResponse>;

function modelB(handler: CritiqueHandler): ModelBCritiquePort {
  return { critique: vi.fn(async (request, control) => await handler(request, control)) };
}

function operations(): VerificationOperations & {
  recordError: ReturnType<typeof vi.fn>;
  notifyOperator: ReturnType<typeof vi.fn>;
} {
  return {
    recordError: vi.fn(async () => undefined),
    notifyOperator: vi.fn(async () => undefined),
  };
}

function idFactory(): NonNullable<VerificationEngineDependencies["createId"]> {
  const counts = new Map<string, number>();
  return (kind) => {
    const count = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, count);
    return `${kind}-${count}`;
  };
}

/**
 * Anything the engine must never touch. The engine is constructed only from
 * model ports, so reading a Repository or PipelineRun would throw here.
 */
function forbidden(name: string): unknown {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        throw new Error(`Verification engine read ${name}.${String(property)}`);
      },
      set: () => {
        throw new Error(`Verification engine mutated ${name}`);
      },
    },
  );
}

function engine(
  critic: ModelBCritiquePort,
  options: {
    readonly modelA?: ModelACorrectionPort;
    readonly operations?: VerificationOperations;
  } = {},
): VerificationEngine {
  const dependencies: Record<string, unknown> = {
    now: () => NOW,
    createId: idFactory(),
    ...(options.modelA === undefined ? {} : { modelA: options.modelA }),
  };
  // Workflow state and persistence are not part of this engine's contract.
  dependencies.repository = forbidden("Repository");
  dependencies.pipelineRun = forbidden("PipelineRun");
  return new VerificationEngine(
    critic,
    options.operations,
    dependencies as VerificationEngineDependencies,
  );
}

const RESULT_KEYS = new Set([
  "kind",
  "eligibleStage",
  "workStatus",
  "activeRevision",
  "claims",
  "report",
  "attempts",
  "artifacts",
  "failure",
  "error",
  "notification",
]);

/** The engine returns evidence and a recommendation only; it never carries workflow state. */
function expectNoWorkflowMutation(result: VerificationResult): void {
  for (const key of Object.keys(result)) {
    expect(RESULT_KEYS.has(key)).toBe(true);
  }
  for (const key of ["run", "pipelineRun", "repository", "stage", "version", "approval"]) {
    expect(key in result).toBe(false);
  }
}

function expectBoundToRevision(
  report: VerificationReport,
  revision: DraftRevision,
  research: ResearchResult,
): void {
  expect(report.draftRevisionId).toBe(revision.id);
  expect(report.contentHash).toBe(revision.contentHash);
  expect(report.contentHash).toBe(hashGenerationValue(revision.content));
  expect(report.researchResultId).toBe(research.id);
  expect(Object.isFrozen(report)).toBe(true);
}

function coverageIsInvalid(coverage: CoverageMode, claimCount: number): boolean {
  switch (coverage) {
    case "complete":
      return false;
    case "duplicateFirst":
      // With a single claim the "duplicate" is the claim itself.
      return claimCount >= 2;
    case "dropLast":
    case "unknownId":
    case "extra":
      return true;
  }
}

function invalidReason(plan: FindingPlan, research: ResearchResult): string {
  if (plan.evidence === "none") return "must cite research evidence";
  if (plan.evidence === "foreign") return "cites evidence outside the research corpus";
  const item = research.items[plan.itemIndex % research.items.length];
  if (plan.verdict === "Contradiction" && item.kind === "Inferred") {
    return "must cite source-backed research evidence";
  }
  return "requires a useful description";
}

/** The order Model B's findings are consumed in, which decides the first rejected finding. */
function consumptionOrder(claimCount: number, shuffle: boolean): readonly number[] {
  const order = Array.from({ length: claimCount }, (_unused, index) => index);
  return shuffle ? [...order].reverse() : order;
}

const coverageMode = fc.constantFrom<CoverageMode>(
  "complete",
  "complete",
  "complete",
  "dropLast",
  "duplicateFirst",
  "unknownId",
  "extra",
);

const sentenceSpecs = fc.array(sentenceSpec, { minLength: 1, maxLength: 5 });
const plans = fc.array(findingPlan, { minLength: 1, maxLength: 4 });

describe("Verification_Engine properties (Requirement 5)", () => {
  // Feature: fb-ai, Property 18: The verification report covers every extracted claim with exactly one verdict, in claim order, with no duplicates and no unknown claim ids
  // **Validates: Requirements 5.2, 5.4**
  it("Property 18: the report covers every extracted claim with exactly one ordered verdict", async () => {
    await fc.assert(
      fc.asyncProperty(
        sentenceSpecs,
        corpusKinds,
        plans,
        coverageMode,
        fc.boolean(),
        fc.constantFrom(1, 5),
        fc.constantFrom(1, 3),
        async (specs, kinds, findingPlans, coverage, shuffle, maxRounds, maxAttempts) => {
          const content = minimalContent(specs);
          const revision = makeRevision(content);
          const research = researchOf(kinds);
          const claims = extractClaims(revision);

          // Claim counts start at 1 and grow with the generated prose.
          expect(claims.length).toBe(specs.length);
          expect(claims.length).toBeGreaterThanOrEqual(1);

          const critic = modelB((request) => ({
            provenance: MODEL_B,
            findings: findingsFor(request.claims, research, findingPlans, {
              coverage,
              shuffle,
            }),
          }));
          const result = await engine(critic).verify({
            revision,
            research,
            requestedModel: MODEL_B,
            // Starting at the final round keeps this property to a single critique.
            round: maxRounds,
            maxRounds,
            maxAttempts,
          });
          expectNoWorkflowMutation(result);

          const expectations = expectedVerdicts(claims, research, findingPlans);
          const rejected =
            coverageIsInvalid(coverage, claims.length) ||
            expectations.some((entry) => entry.kind === "Invalid");

          if (rejected) {
            // A malformed manifest never becomes a report at all.
            expect(result.kind).toBe("RetryableBlocked");
            if (result.kind !== "RetryableBlocked") return;
            expect(result.failure).toBe("InvalidModelResponse");
            expect(result.eligibleStage).toBe("Generated");
            expect(result.workStatus).toBe("RetryableBlocked");
            expect("report" in result).toBe(false);
            expect(result.error.attempts).toBe(maxAttempts);
            expect(result.artifacts.reports).toHaveLength(0);
            return;
          }

          expect(result.kind === "Passed" || result.kind === "VerificationBlocked").toBe(
            true,
          );
          if (result.kind === "RetryableBlocked") return;

          const report = result.report;
          expectBoundToRevision(report, revision, research);
          expect(report.round).toBe(maxRounds);
          expect(report.modelB).toEqual(MODEL_B);

          // Exactly one verdict per claim, in claim order, no duplicates, no strangers.
          expect(report.findings).toHaveLength(claims.length);
          expect(report.findings.map((finding) => finding.claimId)).toEqual(
            claims.map((claim) => claim.id),
          );
          expect(new Set(report.findings.map((finding) => finding.claimId)).size).toBe(
            claims.length,
          );
          const claimIds = new Set(claims.map((claim) => claim.id));
          for (const finding of report.findings) {
            expect(claimIds.has(finding.claimId)).toBe(true);
            expect(["Pass", "Contradiction", "Unsupported"]).toContain(finding.verdict);
            expect(Object.isFrozen(finding)).toBe(true);
          }
          expect(report.findings.map((finding) => finding.verdict)).toEqual(
            expectations.map((entry) =>
              entry.kind === "Finding" ? entry.verdict : "Invalid",
            ),
          );
          expect(report.passed).toBe(
            report.findings.every((finding) => finding.verdict === "Pass"),
          );
          expect(result.claims.map((claim) => claim.id)).toEqual(
            claims.map((claim) => claim.id),
          );
        },
      ),
      {
        numRuns: RUNS,
        examples: [
          // Single claim, single all-source-backed research item, minimum bounds.
          [
            [{ word: 0, terminator: 0, separator: 0 }],
            ["Quoted"],
            [{ verdict: "Pass", itemIndex: 0, description: "text", evidence: "corpus" }],
            "complete",
            false,
            1,
            1,
          ],
          // CRLF separated Vietnamese prose with `。！？` terminators, maxRounds 5.
          [
            [
              { word: 2, terminator: 3, separator: 1 },
              { word: 3, terminator: 4, separator: 1 },
              { word: 4, terminator: 5, separator: 3 },
            ],
            ["Summarized", "Inferred"],
            [
              { verdict: "Pass", itemIndex: 0, description: "missing", evidence: "corpus" },
              {
                verdict: "Contradiction",
                itemIndex: 0,
                description: "text",
                evidence: "corpus",
              },
            ],
            "complete",
            true,
            5,
            3,
          ],
          // Duplicate claim id must be refused.
          [
            [
              { word: 0, terminator: 3, separator: 1 },
              { word: 1, terminator: 4, separator: 1 },
            ],
            ["Quoted"],
            [{ verdict: "Pass", itemIndex: 0, description: "text", evidence: "corpus" }],
            "duplicateFirst",
            false,
            1,
            3,
          ],
          // Unknown claim id must be refused.
          [
            [{ word: 1, terminator: 5, separator: 1 }],
            ["Summarized"],
            [{ verdict: "Pass", itemIndex: 0, description: "text", evidence: "corpus" }],
            "unknownId",
            false,
            5,
            1,
          ],
          // Missing coverage must be refused.
          [
            [
              { word: 0, terminator: 0, separator: 4 },
              { word: 2, terminator: 3, separator: 1 },
            ],
            ["Quoted", "Inferred"],
            [
              {
                verdict: "Unsupported",
                itemIndex: 1,
                description: "text",
                evidence: "corpus",
              },
            ],
            "dropLast",
            false,
            1,
            3,
          ],
        ] as never,
      },
    );
  });

  // Feature: fb-ai, Property 19: Contradiction findings carry a research reference drawn from the research corpus and a non-empty description; `Unsupported` likewise. `Inferred` research alone can never produce `Pass`
  // **Validates: Requirements 5.3**
  it("Property 19: non-pass findings carry corpus evidence and a description, and inferred research alone never passes", async () => {
    await fc.assert(
      fc.asyncProperty(
        sentenceSpecs,
        corpusKinds,
        plans,
        fc.boolean(),
        fc.constantFrom(1, 3),
        async (specs, kinds, findingPlans, shuffle, maxAttempts) => {
          const content = minimalContent(specs);
          const revision = makeRevision(content);
          const research = researchOf(kinds);
          const claims = extractClaims(revision);
          const corpus = corpusKeys(research);
          const backed = sourceBackedKeys(research);

          const critic = modelB((request) => ({
            provenance: MODEL_B,
            findings: findingsFor(request.claims, research, findingPlans, {
              coverage: "complete",
              shuffle,
            }),
          }));
          const result = await engine(critic).verify({
            revision,
            research,
            requestedModel: MODEL_B,
            round: 1,
            maxRounds: 1,
            maxAttempts,
          });
          expectNoWorkflowMutation(result);

          const expectations = expectedVerdicts(claims, research, findingPlans);
          const order = consumptionOrder(claims.length, shuffle);
          const firstRejected = order.find(
            (index) => expectations[index].kind === "Invalid",
          );

          if (firstRejected !== undefined) {
            expect(result.kind).toBe("RetryableBlocked");
            if (result.kind !== "RetryableBlocked") return;
            expect(result.failure).toBe("InvalidModelResponse");
            expect("report" in result).toBe(false);
            expect(result.error.reason).toContain(
              invalidReason(planFor(findingPlans, firstRejected), research),
            );
            return;
          }

          expect(result.kind === "Passed" || result.kind === "VerificationBlocked").toBe(
            true,
          );
          if (result.kind === "RetryableBlocked") return;
          const report = result.report;
          expectBoundToRevision(report, revision, research);

          report.findings.forEach((finding, index) => {
            const plan = planFor(findingPlans, index);
            const item = research.items[plan.itemIndex % research.items.length];

            // Every finding cites the research corpus, never anything outside it.
            expect(finding.evidenceRefs.length).toBeGreaterThanOrEqual(1);
            for (const entry of finding.evidenceRefs) {
              expect(corpus.has(referenceKey(entry))).toBe(true);
            }

            if (finding.verdict === "Pass") {
              // A pass always rests on at least one source-backed capture.
              expect(
                finding.evidenceRefs.some((entry) => backed.has(referenceKey(entry))),
              ).toBe(true);
              expect(item.kind).not.toBe("Inferred");
            } else {
              expect(typeof finding.description).toBe("string");
              expect((finding.description ?? "").trim().length).toBeGreaterThan(0);
            }

            // Inferred research alone can never produce Pass.
            if (plan.verdict === "Pass" && item.kind === "Inferred") {
              expect(finding.verdict).toBe("Unsupported");
              expect(finding.description).toContain("source-backed");
            }
          });

          if (research.items.every((item) => item.kind === "Inferred")) {
            expect(report.findings.some((finding) => finding.verdict === "Pass")).toBe(
              false,
            );
            expect(report.passed).toBe(false);
            expect(result.kind).toBe("VerificationBlocked");
          }
          expect(report.passed).toBe(
            report.findings.every((finding) => finding.verdict === "Pass"),
          );
        },
      ),
      {
        numRuns: RUNS,
        examples: [
          // All-inferred corpus: a claimed Pass is downgraded, never approved.
          [
            [{ word: 0, terminator: 3, separator: 1 }],
            ["Inferred"],
            [{ verdict: "Pass", itemIndex: 0, description: "missing", evidence: "corpus" }],
            false,
            3,
          ],
          // All-inferred corpus: a contradiction without source-backed evidence is refused.
          [
            [{ word: 1, terminator: 4, separator: 1 }],
            ["Inferred", "Inferred"],
            [
              {
                verdict: "Contradiction",
                itemIndex: 0,
                description: "text",
                evidence: "corpus",
              },
            ],
            false,
            1,
          ],
          // Source-backed contradiction without a description is refused.
          [
            [{ word: 2, terminator: 5, separator: 1 }],
            ["Quoted"],
            [
              {
                verdict: "Contradiction",
                itemIndex: 0,
                description: "missing",
                evidence: "corpus",
              },
            ],
            false,
            3,
          ],
          // Whitespace-only description is not a description.
          [
            [{ word: 3, terminator: 0, separator: 1 }],
            ["Summarized"],
            [
              {
                verdict: "Unsupported",
                itemIndex: 0,
                description: "whitespace",
                evidence: "corpus",
              },
            ],
            true,
            3,
          ],
          // Evidence outside the corpus is refused.
          [
            [{ word: 4, terminator: 3, separator: 1 }],
            ["Quoted", "Inferred"],
            [
              {
                verdict: "Contradiction",
                itemIndex: 0,
                description: "text",
                evidence: "foreign",
              },
            ],
            false,
            1,
          ],
          // Mixed corpus, described contradiction on a source-backed item.
          [
            [
              { word: 0, terminator: 3, separator: 1 },
              { word: 2, terminator: 4, separator: 1 },
            ],
            ["Quoted", "Inferred"],
            [
              {
                verdict: "Contradiction",
                itemIndex: 0,
                description: "text",
                evidence: "corpus",
              },
              { verdict: "Pass", itemIndex: 1, description: "text", evidence: "corpus" },
            ],
            false,
            3,
          ],
        ] as never,
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 20 harness: a bounded correction loop over an all-source-backed corpus.
// ---------------------------------------------------------------------------

const BACKED_RESEARCH = researchOf(["Quoted", "Summarized"]);
const BACKED_REFERENCE = BACKED_RESEARCH.items[0].evidenceRefs[0];

function corrector(): ModelACorrectionPort {
  return {
    correct: vi.fn(async ({ revision: source }) => ({
      content: {
        ...source.content,
        facebookPost: `${source.content.facebookPost} Đã cập nhật theo nguồn。`,
      },
      provenance: MODEL_A,
    })),
  };
}

function roundFindings(
  claims: readonly Claim[],
  verdict: Verdict,
): readonly VerificationFinding[] {
  return claims.map((claim) => ({
    claimId: claim.id,
    verdict,
    evidenceRefs: [BACKED_REFERENCE],
    ...(verdict === "Pass"
      ? {}
      : { description: "Nguồn research nói khác với phát biểu này." }),
  }));
}

describe("Verification_Engine transition eligibility (Requirement 5.5, 5.6)", () => {
  // Feature: fb-ai, Property 20: The verification outcome drives the correct transition eligibility — all Pass => eligible `Verified`; contradictions remaining after `maxRounds` (1..5, default 2) => `Generated` / `VerificationBlocked`, never auto-approved
  // **Validates: Requirements 5.5, 5.6**
  it("Property 20: the verification outcome drives the correct transition eligibility", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(sentenceSpec, { minLength: 1, maxLength: 3 }),
        fc.constantFrom<number | undefined>(1, 2, 5, undefined),
        fc.constantFrom<number | null>(1, 2, 3, 4, 5, null),
        fc.constantFrom<Verdict>("Contradiction", "Unsupported"),
        fc.constantFrom(1, 3),
        async (specs, maxRounds, passAtRound, failVerdict, maxAttempts) => {
          const content = fullContent(specs);
          const revision = makeRevision(content);
          const snapshot = structuredClone(revision);
          const research = BACKED_RESEARCH;

          const critic = modelB((request) => ({
            provenance: MODEL_B,
            findings: roundFindings(
              request.claims,
              passAtRound !== null && request.round >= passAtRound ? "Pass" : failVerdict,
            ),
          }));
          const modelA = corrector();
          const command: VerifyDraftCommand = {
            revision,
            research,
            requestedModel: MODEL_B,
            requestedCorrectionModel: MODEL_A,
            maxAttempts,
            ...(maxRounds === undefined ? {} : { maxRounds }),
          };
          const result = await engine(critic, { modelA }).verify(command);
          expectNoWorkflowMutation(result);

          const effectiveRounds = maxRounds ?? DEFAULT_VERIFICATION_MAX_ROUNDS;
          if (maxRounds === undefined) expect(effectiveRounds).toBe(2);
          const passRound =
            passAtRound !== null && passAtRound <= effectiveRounds ? passAtRound : null;
          const finalRound = passRound ?? effectiveRounds;

          if (passRound === null) {
            // Contradictions remaining after maxRounds are never auto-approved.
            expect(result.kind).toBe("VerificationBlocked");
            if (result.kind !== "VerificationBlocked") return;
            expect(result.eligibleStage).toBe("Generated");
            expect(result.workStatus).toBe("VerificationBlocked");
            expect(result.eligibleStage).not.toBe("Verified");
            expect(result.report.passed).toBe(false);
            expect(
              result.report.findings.every((finding) => finding.verdict === failVerdict),
            ).toBe(true);
          } else {
            expect(result.kind).toBe("Passed");
            if (result.kind !== "Passed") return;
            expect(result.eligibleStage).toBe("Verified");
            expect(result.report.passed).toBe(true);
            expect(
              result.report.findings.every((finding) => finding.verdict === "Pass"),
            ).toBe(true);
            expect("workStatus" in result).toBe(false);
          }

          // The loop is bounded exactly by the effective round budget.
          expect(result.report.round).toBe(finalRound);
          expect(result.artifacts.reports).toHaveLength(finalRound);
          expect(result.artifacts.revisions).toHaveLength(finalRound - 1);
          expect(result.artifacts.corrections).toHaveLength(finalRound - 1);
          expect(result.attempts).toBe(finalRound * 2 - 1);
          expect(result.artifacts.reports.at(-1)).toBe(result.report);

          // Correction revisions form a monotonic, immutable chain.
          let parent = revision;
          result.artifacts.revisions.forEach((corrected, index) => {
            expect(corrected.draftId).toBe(revision.draftId);
            expect(corrected.revision).toBe(index + 2);
            expect(corrected.parentRevisionId).toBe(parent.id);
            expect(corrected.createdBy).toBe("System");
            expect(corrected.contentHash).toBe(hashGenerationValue(corrected.content));
            expect(corrected.contentHash).not.toBe(parent.contentHash);
            expect(Object.isFrozen(corrected)).toBe(true);
            parent = corrected;
          });
          expect(result.activeRevision).toEqual(parent);

          // Every report is bound to the exact revision it evaluated.
          const chain = [revision, ...result.artifacts.revisions];
          result.artifacts.reports.forEach((report, index) => {
            expectBoundToRevision(report, chain[index], research);
            expect(report.round).toBe(index + 1);
          });

          // The verified input revision is never rewritten in place.
          expect(revision).toEqual(snapshot);
        },
      ),
      {
        numRuns: RUNS,
        examples: [
          // maxRounds at its lower bound with an immediate pass.
          [[{ word: 0, terminator: 0, separator: 0 }], 1, 1, "Contradiction", 1],
          // maxRounds at its lower bound with contradictions remaining.
          [[{ word: 2, terminator: 3, separator: 1 }], 1, null, "Contradiction", 3],
          // maxRounds at its upper bound, pass on the final round.
          [[{ word: 3, terminator: 4, separator: 1 }], 5, 5, "Unsupported", 3],
          // maxRounds at its upper bound with contradictions remaining.
          [[{ word: 4, terminator: 5, separator: 3 }], 5, null, "Contradiction", 1],
          // Default maxRounds of 2 with contradictions remaining.
          [[{ word: 1, terminator: 3, separator: 1 }], undefined, null, "Contradiction", 3],
          // Default maxRounds of 2 with a pass in the correction round.
          [[{ word: 0, terminator: 4, separator: 1 }], undefined, 2, "Contradiction", 1],
          // A pass promised beyond the round budget still blocks.
          [[{ word: 2, terminator: 5, separator: 1 }], 1, 5, "Unsupported", 3],
        ] as never,
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Requirement 5.7 and the authoritative design rules.
// ---------------------------------------------------------------------------

const UNIT_CONTENT = fullContent([{ word: 0, terminator: 3, separator: 1 }]);
const UNIT_REVISION = makeRevision(UNIT_CONTENT);

function unitCommand(overrides: Partial<VerifyDraftCommand> = {}): VerifyDraftCommand {
  return {
    revision: UNIT_REVISION,
    research: BACKED_RESEARCH,
    requestedModel: MODEL_B,
    requestedCorrectionModel: MODEL_A,
    ...overrides,
  };
}

describe("Verification_Engine model unresponsiveness (Requirement 5.7)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([1, 3])(
    "holds the draft at Generated/RetryableBlocked after %i unanswered Model B attempts",
    async (maxAttempts) => {
      const ops = operations();
      const critic = modelB(() => {
        throw new Error("provider unavailable");
      });
      const result = await engine(critic, { operations: ops }).verify(
        unitCommand({ maxAttempts, maxRounds: 2 }),
      );

      expect(maxAttempts).toBeLessThanOrEqual(3);
      expect(result).toMatchObject({
        kind: "RetryableBlocked",
        eligibleStage: "Generated",
        workStatus: "RetryableBlocked",
        failure: "ModelUnresponsive",
        attempts: maxAttempts,
        error: {
          draftRevisionId: UNIT_REVISION.id,
          researchResultId: BACKED_RESEARCH.id,
          dependency: "ModelB",
          code: "ModelUnresponsive",
          attempts: maxAttempts,
          reason: "provider unavailable",
          round: 1,
        },
        notification: {
          eventKey: `verification:${UNIT_REVISION.id}:1:ModelB:retryable-blocked`,
          draftRevisionId: UNIT_REVISION.id,
          action: "RetryVerification",
        },
      });
      if (result.kind !== "RetryableBlocked") return;

      // The draft is held, not advanced, and no report is produced.
      expect(result.activeRevision).toBe(UNIT_REVISION);
      expect("report" in result).toBe(false);
      expect(result.artifacts.reports).toHaveLength(0);
      expect(result.artifacts.revisions).toHaveLength(0);
      expect(result.eligibleStage).not.toBe("Verified");
      expect(critic.critique).toHaveBeenCalledTimes(maxAttempts);

      // The error is recorded and the Operator is notified exactly once.
      expect(ops.recordError).toHaveBeenCalledTimes(1);
      expect(ops.recordError).toHaveBeenCalledWith(result.error);
      expect(ops.notifyOperator).toHaveBeenCalledTimes(1);
      expect(ops.notifyOperator).toHaveBeenCalledWith(result.notification);
      expect(result.notification.message).toContain("provider unavailable");
      expectNoWorkflowMutation(result);
    },
  );

  it("treats an injected deadline with a silent model as unresponsive without waiting", async () => {
    vi.useFakeTimers();
    const ops = operations();
    const critic = modelB(() => new Promise<ModelBCritiqueResponse>(() => undefined));
    const pending = engine(critic, { operations: ops }).verify(
      unitCommand({ maxAttempts: 3, maxRounds: 1, deadlineMs: 300_000 }),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.advanceTimersByTimeAsync(300_000);
    }
    const result = await pending;

    expect(result).toMatchObject({
      kind: "RetryableBlocked",
      eligibleStage: "Generated",
      workStatus: "RetryableBlocked",
      failure: "DeadlineExceeded",
      attempts: 3,
      error: { dependency: "ModelB", attempts: 3, code: "DeadlineExceeded" },
    });
    expect(critic.critique).toHaveBeenCalledTimes(3);
    expect(ops.recordError).toHaveBeenCalledTimes(1);
    expect(ops.notifyOperator).toHaveBeenCalledTimes(1);
  });

  it("holds the draft when Model A cannot answer a correction round", async () => {
    const ops = operations();
    const critic = modelB((request) => ({
      provenance: MODEL_B,
      findings: roundFindings(request.claims, "Contradiction"),
    }));
    const modelA: ModelACorrectionPort = {
      correct: vi.fn(async () => {
        throw new Error("corrector unavailable");
      }),
    };
    const result = await engine(critic, { modelA, operations: ops }).verify(
      unitCommand({ maxAttempts: 3, maxRounds: 3 }),
    );

    expect(result).toMatchObject({
      kind: "RetryableBlocked",
      eligibleStage: "Generated",
      workStatus: "RetryableBlocked",
      failure: "ModelUnresponsive",
      error: { dependency: "ModelA", attempts: 3, round: 1 },
    });
    if (result.kind !== "RetryableBlocked") return;
    expect(modelA.correct).toHaveBeenCalledTimes(3);
    // The round-1 report is retained as evidence while the draft is held.
    expect(result.artifacts.reports).toHaveLength(1);
    expect(result.artifacts.revisions).toHaveLength(0);
    expect(result.activeRevision).toBe(UNIT_REVISION);
    expect(ops.recordError).toHaveBeenCalledTimes(1);
    expect(ops.notifyOperator).toHaveBeenCalledTimes(1);
  });
});

describe("Verification_Engine authoritative design rules", () => {
  it("never receives a Repository or PipelineRun and cannot mutate workflow state", async () => {
    const critic = modelB((request) => ({
      provenance: MODEL_B,
      findings: roundFindings(request.claims, "Pass"),
    }));
    const instance = engine(critic);
    // No repository/pipeline handle is reachable from the engine instance.
    expect(Object.keys(instance)).toEqual([]);

    const command: Record<string, unknown> = {
      ...unitCommand({ maxRounds: 1 }),
      repository: forbidden("Repository"),
      pipelineRun: forbidden("PipelineRun"),
    };
    const result = await instance.verify(command as unknown as VerifyDraftCommand);

    expect(result.kind).toBe("Passed");
    // Only immutable evidence plus a stage recommendation is returned.
    expectNoWorkflowMutation(result);
    expect(result.eligibleStage).toBe("Verified");
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      (result as { kind: string }).kind = "VerificationBlocked";
    }).toThrow(TypeError);
  });

  it("binds every report to the exact draftRevisionId and contentHash it evaluated", async () => {
    const critic = modelB((request) => ({
      provenance: MODEL_B,
      findings: roundFindings(request.claims, request.round === 1 ? "Contradiction" : "Pass"),
    }));
    const result = await engine(critic, { modelA: corrector() }).verify(
      unitCommand({ maxRounds: 2 }),
    );
    expect(result.kind).toBe("Passed");
    if (result.kind !== "Passed") return;

    const chain = [UNIT_REVISION, ...result.artifacts.revisions];
    expect(result.artifacts.reports).toHaveLength(2);
    result.artifacts.reports.forEach((report, index) => {
      expectBoundToRevision(report, chain[index], BACKED_RESEARCH);
    });
    // A report for revision N never claims the hash of revision N+1.
    expect(result.artifacts.reports[0].contentHash).not.toBe(
      result.artifacts.reports[1].contentHash,
    );
    expect(result.report.draftRevisionId).toBe(result.activeRevision.id);

    // A revision whose hash does not match its content is refused before any model call.
    const stale = modelB((request) => ({
      provenance: MODEL_B,
      findings: roundFindings(request.claims, "Pass"),
    }));
    await expect(
      engine(stale).verify(
        unitCommand({ revision: { ...UNIT_REVISION, contentHash: "hash-khong-khop" } }),
      ),
    ).rejects.toThrow(VerificationInputError);
    expect(stale.critique).not.toHaveBeenCalled();
  });

  it("produces correction revisions as a monotonic immutable chain", async () => {
    const critic = modelB((request) => ({
      provenance: MODEL_B,
      findings: roundFindings(request.claims, "Contradiction"),
    }));
    const result = await engine(critic, { modelA: corrector() }).verify(
      unitCommand({ maxRounds: 4 }),
    );
    expect(result.kind).toBe("VerificationBlocked");
    if (result.kind !== "VerificationBlocked") return;

    expect(result.artifacts.revisions.map((entry) => entry.revision)).toEqual([2, 3, 4]);
    expect(result.artifacts.corrections.map((entry) => entry.round)).toEqual([1, 2, 3]);
    let parent = UNIT_REVISION;
    result.artifacts.revisions.forEach((corrected, index) => {
      expect(corrected.parentRevisionId).toBe(parent.id);
      expect(corrected.revision).toBe(parent.revision + 1);
      expect(result.artifacts.corrections[index]).toMatchObject({
        sourceRevisionId: parent.id,
        correctedRevisionId: corrected.id,
        modelA: MODEL_A,
      });
      expect(() => {
        (corrected as { revision: number }).revision = 99;
      }).toThrow(TypeError);
      parent = corrected;
    });
    expect(UNIT_REVISION.contentHash).toBe(hashGenerationValue(UNIT_CONTENT));
  });
});
