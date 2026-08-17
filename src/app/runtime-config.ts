import { readFile } from "node:fs/promises";

import type { ComplianceConfiguration, MvpCompositionConfig } from "./mvp-composition-root.js";
import type { ComplianceRuleKind } from "../compliance/compliance-checker.js";
import type {
  DraftRevision,
  PlatformArtifact,
  ReproducibilityMetadata,
  ResearchResult,
  TargetPlatform,
} from "../domain/content.js";
import type { SourceConfig } from "../domain/source.js";
import type { CollectedSourceItem } from "../pipeline/source-collector.js";
import type { CriterionValues } from "../pipeline/topic-scorer.js";

/**
 * Everything an operator configures without touching code. Loaded from a JSON file so a
 * run is reproducible: the file, the model versions, and the scoring version together
 * describe how a given topic was selected.
 */
export interface RuntimeFileConfig {
  readonly language: string;
  readonly sources: readonly SourceConfig[];
  readonly collection?: {
    readonly windowHours?: number;
    readonly maxRetries?: number;
    readonly perRequestTimeoutMs?: number;
  };
  readonly scoring: {
    readonly version: string;
    readonly minScore: number;
    /** Age in hours at which freshness reaches 0. */
    readonly freshnessHorizonHours: number;
    /** Star count at which authority reaches 100. Non-GitHub sources use source priority. */
    readonly authorityStarTarget: number;
    /** Lowercase keywords; each hit raises the relevance score. */
    readonly relevanceKeywords: readonly string[];
  };
  readonly categories: {
    readonly allowed: readonly string[];
    /** Category → lowercase keywords that assign an item to it. */
    readonly keywords: Readonly<Record<string, readonly string[]>>;
    readonly fallback: string;
  };
  readonly rendering: {
    readonly rendererVersion: string;
    readonly platforms: readonly TargetPlatform[];
  };
  readonly compliance: {
    readonly evaluatorVersion: string;
    readonly ruleSetVersion: string;
    /** Phrases that must never appear in published content, per platform. */
    readonly bannedKeywords: readonly string[];
    readonly termsVersion: string;
    /** Source ids that require attribution in the published post. */
    readonly attributionRequiredSourceIds: readonly string[];
  };
  readonly research?: {
    readonly minItems?: number;
    readonly perSourceTimeoutMs?: number;
    readonly overallDeadlineMs?: number;
  };
  readonly verification?: {
    readonly maxRounds?: number;
    readonly deadlineMs?: number;
  };
  readonly generation?: {
    readonly deadlineMs?: number;
    readonly brandVoiceVersion?: string;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export async function loadRuntimeConfig(path: string): Promise<RuntimeFileConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(
      `Không đọc được file cấu hình ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `${path} không phải JSON hợp lệ: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateRuntimeConfig(parsed, path);
}

export function validateRuntimeConfig(value: unknown, path = "config"): RuntimeFileConfig {
  if (typeof value !== "object" || value === null) {
    throw new ConfigError(`${path} phải là một object JSON`);
  }
  const config = value as RuntimeFileConfig;

  if (!Array.isArray(config.sources) || config.sources.length === 0) {
    throw new ConfigError(`${path}.sources phải có ít nhất một nguồn`);
  }
  const ids = new Set<string>();
  for (const source of config.sources) {
    if (ids.has(source.id)) throw new ConfigError(`${path}.sources có id trùng: ${source.id}`);
    ids.add(source.id);
    if (!source.url.startsWith("https://")) {
      throw new ConfigError(`${path}.sources[${source.id}].url phải dùng https`);
    }
  }
  if (!config.sources.some((source) => source.active)) {
    throw new ConfigError(`${path}.sources phải có ít nhất một nguồn active`);
  }
  if (config.scoring === undefined || typeof config.scoring.minScore !== "number") {
    throw new ConfigError(`${path}.scoring.minScore là bắt buộc`);
  }
  if (config.categories === undefined || config.categories.allowed.length === 0) {
    throw new ConfigError(`${path}.categories.allowed phải có ít nhất một mục`);
  }
  if (!config.categories.allowed.includes(config.categories.fallback)) {
    throw new ConfigError(
      `${path}.categories.fallback (${config.categories.fallback}) phải nằm trong allowed`,
    );
  }
  if (config.rendering === undefined || config.rendering.platforms.length === 0) {
    throw new ConfigError(`${path}.rendering.platforms phải có ít nhất một nền tảng`);
  }
  return config;
}

export interface CompositionInputs {
  readonly file: RuntimeFileConfig;
  readonly sqlitePath: string;
  readonly staticDirectory: string;
  readonly modelA: ReproducibilityMetadata;
  readonly modelB: ReproducibilityMetadata;
  readonly dashboardHttp: MvpCompositionConfig["dashboardHttp"];
  readonly now?: () => Date;
}

/** Turns the operator-facing JSON into the composition root's configuration. */
export function buildCompositionConfig(inputs: CompositionInputs): MvpCompositionConfig {
  const { file } = inputs;
  const now = inputs.now ?? (() => new Date());

  return {
    sqlitePath: inputs.sqlitePath,
    sources: file.sources,
    ...(file.collection === undefined ? {} : { collection: file.collection }),
    scoring: {
      config: {
        version: file.scoring.version,
        criteria: [
          { id: "freshness", weightPercent: 40 },
          { id: "authority", weightPercent: 30 },
          { id: "relevance", weightPercent: 30 },
        ],
      },
      minScore: file.scoring.minScore,
      valuesFor: (item) => scoreItem(item, file, now()),
    },
    ...(file.research === undefined ? {} : { research: file.research }),
    generation: {
      requestedModel: inputs.modelA,
      language: file.language,
      ...(file.generation?.brandVoiceVersion === undefined
        ? {}
        : { brandVoiceVersion: file.generation.brandVoiceVersion }),
      ...(file.generation?.deadlineMs === undefined
        ? {}
        : { deadlineMs: file.generation.deadlineMs }),
    },
    verification: {
      requestedModel: inputs.modelB,
      requestedCorrectionModel: inputs.modelA,
      ...(file.verification?.maxRounds === undefined
        ? {}
        : { maxRounds: file.verification.maxRounds }),
      ...(file.verification?.deadlineMs === undefined
        ? {}
        : { deadlineMs: file.verification.deadlineMs }),
    },
    rendering: file.rendering,
    compliance: {
      evaluatorVersion: file.compliance.evaluatorVersion,
      resolve: (artifact, revision, research) => resolveCompliance(artifact, revision, research, file),
    },
    categories: {
      allowed: file.categories.allowed,
      selectFor: (item) => categorize(item, file),
    },
    dashboardHttp: {
      ...inputs.dashboardHttp,
      staticDirectory: inputs.staticDirectory,
    },
    now,
  };
}

// ----------------------------------------------------------------- scoring

/**
 * All three criteria are scored on 0–100 so the weighted total in `TopicScorer` stays on
 * the same scale regardless of which source an item came from.
 */
export function scoreItem(
  item: CollectedSourceItem,
  config: RuntimeFileConfig,
  now: Date,
): CriterionValues {
  return {
    freshness: freshnessScore(item.publishedOrUpdatedAt, config.scoring.freshnessHorizonHours, now),
    authority: authorityScore(item, config),
    relevance: relevanceScore(item, config.scoring.relevanceKeywords),
  };
}

function freshnessScore(publishedAt: string, horizonHours: number, now: Date): number {
  const published = Date.parse(publishedAt);
  if (!Number.isFinite(published) || horizonHours <= 0) return 0;
  const ageHours = (now.getTime() - published) / 3_600_000;
  if (ageHours <= 0) return 100;
  if (ageHours >= horizonHours) return 0;
  return round2(100 * (1 - ageHours / horizonHours));
}

function authorityScore(item: CollectedSourceItem, config: RuntimeFileConfig): number {
  const stars = item.github?.stars;
  if (stars === undefined) {
    // Non-GitHub sources have no popularity signal, so the operator's declared priority
    // stands in for it.
    const source = config.sources.find((candidate) => candidate.id === item.sourceId);
    return clamp100(source?.priority ?? 0);
  }
  const target = config.scoring.authorityStarTarget;
  if (target <= 0) return 100;
  // Logarithmic: the difference between 100 and 1,000 stars matters more than between
  // 10,000 and 100,000.
  return round2(clamp100((Math.log10(stars + 1) / Math.log10(target + 1)) * 100));
}

function relevanceScore(item: CollectedSourceItem, keywords: readonly string[]): number {
  if (keywords.length === 0) return 0;
  const haystack = `${item.title} ${item.body}`.toLowerCase();
  const hits = keywords.filter((keyword) => haystack.includes(keyword)).length;
  // Three distinct keyword hits is already a strongly on-topic item.
  return round2(clamp100((hits / Math.min(3, keywords.length)) * 100));
}

// -------------------------------------------------------------- categories

export function categorize(
  item: CollectedSourceItem,
  config: RuntimeFileConfig,
): readonly string[] {
  const haystack = `${item.title} ${item.body}`.toLowerCase();
  const matched = config.categories.allowed.filter((category) => {
    const keywords = config.categories.keywords[category] ?? [];
    return keywords.some((keyword) => haystack.includes(keyword));
  });
  return matched.length > 0 ? matched : [config.categories.fallback];
}

// -------------------------------------------------------------- compliance

/**
 * Builds the per-artifact compliance inputs. Copyright comparison uses the research the
 * draft was written from, which is the same text the operator can inspect in the review
 * dashboard — so a flagged overlap can always be traced to a specific capture.
 */
export function resolveCompliance(
  artifact: PlatformArtifact,
  _revision: DraftRevision,
  research: ResearchResult,
  config: RuntimeFileConfig,
): ComplianceConfiguration {
  const captures = research.items.flatMap((item) =>
    item.evidenceRefs.map((ref) => ({
      sourceId: ref.sourceId,
      captureId: ref.captureId,
      termsVersion: ref.termsVersion,
      url: ref.url,
      content: item.content,
    })),
  );

  const sourceTerms = config.compliance.attributionRequiredSourceIds.map((sourceId) => {
    const source = config.sources.find((candidate) => candidate.id === sourceId);
    return {
      sourceId,
      version: config.compliance.termsVersion,
      attributionRequired: true,
      ...(source === undefined ? {} : { requiredAttributionUrl: source.url }),
    };
  });

  return {
    ruleSet: {
      version: config.compliance.ruleSetVersion,
      rules: config.compliance.bannedKeywords.map((keyword, index) => ({
        id: `banned-${artifact.platform}-${index}`,
        platform: artifact.platform,
        version: config.compliance.ruleSetVersion,
        kind: "Keyword" as ComplianceRuleKind,
        parameters: { keywords: [keyword] },
        effectiveFrom: "2020-01-01T00:00:00.000Z",
      })),
    },
    sourceTerms,
    sourceCaptures: captures,
  };
}

function clamp100(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
