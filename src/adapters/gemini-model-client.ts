import { GoogleGenAI } from "@google/genai";

import { ModelResponseError, withDeadline } from "./anthropic-model-client.js";
import type {
  ModelBCritiquePort,
  ModelBCritiqueRequest,
  ModelBCritiqueResponse,
} from "./ports.js";
import type {
  Claim,
  ReproducibilityMetadata,
  ResearchResult,
  VerificationFinding,
} from "../domain/content.js";
import type { SourceReference } from "../domain/source.js";

/**
 * Model B — cross-verification, backed by Gemini.
 *
 * Deliberately a different provider from Model A: two models from the same family share
 * failure modes, so a claim both invent would pass verification. Model B never writes
 * content; it only rules on whether each claim is supported by the research it is shown.
 */
export interface GeminiModelClientOptions {
  readonly apiKey?: string;
  readonly model?: string;
  /** Injected for tests. */
  readonly client?: GeminiLike;
}

/** The slice of the Gemini SDK this adapter uses. */
export interface GeminiLike {
  readonly models: {
    generateContent(params: {
      model: string;
      contents: string;
      config?: Record<string, unknown>;
    }): Promise<{ text?: string | undefined }>;
  };
}

export const GEMINI_PROVIDER = "google";
/**
 * Model B default.
 *
 * `gemini-2.5-pro` was the default until Google stopped serving it to new accounts:
 * `404 ... no longer available to new users. Please update your code to use
 * models/gemini-3.1-pro-preview`. Every cycle blocked on that, three attempts at a
 * time, reported only as a retryable verification failure.
 *
 * Override with `GEMINI_MODEL` when an account has access to something else;
 * `npm run doctor` calls this model and prints whatever Google answers.
 */
export const DEFAULT_MODEL_B = "gemini-3.1-pro-preview";
export const CRITIQUE_PROMPT_VERSION = "model-b-critique-v1";
export const MODEL_B_CONFIGURATION_VERSION = "model-b-config-v1";

const VERDICTS = ["Pass", "Contradiction", "Unsupported"] as const;
type Verdict = (typeof VERDICTS)[number];

const SYSTEM_INSTRUCTION = [
  "Bạn là người kiểm chứng độc lập. Bạn không viết lại nội dung và không đề xuất cách diễn đạt.",
  "",
  "Với mỗi claim, chỉ được dùng phần research kèm theo làm căn cứ. Kiến thức sẵn có của bạn",
  "không phải bằng chứng — nếu research không nói, thì claim đó là Unsupported dù bạn tin nó đúng.",
  "",
  "Phán quyết:",
  "- Pass: research nêu trực tiếp claim này.",
  "- Contradiction: research nói điều ngược lại.",
  "- Unsupported: research không đủ để kết luận.",
  "",
  "evidence là số thứ tự các mục research đã dùng. Pass và Contradiction bắt buộc phải có",
  "ít nhất một evidence; Unsupported thì để mảng rỗng.",
].join("\n");

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claimId: { type: "string" },
          verdict: { type: "string", enum: [...VERDICTS] },
          evidence: {
            type: "array",
            description: "Số thứ tự các mục research chứng minh phán quyết.",
            items: { type: "integer" },
          },
          description: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["claimId", "verdict", "evidence", "description", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

interface RawFinding {
  readonly claimId?: unknown;
  readonly verdict?: unknown;
  readonly evidence?: unknown;
  readonly description?: unknown;
  readonly confidence?: unknown;
}

export class GeminiModelBClient implements ModelBCritiquePort {
  private readonly client: GeminiLike;
  private readonly model: string;

  constructor(options: GeminiModelClientOptions = {}) {
    this.client =
      options.client ??
      (new GoogleGenAI(
        options.apiKey === undefined ? {} : { apiKey: options.apiKey },
      ) as unknown as GeminiLike);
    this.model = options.model ?? DEFAULT_MODEL_B;
  }

  async critique(
    request: ModelBCritiqueRequest,
    control: ModelCallControlLike,
  ): Promise<ModelBCritiqueResponse> {
    const signal = withDeadline(control);
    const evidenceIndex = buildEvidenceIndex(request.research);

    const prompt = [
      renderNumberedResearch(request.research),
      "",
      `Vòng kiểm chứng ${request.round}. Các claim cần xét:`,
      ...request.claims.map((claim) => `- ${claim.id}: ${claim.text}`),
      "",
      "Trả về đúng một phán quyết cho mỗi claim ở trên.",
    ].join("\n");

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseJsonSchema: FINDINGS_SCHEMA,
        abortSignal: signal,
      },
    });

    const text = response.text;
    if (text === undefined || text.trim().length === 0) {
      throw new ModelResponseError("Model B trả về nội dung rỗng");
    }

    return {
      findings: parseFindings(text, request.claims, evidenceIndex),
      provenance: this.provenance(request.requestedModel),
    };
  }

  private provenance(requested: ReproducibilityMetadata): ReproducibilityMetadata {
    return {
      provider: GEMINI_PROVIDER,
      model: this.model,
      promptVersion: CRITIQUE_PROMPT_VERSION,
      configurationVersion: requested.configurationVersion || MODEL_B_CONFIGURATION_VERSION,
    };
  }
}

/** Structural copy of `ModelCallControl` so this file does not depend on its import path. */
interface ModelCallControlLike {
  readonly signal: AbortSignal;
  readonly deadlineAt: string;
}

// --------------------------------------------------------------- utilities

/**
 * Maps the 1-based indices shown to the model back to the source references they came
 * from, so a finding's evidence always points at a real capture rather than a number
 * the model made up.
 */
export function buildEvidenceIndex(
  research: ResearchResult,
): ReadonlyMap<number, readonly SourceReference[]> {
  const index = new Map<number, readonly SourceReference[]>();
  research.items.forEach((item, position) => {
    index.set(position + 1, item.evidenceRefs);
  });
  return index;
}

export function renderNumberedResearch(research: ResearchResult): string {
  if (research.items.length === 0) return "Research: (không có dữ liệu)";
  const lines = research.items.map((item, position) => {
    const sources = item.evidenceRefs.map((ref) => ref.url).join(", ");
    return [
      `[${position + 1}] (${item.kind}) ${item.content}`,
      sources.length > 0 ? `    Nguồn: ${sources}` : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  });
  return ["Research:", ...lines].join("\n");
}

/**
 * A missing or malformed verdict becomes `Unsupported` rather than being dropped: the
 * pipeline requires one finding per claim, and silently omitting a claim would let it
 * through unverified.
 */
export function parseFindings(
  text: string,
  claims: readonly Claim[],
  evidenceIndex: ReadonlyMap<number, readonly SourceReference[]>,
): readonly VerificationFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ModelResponseError(
      `Không đọc được JSON từ Model B: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const rawFindings =
    typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).findings)
      ? ((parsed as Record<string, unknown>).findings as readonly RawFinding[])
      : [];

  const byClaimId = new Map<string, RawFinding>();
  for (const finding of rawFindings) {
    if (typeof finding.claimId === "string") byClaimId.set(finding.claimId, finding);
  }

  return claims.map((claim) => {
    const raw = byClaimId.get(claim.id);
    const verdict = toVerdict(raw?.verdict);
    const evidenceRefs =
      verdict === "Unsupported" ? [] : resolveEvidence(raw?.evidence, evidenceIndex);

    // A Pass with no traceable evidence is not a pass — the design requires every
    // supported claim to point at a capture.
    const effectiveVerdict: Verdict =
      verdict !== "Unsupported" && evidenceRefs.length === 0 ? "Unsupported" : verdict;

    const description =
      typeof raw?.description === "string" && raw.description.length > 0
        ? raw.description
        : raw === undefined
          ? "Model B không trả phán quyết cho claim này"
          : undefined;

    const confidence = typeof raw?.confidence === "number" ? clamp01(raw.confidence) : undefined;

    return {
      claimId: claim.id,
      verdict: effectiveVerdict,
      evidenceRefs,
      ...(description === undefined ? {} : { description }),
      ...(confidence === undefined ? {} : { confidence }),
    };
  });
}

function toVerdict(value: unknown): Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value)
    ? (value as Verdict)
    : "Unsupported";
}

function resolveEvidence(
  value: unknown,
  evidenceIndex: ReadonlyMap<number, readonly SourceReference[]>,
): readonly SourceReference[] {
  if (!Array.isArray(value)) return [];
  const refs: SourceReference[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "number") continue;
    for (const ref of evidenceIndex.get(entry) ?? []) {
      if (seen.has(ref.captureId)) continue;
      seen.add(ref.captureId);
      refs.push(ref);
    }
  }
  return refs;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
