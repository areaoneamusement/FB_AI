import type { SourceReference } from "./source.js";

export type TargetPlatform = "Facebook_Page" | "Facebook_Group" | "YouTube";

export interface ScoreBreakdown {
  readonly criterionId: string;
  readonly componentValue: number;
  readonly weightPercent: number;
}

export interface TopicScore {
  readonly total: number | null;
  readonly breakdown: readonly ScoreBreakdown[];
  readonly scoringConfigVersion: string;
  readonly unscoredReason?: string;
}

export interface Topic {
  readonly id: string;
  readonly sourceRef: SourceReference;
  readonly externalId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly score: TopicScore;
  readonly categories: readonly string[];
}

export type ResearchKind = "Quoted" | "Summarized" | "Inferred";

export interface ReproducibilityMetadata {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly configurationVersion: string;
}

export interface ResearchItem {
  readonly id: string;
  readonly content: string;
  readonly kind: ResearchKind;
  readonly evidenceRefs: readonly SourceReference[];
  readonly modelProvenance?: ReproducibilityMetadata & { readonly confidence?: number };
}

export interface ResearchResult {
  readonly id: string;
  readonly topicId: string;
  readonly items: readonly ResearchItem[];
  readonly status: "Ok" | "InsufficientData";
  readonly reason?: string;
  readonly unreachableSources: readonly SourceReference[];
}

export interface ImageSuggestion {
  readonly description: string;
}

export interface GuideSection {
  readonly heading: string;
  readonly body: string;
  readonly imageSuggestions: readonly ImageSuggestion[];
}

export interface VideoScript {
  readonly intro: string;
  readonly body: string;
  readonly conclusion: string;
}

export interface ContentDraft {
  readonly topicId: string;
  readonly facebookPost: string;
  readonly guide: readonly GuideSection[];
  readonly videoScript: VideoScript;
  readonly originLinks: readonly string[];
  readonly language: string;
  readonly brandVoiceVersion?: string;
}

export interface DraftRevision {
  readonly id: string;
  readonly draftId: string;
  readonly revision: number;
  readonly parentRevisionId?: string;
  readonly content: ContentDraft;
  readonly contentHash: string;
  readonly createdBy: "System" | "Operator";
  readonly actorId?: string;
  readonly createdAt: string;
}

export interface DraftPatch {
  readonly content: ContentDraft;
}

export interface Claim {
  readonly id: string;
  readonly draftRevisionId: string;
  readonly format: "FacebookPost" | "Guide" | "VideoScript";
  readonly path: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
}

export interface VerificationFinding {
  readonly claimId: string;
  readonly verdict: "Pass" | "Contradiction" | "Unsupported";
  readonly evidenceRefs: readonly SourceReference[];
  readonly description?: string;
  readonly confidence?: number;
}

export interface VerificationReport {
  readonly id: string;
  readonly draftRevisionId: string;
  readonly contentHash: string;
  readonly researchResultId: string;
  readonly round: number;
  readonly modelB: ReproducibilityMetadata;
  readonly findings: readonly VerificationFinding[];
  readonly passed: boolean;
}

export interface PlatformArtifact {
  readonly id: string;
  readonly draftRevisionId: string;
  readonly platform: TargetPlatform;
  readonly rendererVersion: string;
  readonly body: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly attribution: string;
  readonly imageSuggestions: readonly ImageSuggestion[];
  readonly artifactHash: string;
  readonly createdAt: string;
}

export interface ComplianceResult {
  readonly id: string;
  readonly artifactId: string;
  readonly artifactHash: string;
  readonly draftRevisionId: string;
  readonly platform: TargetPlatform;
  readonly ruleSetVersion: string;
  readonly sourceTermsVersions: readonly string[];
  readonly evaluatorVersion: string;
  readonly passed: boolean;
  readonly violatedRuleIds: readonly string[];
  readonly attributionOk: boolean;
  readonly copyrightOk: boolean;
  readonly reasons: readonly string[];
  readonly checkedAt: string;
}
