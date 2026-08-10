import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ComplianceChecker,
  type ArtifactComplianceResult,
  type ComplianceResultPersistence,
  type ComplianceRuleDefinition,
  type PlatformRuleSet,
  type SourceCapture,
  type SourceTermsDefinition,
} from "../src/compliance/compliance-checker.js";
import type {
  DraftRevision,
  PlatformArtifact,
  TargetPlatform,
} from "../src/domain/content.js";

/**
 * Property tests for Compliance_Checker (Requirement 6).
 *
 * Interpretation notes used by these tests:
 * - Boundary semantics are inclusive, exactly as tasks.md task 9.1 states:
 *   "≥50 consecutive words OR ≥20% of total words, whichever first".
 * - Requirement 6.5 offers the 20% figure as an alternative measure of verbatim
 *   copying. design.md ("Compliance Checker") resolves the ambiguity explicitly:
 *   the evaluator "compares contiguous normalized token runs and total matched
 *   draft tokens". The ratio measure therefore counts distinct matched draft
 *   token positions, not contiguous matched runs. The generators below cover
 *   both shapes (one contiguous verbatim block, and scattered matched words with
 *   a maximum run of one word) so the two measures are exercised separately.
 */

const CHECKED_AT = new Date("2025-06-01T02:00:00.000Z");
const ACTIVE_FROM = "2025-01-01T00:00:00.000Z";
const FUTURE_FROM = "2026-01-01T00:00:00.000Z";
const EXPIRED_FROM = "2024-01-01T00:00:00.000Z";
const EXPIRED_TO = "2025-01-01T00:00:00.000Z";

const PLATFORMS = ["Facebook_Page", "Facebook_Group", "YouTube"] as const;

const REQUIRED_ATTRIBUTION_TEXT = "Nguồn Chính";
const REQUIRED_ATTRIBUTION_URL = "https://source.example/article";
const ATTRIBUTION_OK = `Theo ${REQUIRED_ATTRIBUTION_TEXT}: ${REQUIRED_ATTRIBUTION_URL}`;

const REVISION: DraftRevision = {
  id: "revision-7",
  draftId: "draft-1",
  revision: 7,
  content: {
    topicId: "topic-1",
    facebookPost: "Nội dung kiểm tra tuân thủ an toàn cho kênh AI.",
    guide: [],
    videoScript: { intro: "Mở đầu", body: "Nội dung", conclusion: "Kết" },
    originLinks: [REQUIRED_ATTRIBUTION_URL],
    language: "vi",
  },
  contentHash: "revision-hash-7",
  createdBy: "System",
  createdAt: "2025-06-01T00:00:00.000Z",
};

/** Tokens that never occur in any generated artifact text. */
const DISJOINT_CAPTURE_CONTENT = "zq0001 zq0002 zq0003 zq0004 zq0005";

const PRIMARY_CAPTURE: SourceCapture = {
  sourceId: "source-1",
  captureId: "capture-1",
  termsVersion: "terms-v5",
  url: REQUIRED_ATTRIBUTION_URL,
  content: DISJOINT_CAPTURE_CONTENT,
};

const SECONDARY_CAPTURE: SourceCapture = {
  sourceId: "source-2",
  captureId: "capture-2",
  termsVersion: "terms-v2",
  url: "https://second.example/post",
  content: "zq1001 zq1002 zq1003",
};

const SECONDARY_TERMS: SourceTermsDefinition = {
  sourceId: "source-2",
  version: "terms-v2",
  attributionRequired: false,
  requiredAttributionText: "Ghi Công Không Bắt Buộc",
};

class RecordingPersistence implements ComplianceResultPersistence {
  readonly results: ArtifactComplianceResult[] = [];

  async persistComplianceResult(result: ArtifactComplianceResult): Promise<void> {
    this.results.push(result);
  }
}

function newChecker(persistence: ComplianceResultPersistence): ComplianceChecker {
  let sequence = 0;
  return new ComplianceChecker({
    persistence,
    evaluatorVersion: "compliance-evaluator-v2",
    now: () => CHECKED_AT,
    idFactory: () => `compliance-${(sequence += 1)}`,
  });
}

function buildArtifact(overrides: Partial<PlatformArtifact> = {}): PlatformArtifact {
  return {
    id: "artifact-1",
    draftRevisionId: REVISION.id,
    platform: "Facebook_Page",
    rendererVersion: "renderer-v4",
    body: "Nội dung bài đăng hợp lệ về công cụ AI.",
    metadata: {},
    attribution: ATTRIBUTION_OK,
    imageSuggestions: [],
    artifactHash: "artifact-hash-1",
    createdAt: "2025-06-01T01:00:00.000Z",
    ...overrides,
  };
}

function primaryTerms(
  overrides: Partial<SourceTermsDefinition> = {},
): SourceTermsDefinition {
  return {
    sourceId: "source-1",
    version: "terms-v5",
    attributionRequired: true,
    requiredAttributionText: REQUIRED_ATTRIBUTION_TEXT,
    requiredAttributionUrl: REQUIRED_ATTRIBUTION_URL,
    ...overrides,
  };
}

type Lifecycle = "active" | "future" | "expired";

function lifecycleWindow(lifecycle: Lifecycle): Pick<
  ComplianceRuleDefinition,
  "effectiveFrom" | "effectiveTo"
> {
  if (lifecycle === "active") return { effectiveFrom: ACTIVE_FROM };
  if (lifecycle === "future") return { effectiveFrom: FUTURE_FROM };
  return { effectiveFrom: EXPIRED_FROM, effectiveTo: EXPIRED_TO };
}

/** Unique fixed-width marker token; no marker is a substring of another. */
function marker(index: number): string {
  return `mk${String(index).padStart(2, "0")}x`;
}

interface RuleSpec {
  readonly platform: TargetPlatform;
  readonly lifecycle: Lifecycle;
  readonly violates: boolean;
}

const ruleSpecArbitrary = fc.record<RuleSpec>({
  platform: fc.constantFrom(...PLATFORMS),
  lifecycle: fc.constantFrom<Lifecycle>("active", "future", "expired"),
  violates: fc.boolean(),
});

describe("Compliance_Checker rule evaluation", () => {
  // Feature: fb-ai, Property 21: Compliance pass reflects rule violations exactly
  // **Validates: Requirements 6.1, 6.2**
  it("marks an artifact not passing exactly when an active platform rule is violated or configuration is unavailable", async () => {
    let generatedCases = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PLATFORMS),
        fc.array(ruleSpecArbitrary, { minLength: 0, maxLength: 6 }),
        fc.integer({ min: 0, max: 4 }).map((value) => value === 0),
        async (platform, specs, omitRuleSet) => {
          generatedCases += 1;
          const rules: ComplianceRuleDefinition[] = specs.map((spec, index) => ({
            id: `rule.${String(index).padStart(2, "0")}`,
            platform: spec.platform,
            version: "1",
            kind: "Keyword",
            parameters: { keywords: [marker(index)] },
            ...lifecycleWindow(spec.lifecycle),
          }));
          const presentMarkers = specs
            .map((spec, index) => (spec.violates ? marker(index) : undefined))
            .filter((value): value is string => value !== undefined);
          const body = [
            "Nội dung kiểm tra tuân thủ cho nền tảng đích.",
            ...presentMarkers,
          ].join(" ");

          const ruleSet: PlatformRuleSet = {
            version: "rules-2025.06",
            rules,
          };
          const persistence = new RecordingPersistence();
          const result = await newChecker(persistence).check({
            artifact: buildArtifact({ platform, body }),
            draftRevision: REVISION,
            ruleSet: omitRuleSet ? undefined : ruleSet,
            sourceTerms: [primaryTerms()],
            sourceCaptures: [PRIMARY_CAPTURE],
          });

          const activeIndexes = specs
            .map((spec, index) => ({ spec, index }))
            .filter(({ spec }) => spec.platform === platform && spec.lifecycle === "active");
          const expectedEvaluated = omitRuleSet
            ? []
            : activeIndexes.map(({ index }) => rules[index]!.id);
          const expectedViolated = omitRuleSet
            ? []
            : activeIndexes
              .filter(({ spec }) => spec.violates)
              .map(({ index }) => rules[index]!.id);
          const configurationUnavailable = omitRuleSet || expectedEvaluated.length === 0;

          // The complete violated-rule-id list, and only active platform rules.
          expect([...result.evaluatedRuleIds]).toEqual(expectedEvaluated);
          expect([...result.violatedRuleIds]).toEqual(expectedViolated);
          expect(
            result.reasons.filter((reason) => reason.startsWith("RULE_VIOLATION:")),
          ).toEqual(expectedViolated.map((id) => `RULE_VIOLATION:${id}`));

          // Attribution and copyright are satisfied by construction, so `passed`
          // is decided by rule violations and configuration availability alone.
          expect(result.attributionOk).toBe(true);
          expect(result.copyrightOk).toBe(true);
          expect(result.passed).toBe(
            !configurationUnavailable && expectedViolated.length === 0,
          );
          expect(result.configurationAvailable).toBe(!configurationUnavailable);
          if (configurationUnavailable) {
            expect(
              result.errors.some((error) => error.code === "CONFIG_UNAVAILABLE"),
            ).toBe(true);
          }

          // The result is bound to the exact artifact and persisted once.
          expect(result.artifactId).toBe("artifact-1");
          expect(result.artifactHash).toBe("artifact-hash-1");
          expect(result.draftRevisionId).toBe(REVISION.id);
          expect(persistence.results).toEqual([result]);
        },
      ),
      { numRuns: 150 },
    );
    expect(generatedCases).toBeGreaterThanOrEqual(150);
  });
});

type AttributionForm = "plain" | "nfd" | "html" | "nbsp";
type AttributionBlank = "none" | "empty" | "whitespace";

function renderAttributionValue(value: string, form: AttributionForm): string {
  if (form === "nfd") return value.normalize("NFD");
  if (form === "html") return `<b>${value}</b>`;
  if (form === "nbsp") return value.replaceAll(" ", "\u00A0");
  return value;
}

describe("Compliance_Checker attribution", () => {
  // Feature: fb-ai, Property 22: Attribution is required and checked
  // **Validates: Requirements 6.3, 6.4**
  it("fails an artifact whose required Source_Terms attribution text or URL is missing, with a specific reason", async () => {
    const ruleId = "rule.attribution.v1";
    let generatedCases = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          platform: fc.constantFrom(...PLATFORMS),
          attributionRequired: fc.boolean(),
          requireText: fc.boolean(),
          requireUrl: fc.boolean(),
          includeText: fc.boolean(),
          includeUrl: fc.boolean(),
          form: fc.constantFrom<AttributionForm>("plain", "nfd", "html", "nbsp"),
          blank: fc.constantFrom<AttributionBlank>("none", "none", "empty", "whitespace"),
        }),
        async (scenario) => {
          generatedCases += 1;
          const attribution = scenario.blank === "empty"
            ? ""
            : scenario.blank === "whitespace"
              ? "   \n\t "
              : [
                "Theo",
                scenario.includeText
                  ? renderAttributionValue(REQUIRED_ATTRIBUTION_TEXT, scenario.form)
                  : "Kênh Khác",
                scenario.includeUrl
                  ? renderAttributionValue(REQUIRED_ATTRIBUTION_URL, scenario.form)
                  : "https://other.example/x",
              ].join(" ");

          const terms = primaryTerms({
            attributionRequired: scenario.attributionRequired,
            requiredAttributionText: scenario.requireText
              ? REQUIRED_ATTRIBUTION_TEXT
              : undefined,
            requiredAttributionUrl: scenario.requireUrl
              ? REQUIRED_ATTRIBUTION_URL
              : undefined,
          });
          const ruleSet: PlatformRuleSet = {
            version: "rules-attribution-2025.06",
            rules: [{
              id: ruleId,
              platform: scenario.platform,
              version: "1",
              kind: "Attribution",
              parameters: {},
              effectiveFrom: ACTIVE_FROM,
            }],
          };

          const persistence = new RecordingPersistence();
          const result = await newChecker(persistence).check({
            artifact: buildArtifact({ platform: scenario.platform, attribution }),
            draftRevision: REVISION,
            ruleSet,
            sourceTerms: [terms, SECONDARY_TERMS],
            sourceCaptures: [PRIMARY_CAPTURE, SECONDARY_CAPTURE],
          });

          const expectedFailures: string[] = [];
          if (scenario.attributionRequired) {
            if (scenario.blank !== "none") {
              expectedFailures.push("attribution is required");
            } else {
              if (scenario.requireText && !scenario.includeText) {
                expectedFailures.push("required attribution text is missing");
              }
              if (scenario.requireUrl && !scenario.includeUrl) {
                expectedFailures.push("required attribution URL is missing");
              }
            }
          }

          expect(result.attributionFailures).toHaveLength(expectedFailures.length);
          for (const expectedFailure of expectedFailures) {
            expect(
              result.attributionFailures.some((failure) =>
                failure.includes("source-1") && failure.includes(expectedFailure)
              ),
            ).toBe(true);
          }
          // A Source_Terms record that does not require attribution never fails.
          expect(
            result.attributionFailures.some((failure) => failure.includes("source-2")),
          ).toBe(false);

          expect(result.attributionOk).toBe(expectedFailures.length === 0);
          expect(result.sourceTermsVersions).toEqual(["terms-v2", "terms-v5"]);
          if (expectedFailures.length === 0) {
            expect([...result.violatedRuleIds]).toEqual([]);
            expect(result.passed).toBe(true);
          } else {
            expect([...result.violatedRuleIds]).toEqual([ruleId]);
            expect(result.passed).toBe(false);
            expect(
              result.reasons.filter((reason) => reason.startsWith("ATTRIBUTION_REQUIRED:")),
            ).toHaveLength(expectedFailures.length);
          }
          expect(persistence.results).toEqual([result]);
        },
      ),
      { numRuns: 200 },
    );
    expect(generatedCases).toBeGreaterThanOrEqual(200);
  });
});

type WordStyle = "ascii" | "vietnamese";
type SourceForm = "plain" | "nfd" | "html" | "nfd-html";

const COPYRIGHT_RULE_ID = "rule.copyright.v1";

/** Distinct tokens; Vietnamese variants carry diacritics and combining marks. */
function makeWord(style: WordStyle, prefix: string, index: number): string {
  const id = String(index).padStart(4, "0");
  return style === "ascii" ? `${prefix}w${id}` : `${prefix}từ${id}điện`;
}

function renderCaptureContent(words: readonly string[], form: SourceForm): string {
  const base = form === "html" || form === "nfd-html"
    ? `<p>${words.map((word) => `<span>${word}</span>`).join("&nbsp;")}</p>`
    : words.join(" ");
  return form === "nfd" || form === "nfd-html" ? base.normalize("NFD") : base;
}

async function checkCopyright(
  draftWords: readonly string[],
  sourceWords: readonly string[],
  form: SourceForm,
  parameters: Readonly<Record<string, unknown>> = {},
): Promise<ArtifactComplianceResult> {
  const ruleSet: PlatformRuleSet = {
    version: "rules-copyright-2025.06",
    rules: [{
      id: COPYRIGHT_RULE_ID,
      platform: "Facebook_Page",
      version: "1",
      kind: "Copyright",
      parameters,
      effectiveFrom: ACTIVE_FROM,
    }],
  };
  return await newChecker(new RecordingPersistence()).check({
    artifact: buildArtifact({ platform: "Facebook_Page", body: draftWords.join(" ") }),
    draftRevision: REVISION,
    ruleSet,
    sourceTerms: [primaryTerms()],
    sourceCaptures: [{
      ...PRIMARY_CAPTURE,
      content: renderCaptureContent(sourceWords, form),
    }],
  });
}

interface CopyrightPlan {
  readonly draftWords: readonly string[];
  readonly sourceWords: readonly string[];
  readonly matched: number;
  readonly longest: number;
}

/** One contiguous verbatim block copied from the source; all filler is disjoint. */
function planContiguousRun(
  style: WordStyle,
  total: number,
  runLength: number,
): CopyrightPlan {
  const shared = Array.from({ length: runLength }, (_, index) => makeWord(style, "s", index));
  const draftWords: string[] = [];
  let filler = 0;
  for (let index = 0; index < 5; index += 1) {
    draftWords.push(makeWord(style, "d", filler));
    filler += 1;
  }
  draftWords.push(...shared);
  while (draftWords.length < total) {
    draftWords.push(makeWord(style, "d", filler));
    filler += 1;
  }
  const sourceWords = [
    makeWord(style, "o", 1),
    makeWord(style, "o", 2),
    ...shared,
    makeWord(style, "o", 3),
  ];
  return { draftWords, sourceWords, matched: runLength, longest: runLength };
}

/** Scattered matched words: maximum contiguous matched run is one word. */
function planScatteredRatio(
  style: WordStyle,
  total: number,
  matched: number,
): CopyrightPlan {
  const shared = Array.from({ length: matched }, (_, index) => makeWord(style, "s", index));
  const draftWords: string[] = [];
  let taken = 0;
  let filler = 0;
  for (let index = 0; index < total; index += 1) {
    if (index % 2 === 0 && taken < matched) {
      draftWords.push(shared[taken]!);
      taken += 1;
    } else {
      draftWords.push(makeWord(style, "d", filler));
      filler += 1;
    }
  }
  const sourceWords: string[] = [];
  [...shared].reverse().forEach((word, index) => {
    sourceWords.push(makeWord(style, "o", index + 1));
    sourceWords.push(word);
  });
  sourceWords.push(makeWord(style, "o", 9999));
  return { draftWords, sourceWords, matched, longest: matched > 0 ? 1 : 0 };
}

describe("Compliance_Checker copyright limits", () => {
  // Feature: fb-ai, Property 23: Verbatim copying beyond the limit is flagged
  // **Validates: Requirements 6.5**
  it("flags an artifact exactly when copying reaches 50 consecutive words or 20% of draft words", async () => {
    let generatedCases = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<WordStyle>("ascii", "vietnamese"),
        fc.constantFrom<SourceForm>("plain", "nfd", "html", "nfd-html"),
        fc.oneof(
          fc.record({
            kind: fc.constant<"run">("run"),
            total: fc.constant(400),
            amount: fc.constantFrom(0, 1, 12, 48, 49, 50, 51, 120),
          }),
          fc.record({
            kind: fc.constant<"ratio">("ratio"),
            total: fc.constantFrom(100, 200),
            amount: fc.constantFrom(0, 10, 19, 20, 21, 50),
          }),
        ),
        async (style, form, scenario) => {
          generatedCases += 1;
          const matched = scenario.kind === "run"
            ? scenario.amount
            : (scenario.total * scenario.amount) / 100;
          const plan = scenario.kind === "run"
            ? planContiguousRun(style, scenario.total, scenario.amount)
            : planScatteredRatio(style, scenario.total, matched);

          const result = await checkCopyright(plan.draftWords, plan.sourceWords, form);
          const [comparison] = result.copyrightComparisons;
          expect(comparison).toBeDefined();
          if (comparison === undefined) return;

          expect(comparison.limits).toEqual({ consecutiveWords: 50, matchedDraftRatio: 0.2 });
          expect(comparison.totalDraftWords).toBe(scenario.total);
          expect(comparison.matchedDraftWords).toBe(plan.matched);
          expect(comparison.longestConsecutiveWords).toBe(plan.longest);

          const violatedByRun = plan.longest >= 50;
          const violatedByRatio = plan.matched / scenario.total >= 0.2;
          expect(comparison.violatedByConsecutiveWords).toBe(violatedByRun);
          expect(comparison.violatedByMatchedDraftRatio).toBe(violatedByRatio);

          const flagged = violatedByRun || violatedByRatio;
          expect(result.copyrightOk).toBe(!flagged);
          expect(result.attributionOk).toBe(true);
          expect(result.passed).toBe(!flagged);
          expect([...result.violatedRuleIds]).toEqual(flagged ? [COPYRIGHT_RULE_ID] : []);
          expect(
            result.reasons.some((reason) => reason.startsWith("COPYRIGHT_RISK:")),
          ).toBe(flagged);
        },
      ),
      { numRuns: 150 },
    );
    expect(generatedCases).toBeGreaterThanOrEqual(150);
  });

  it("treats the configured limits as inclusive at 50 consecutive words and 20% of draft words", async () => {
    const run49 = planContiguousRun("vietnamese", 400, 49);
    const run50 = planContiguousRun("vietnamese", 400, 50);
    expect((await checkCopyright(run49.draftWords, run49.sourceWords, "plain")).copyrightOk).toBe(true);
    expect((await checkCopyright(run50.draftWords, run50.sourceWords, "plain")).copyrightOk).toBe(false);

    for (const [percent, expectedOk] of [[19, true], [20, false], [21, false]] as const) {
      const plan = planScatteredRatio("vietnamese", 100, percent);
      const result = await checkCopyright(plan.draftWords, plan.sourceWords, "nfd-html");
      expect(result.copyrightComparisons[0]?.matchedDraftRatio).toBe(percent / 100);
      expect(result.copyrightOk).toBe(expectedOk);
    }
  });
});

describe("Compliance_Checker configuration availability (task 9.5)", () => {
  // **Validates: Requirements 6.7**
  const validRuleSet: PlatformRuleSet = {
    version: "rules-2025.06",
    rules: [{
      id: "rule.keyword.v1",
      platform: "Facebook_Page",
      version: "1",
      kind: "Keyword",
      parameters: { keywords: ["từ cấm"] },
      effectiveFrom: ACTIVE_FROM,
    }],
  };

  const cases = [
    {
      name: "missing community-standards configuration",
      ruleSet: undefined,
      sourceTerms: [primaryTerms()],
      expectedDetail: /Community standards configuration is unavailable/,
    },
    {
      name: "missing Source_Terms configuration",
      ruleSet: validRuleSet,
      sourceTerms: undefined,
      expectedDetail: /Source Terms configuration is unavailable/,
    },
    {
      name: "both configurations missing",
      ruleSet: undefined,
      sourceTerms: undefined,
      expectedDetail: /unavailable/,
    },
  ] as const;

  for (const testCase of cases) {
    it(`marks the artifact not passing with a config-unavailable error and preserves draft content: ${testCase.name}`, async () => {
      const contentBefore = structuredClone(REVISION.content);
      const artifact = buildArtifact();
      const bodyBefore = artifact.body;
      const persistence = new RecordingPersistence();

      const result = await newChecker(persistence).check({
        artifact,
        draftRevision: REVISION,
        ruleSet: testCase.ruleSet,
        sourceTerms: testCase.sourceTerms,
        sourceCaptures: [PRIMARY_CAPTURE],
      });

      expect(result.passed).toBe(false);
      expect(result.configurationAvailable).toBe(false);
      const configErrors = result.errors.filter((error) => error.code === "CONFIG_UNAVAILABLE");
      expect(configErrors.length).toBeGreaterThan(0);
      expect(configErrors.map((error) => error.detail).join("\n")).toMatch(testCase.expectedDetail);
      expect(
        result.reasons.some((reason) => reason.startsWith("CONFIG_UNAVAILABLE:")),
      ).toBe(true);
      if (testCase.ruleSet === undefined) expect(result.ruleSetVersion).toBe("unavailable");

      // Draft content and artifact bytes are preserved unchanged.
      expect(REVISION.content).toEqual(contentBefore);
      expect(artifact.body).toBe(bodyBefore);
      expect(result.artifactHash).toBe(artifact.artifactHash);
      expect(persistence.results).toEqual([result]);
    });
  }
});
