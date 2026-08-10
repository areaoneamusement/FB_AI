import type {
  ComplianceResult,
  DraftRevision,
  PlatformArtifact,
  TargetPlatform,
} from "../domain/content.js";

export const DEFAULT_COPYRIGHT_CONSECUTIVE_WORDS = 50;
export const DEFAULT_COPYRIGHT_MATCHED_DRAFT_RATIO = 0.2;
/**
 * Minimum contiguous matched-token run that counts as verbatim copying for the
 * matched-ratio measure (CR-0002, Change 1). Shorter overlap is incidental
 * vocabulary sharing and must not accumulate toward the ratio threshold.
 */
export const DEFAULT_COPYRIGHT_MIN_RUN_TOKENS = 5;
export const DEFAULT_COMPLIANCE_TIMEOUT_MS = 30_000;
export const INTERNAL_VI_TOKENIZER_VERSION = "fb-ai-unicode-vi-word-v1";

export type ComplianceRuleKind =
  | "Keyword"
  | "Pattern"
  | "Classifier"
  | "Attribution"
  | "Copyright";

export interface ComplianceRuleDefinition {
  readonly id: string;
  readonly platform: TargetPlatform;
  readonly version: string;
  readonly kind: ComplianceRuleKind;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
}

export interface PlatformRuleSet {
  readonly version: string;
  readonly rules: readonly ComplianceRuleDefinition[];
}

export interface SourceTermsDefinition {
  readonly sourceId: string;
  readonly version: string;
  readonly attributionRequired: boolean;
  readonly requiredAttributionText?: string;
  readonly requiredAttributionUrl?: string;
}

export interface SourceCapture {
  readonly sourceId: string;
  readonly captureId: string;
  readonly termsVersion: string;
  readonly url: string;
  readonly content: string;
}

export interface CopyrightLimits {
  readonly consecutiveWords: number;
  readonly matchedDraftRatio: number;
  /** Shortest contiguous matched run that counts toward `matchedDraftRatio`. */
  readonly minRunTokens: number;
}

export interface CopyrightComparison {
  readonly sourceCaptureId?: string;
  readonly longestConsecutiveWords: number;
  readonly matchedDraftWords: number;
  readonly totalDraftWords: number;
  readonly matchedDraftRatio: number;
  readonly limits: CopyrightLimits;
  /** Effective `minRunTokens` used for this comparison. */
  readonly minRunTokens: number;
  /**
   * Lengths of the contiguous draft spans that qualified as copied passages, in
   * draft order. Every entry is at least `minRunTokens`, and the entries sum to
   * `matchedDraftWords`, so the ratio decision is reproducible and explainable.
   */
  readonly qualifyingRunLengths: readonly number[];
  readonly violatedByConsecutiveWords: boolean;
  readonly violatedByMatchedDraftRatio: boolean;
}

export interface RuleEvaluation {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly status: "Passed" | "Violated" | "ConfigUnavailable";
  readonly reason?: string;
}

export interface ComplianceConfigurationError {
  readonly code: "CONFIG_UNAVAILABLE" | "ARTIFACT_BINDING_INVALID" | "EVALUATION_TIMEOUT";
  readonly detail: string;
  readonly ruleId?: string;
}

export interface ArtifactComplianceResult extends ComplianceResult {
  readonly rendererVersion: string;
  readonly tokenizerVersion: string;
  readonly evaluatedRuleIds: readonly string[];
  readonly ruleEvaluations: readonly RuleEvaluation[];
  readonly configurationAvailable: boolean;
  readonly errors: readonly ComplianceConfigurationError[];
  readonly attributionFailures: readonly string[];
  readonly copyrightComparisons: readonly CopyrightComparison[];
}

export interface ComplianceResultPersistence {
  persistComplianceResult(result: ArtifactComplianceResult): Promise<void>;
}

export interface ClassifierRuleEvaluator {
  evaluate(
    rule: ComplianceRuleDefinition,
    artifact: PlatformArtifact,
    signal: AbortSignal,
  ): Promise<boolean>;
}

export interface ComplianceCheckInput {
  readonly artifact: PlatformArtifact;
  readonly draftRevision: DraftRevision;
  readonly ruleSet?: PlatformRuleSet;
  readonly sourceTerms?: readonly SourceTermsDefinition[];
  readonly sourceCaptures: readonly SourceCapture[];
}

export interface ComplianceCheckerOptions {
  readonly persistence: ComplianceResultPersistence;
  readonly evaluatorVersion: string;
  readonly classifier?: ClassifierRuleEvaluator;
  readonly tokenizerVersion?: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function htmlToText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, code: string) => {
      if (code.startsWith("#x") || code.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      }
      if (code.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      }
      return HTML_ENTITIES[code.toLocaleLowerCase("en-US")] ?? " ";
    });
}

/** Versioned, dependency-free Unicode word tokenizer with Vietnamese locale folding. */
export function tokenizeForCopyright(value: string): readonly string[] {
  const normalized = htmlToText(value)
    .normalize("NFKC")
    .toLocaleLowerCase("vi");
  return normalized.match(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu) ?? [];
}

function policyText(artifact: PlatformArtifact): string {
  return [artifact.body, ...Object.keys(artifact.metadata).sort().map((key) => artifact.metadata[key]), artifact.attribution]
    .join("\n");
}

function copyrightText(artifact: PlatformArtifact): string {
  return [artifact.body, ...Object.keys(artifact.metadata).sort().map((key) => artifact.metadata[key])]
    .join("\n");
}

function validLimits(parameters: Readonly<Record<string, unknown>>): CopyrightLimits | undefined {
  const consecutiveWords = parameters.consecutiveWords ?? DEFAULT_COPYRIGHT_CONSECUTIVE_WORDS;
  const matchedDraftRatio = parameters.matchedDraftRatio ?? DEFAULT_COPYRIGHT_MATCHED_DRAFT_RATIO;
  const minRunTokens = parameters.minRunTokens ?? DEFAULT_COPYRIGHT_MIN_RUN_TOKENS;
  if (
    typeof consecutiveWords !== "number" ||
    !Number.isInteger(consecutiveWords) ||
    consecutiveWords < 1 ||
    typeof matchedDraftRatio !== "number" ||
    !Number.isFinite(matchedDraftRatio) ||
    matchedDraftRatio <= 0 ||
    matchedDraftRatio > 1 ||
    typeof minRunTokens !== "number" ||
    !Number.isInteger(minRunTokens) ||
    minRunTokens < 1
  ) {
    return undefined;
  }
  return { consecutiveWords, matchedDraftRatio, minRunTokens };
}

/**
 * Compares a draft against captured origin sources for verbatim copying.
 *
 * Two independent measures (Requirement 6.5, both inclusive):
 * - `longestConsecutiveWords`: the longest contiguous matched token run.
 * - `matchedDraftRatio`: the share of draft tokens that belong to a contiguous
 *   matched run of at least `limits.minRunTokens` tokens. Isolated overlap of
 *   common words never contributes (CR-0002, Change 1).
 */
export function compareCopyright(
  draftText: string,
  captures: readonly SourceCapture[],
  limits: CopyrightLimits = {
    consecutiveWords: DEFAULT_COPYRIGHT_CONSECUTIVE_WORDS,
    matchedDraftRatio: DEFAULT_COPYRIGHT_MATCHED_DRAFT_RATIO,
    minRunTokens: DEFAULT_COPYRIGHT_MIN_RUN_TOKENS,
  },
): CopyrightComparison {
  const draftTokens = tokenizeForCopyright(draftText);
  const minRunTokens = limits.minRunTokens;
  /** 1 when the draft token belongs to a qualifying copied run of some capture. */
  const inQualifyingRun = new Uint8Array(draftTokens.length);
  let longestConsecutiveWords = 0;
  let longestSourceCaptureId: string | undefined;

  for (const capture of captures) {
    const sourceTokens = tokenizeForCopyright(capture.content);
    let previous = new Uint32Array(sourceTokens.length + 1);
    let current = new Uint32Array(sourceTokens.length + 1);
    for (let draftIndex = 1; draftIndex <= draftTokens.length; draftIndex += 1) {
      current.fill(0);
      let longestRunEndingHere = 0;
      for (let sourceIndex = 1; sourceIndex <= sourceTokens.length; sourceIndex += 1) {
        if (draftTokens[draftIndex - 1] === sourceTokens[sourceIndex - 1]) {
          const runLength = previous[sourceIndex - 1] + 1;
          current[sourceIndex] = runLength;
          if (runLength > longestRunEndingHere) longestRunEndingHere = runLength;
          if (runLength > longestConsecutiveWords) {
            longestConsecutiveWords = runLength;
            longestSourceCaptureId = capture.captureId;
          }
        }
      }
      // The longest run ending at this draft token subsumes every shorter run
      // ending here, so marking it covers all qualifying positions exactly.
      if (longestRunEndingHere >= minRunTokens) {
        for (let offset = 0; offset < longestRunEndingHere; offset += 1) {
          inQualifyingRun[draftIndex - 1 - offset] = 1;
        }
      }
      const reused = previous;
      previous = current;
      current = reused;
    }
  }

  const qualifyingRunLengths: number[] = [];
  let matchedDraftWords = 0;
  let openRun = 0;
  for (let index = 0; index < inQualifyingRun.length; index += 1) {
    if (inQualifyingRun[index] === 1) {
      openRun += 1;
      matchedDraftWords += 1;
    } else if (openRun > 0) {
      qualifyingRunLengths.push(openRun);
      openRun = 0;
    }
  }
  if (openRun > 0) qualifyingRunLengths.push(openRun);

  const totalDraftWords = draftTokens.length;
  const matchedDraftRatio = totalDraftWords === 0 ? 0 : matchedDraftWords / totalDraftWords;
  return {
    sourceCaptureId: longestSourceCaptureId,
    longestConsecutiveWords,
    matchedDraftWords,
    totalDraftWords,
    matchedDraftRatio,
    limits,
    minRunTokens,
    qualifyingRunLengths: Object.freeze(qualifyingRunLengths),
    violatedByConsecutiveWords: longestConsecutiveWords >= limits.consecutiveWords,
    violatedByMatchedDraftRatio: totalDraftWords > 0 && matchedDraftRatio >= limits.matchedDraftRatio,
  };
}

function copyrightViolated(comparison: CopyrightComparison): boolean {
  return comparison.violatedByConsecutiveWords || comparison.violatedByMatchedDraftRatio;
}

function activeRules(
  ruleSet: PlatformRuleSet,
  platform: TargetPlatform,
  checkedAt: string,
): { rules: readonly ComplianceRuleDefinition[]; errors: readonly ComplianceConfigurationError[] } {
  const instant = Date.parse(checkedAt);
  const errors: ComplianceConfigurationError[] = [];
  const rules = ruleSet.rules.filter((rule) => {
    if (rule.platform !== platform) return false;
    const from = Date.parse(rule.effectiveFrom);
    const to = rule.effectiveTo === undefined ? undefined : Date.parse(rule.effectiveTo);
    if (!Number.isFinite(from) || (to !== undefined && (!Number.isFinite(to) || to <= from))) {
      errors.push({ code: "CONFIG_UNAVAILABLE", detail: `Invalid effective range for rule ${rule.id}`, ruleId: rule.id });
      return false;
    }
    return from <= instant && (to === undefined || instant < to);
  });

  const ids = new Set<string>();
  for (const rule of rules) {
    if (!rule.id || !rule.version || ids.has(rule.id)) {
      errors.push({ code: "CONFIG_UNAVAILABLE", detail: `Invalid or duplicate active rule id ${rule.id || "<empty>"}`, ruleId: rule.id || undefined });
    }
    ids.add(rule.id);
  }
  return { rules, errors };
}

function normalizedIncludes(container: string, expected: string): boolean {
  return htmlToText(container).normalize("NFKC").toLocaleLowerCase("vi")
    .includes(htmlToText(expected).normalize("NFKC").toLocaleLowerCase("vi"));
}

function checkAttribution(
  artifact: PlatformArtifact,
  terms: readonly SourceTermsDefinition[],
): readonly string[] {
  const failures: string[] = [];
  for (const sourceTerms of terms) {
    if (!sourceTerms.attributionRequired) continue;
    if (artifact.attribution.trim().length === 0) {
      failures.push(`${sourceTerms.sourceId}: attribution is required`);
      continue;
    }
    if (
      sourceTerms.requiredAttributionText !== undefined &&
      !normalizedIncludes(artifact.attribution, sourceTerms.requiredAttributionText)
    ) {
      failures.push(`${sourceTerms.sourceId}: required attribution text is missing`);
    }
    if (
      sourceTerms.requiredAttributionUrl !== undefined &&
      !normalizedIncludes(artifact.attribution, sourceTerms.requiredAttributionUrl)
    ) {
      failures.push(`${sourceTerms.sourceId}: required attribution URL is missing`);
    }
  }
  return failures;
}

function keywordViolation(text: string, parameters: Readonly<Record<string, unknown>>): boolean | undefined {
  const keywords = parameters.keywords;
  if (!Array.isArray(keywords) || keywords.length === 0 || keywords.some((value) => typeof value !== "string" || !value.trim())) {
    return undefined;
  }
  const matches = keywords.map((keyword) => normalizedIncludes(text, keyword as string));
  return parameters.match === "All" ? matches.every(Boolean) : matches.some(Boolean);
}

function patternViolation(text: string, parameters: Readonly<Record<string, unknown>>): boolean | undefined {
  if (typeof parameters.pattern !== "string" || parameters.pattern.length === 0) return undefined;
  if (parameters.flags !== undefined && typeof parameters.flags !== "string") return undefined;
  try {
    const flags = (parameters.flags ?? "iu").replace(/[gy]/gu, "");
    return new RegExp(parameters.pattern, flags).test(text);
  } catch {
    return undefined;
  }
}

interface RuleEvaluationBundle {
  readonly evaluation: RuleEvaluation;
  readonly copyrightComparison?: CopyrightComparison;
  readonly error?: ComplianceConfigurationError;
}

async function evaluateRule(
  rule: ComplianceRuleDefinition,
  artifact: PlatformArtifact,
  captures: readonly SourceCapture[],
  attributionOk: boolean,
  classifier: ClassifierRuleEvaluator | undefined,
  signal: AbortSignal,
): Promise<RuleEvaluationBundle> {
  let violated: boolean | undefined;
  let copyrightComparison: CopyrightComparison | undefined;
  if (rule.kind === "Keyword") violated = keywordViolation(policyText(artifact), rule.parameters);
  if (rule.kind === "Pattern") violated = patternViolation(policyText(artifact), rule.parameters);
  if (rule.kind === "Attribution") violated = !attributionOk;
  if (rule.kind === "Copyright") {
    const limits = validLimits(rule.parameters);
    if (limits !== undefined) {
      copyrightComparison = compareCopyright(copyrightText(artifact), captures, limits);
      violated = copyrightViolated(copyrightComparison);
    }
  }
  if (rule.kind === "Classifier" && classifier !== undefined) {
    violated = await classifier.evaluate(rule, artifact, signal);
  }

  if (violated === undefined) {
    const detail = rule.kind === "Classifier" && classifier === undefined
      ? `Classifier evaluator unavailable for rule ${rule.id}`
      : `Invalid parameters for rule ${rule.id}`;
    return {
      evaluation: { ruleId: rule.id, ruleVersion: rule.version, status: "ConfigUnavailable", reason: detail },
      error: { code: "CONFIG_UNAVAILABLE", detail, ruleId: rule.id },
    };
  }
  return {
    evaluation: {
      ruleId: rule.id,
      ruleVersion: rule.version,
      status: violated ? "Violated" : "Passed",
      reason: violated ? `Rule ${rule.id} was violated` : undefined,
    },
    copyrightComparison,
  };
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

export class ComplianceChecker {
  private readonly options: ComplianceCheckerOptions;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: ComplianceCheckerOptions) {
    this.options = options;
    if (!options.evaluatorVersion.trim()) throw new Error("evaluatorVersion is required");
    const configuredTimeout = options.timeoutMs ?? DEFAULT_COMPLIANCE_TIMEOUT_MS;
    if (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0) throw new Error("timeoutMs must be positive");
    this.timeoutMs = Math.min(configuredTimeout, DEFAULT_COMPLIANCE_TIMEOUT_MS);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
  }

  async check(input: ComplianceCheckInput): Promise<ArtifactComplianceResult> {
    const checkedAt = this.now().toISOString();
    const errors: ComplianceConfigurationError[] = [];
    if (input.artifact.draftRevisionId !== input.draftRevision.id) {
      errors.push({
        code: "ARTIFACT_BINDING_INVALID",
        detail: `Artifact ${input.artifact.id} is not bound to revision ${input.draftRevision.id}`,
      });
    }

    let rules: readonly ComplianceRuleDefinition[] = [];
    if (input.ruleSet === undefined || !input.ruleSet.version.trim()) {
      errors.push({ code: "CONFIG_UNAVAILABLE", detail: "Community standards configuration is unavailable" });
    } else {
      const selected = activeRules(input.ruleSet, input.artifact.platform, checkedAt);
      rules = selected.rules;
      errors.push(...selected.errors);
      if (rules.length === 0) {
        errors.push({ code: "CONFIG_UNAVAILABLE", detail: `No active community-standard rules for ${input.artifact.platform}` });
      }
    }

    const configuredTerms = input.sourceTerms ?? [];
    if (configuredTerms.length === 0) {
      errors.push({ code: "CONFIG_UNAVAILABLE", detail: "Source Terms configuration is unavailable" });
    }
    if (input.sourceCaptures.length === 0) {
      errors.push({ code: "CONFIG_UNAVAILABLE", detail: "Captured origin-source content is unavailable" });
    }

    const termKeys = new Set<string>();
    for (const terms of configuredTerms) {
      const key = `${terms.sourceId}\u0000${terms.version}`;
      if (!terms.sourceId || !terms.version || termKeys.has(key)) {
        errors.push({ code: "CONFIG_UNAVAILABLE", detail: `Invalid or duplicate Source Terms ${terms.sourceId}@${terms.version}` });
      }
      termKeys.add(key);
    }
    for (const capture of input.sourceCaptures) {
      if (!termKeys.has(`${capture.sourceId}\u0000${capture.termsVersion}`)) {
        errors.push({
          code: "CONFIG_UNAVAILABLE",
          detail: `Source Terms ${capture.sourceId}@${capture.termsVersion} are unavailable`,
        });
      }
    }

    const applicableTerms = configuredTerms.filter((terms) =>
      input.sourceCaptures.some((capture) => capture.sourceId === terms.sourceId && capture.termsVersion === terms.version),
    );
    const attributionFailures = checkAttribution(input.artifact, applicableTerms);
    const attributionOk = attributionFailures.length === 0;

    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const evaluationsPromise = Promise.all(
      rules.map((rule) => evaluateRule(
        rule,
        input.artifact,
        input.sourceCaptures,
        attributionOk,
        this.options.classifier,
        controller.signal,
      )),
    );
    const timeoutPromise = new Promise<readonly RuleEvaluationBundle[]>((resolve) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        resolve(rules.map((rule) => ({
          evaluation: {
            ruleId: rule.id,
            ruleVersion: rule.version,
            status: "ConfigUnavailable",
            reason: `Evaluation timed out for rule ${rule.id}`,
          },
          error: { code: "EVALUATION_TIMEOUT", detail: `Compliance evaluation exceeded ${this.timeoutMs}ms`, ruleId: rule.id },
        })));
      }, this.timeoutMs);
      timeoutHandle.unref?.();
    });
    const bundles = await Promise.race([evaluationsPromise, timeoutPromise]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    errors.push(...bundles.flatMap((bundle) => bundle.error === undefined ? [] : [bundle.error]));

    const ruleEvaluations = bundles.map((bundle) => bundle.evaluation);
    const violatedRuleIds = unique(
      ruleEvaluations.filter((evaluation) => evaluation.status === "Violated").map((evaluation) => evaluation.ruleId),
    );
    const configuredCopyrightComparisons = bundles.flatMap((bundle) =>
      bundle.copyrightComparison === undefined ? [] : [bundle.copyrightComparison],
    );
    const copyrightComparisons = configuredCopyrightComparisons.length > 0
      ? configuredCopyrightComparisons
      : [compareCopyright(copyrightText(input.artifact), input.sourceCaptures)];
    const copyrightOk = copyrightComparisons.every((comparison) => !copyrightViolated(comparison));

    const reasons = [
      ...violatedRuleIds.map((id) => `RULE_VIOLATION:${id}`),
      ...attributionFailures.map((failure) => `ATTRIBUTION_REQUIRED:${failure}`),
      ...copyrightComparisons
        .filter(copyrightViolated)
        .map((comparison) =>
          `COPYRIGHT_RISK:longest=${comparison.longestConsecutiveWords},matched=${comparison.matchedDraftWords}/${comparison.totalDraftWords}`,
        ),
      ...errors.map((error) => `${error.code}:${error.detail}`),
    ];
    const configurationAvailable = !errors.some((error) =>
      error.code === "CONFIG_UNAVAILABLE" || error.code === "EVALUATION_TIMEOUT",
    );
    const passed =
      errors.length === 0 &&
      violatedRuleIds.length === 0 &&
      attributionOk &&
      copyrightOk &&
      ruleEvaluations.every((evaluation) => evaluation.status === "Passed");

    const result: ArtifactComplianceResult = Object.freeze({
      id: this.idFactory(),
      artifactId: input.artifact.id,
      artifactHash: input.artifact.artifactHash,
      draftRevisionId: input.draftRevision.id,
      platform: input.artifact.platform,
      ruleSetVersion: input.ruleSet?.version ?? "unavailable",
      sourceTermsVersions: Object.freeze([...unique(configuredTerms.map((terms) => terms.version))].sort()),
      evaluatorVersion: this.options.evaluatorVersion,
      rendererVersion: input.artifact.rendererVersion,
      tokenizerVersion: this.options.tokenizerVersion ?? INTERNAL_VI_TOKENIZER_VERSION,
      passed,
      violatedRuleIds: Object.freeze([...violatedRuleIds]),
      evaluatedRuleIds: Object.freeze(rules.map((rule) => rule.id)),
      ruleEvaluations: Object.freeze(ruleEvaluations),
      attributionOk,
      copyrightOk,
      configurationAvailable,
      errors: Object.freeze([...errors]),
      attributionFailures: Object.freeze([...attributionFailures]),
      copyrightComparisons: Object.freeze(copyrightComparisons),
      reasons: Object.freeze(reasons),
      checkedAt,
    });

    await this.options.persistence.persistComplianceResult(result);
    return result;
  }
}
