import type {
  Claim,
  ContentDraft,
  DraftRevision,
  ReproducibilityMetadata,
  ResearchResult,
  Topic,
} from "../domain/content.js";
import type { ModelAGenerationPort, ModelBCritiquePort } from "../adapters/ports.js";

/**
 * The smallest inputs the real Model A and Model B adapters accept.
 *
 * Model failures have been diagnosed by re-running whole cycles: minutes each, real money,
 * and an answer no more precise than `kiểm chứng chặn (có thể thử lại): 3`. These fixtures
 * exercise the same adapters, the same prompts and the same response schemas, on one claim.
 */
const NOW = "2026-01-01T00:00:00.000Z";

const sourceRef = {
  sourceId: "doctor",
  captureId: "doctor-capture",
  url: "https://github.com/areaoneamusement/FB_AI",
  capturedAt: NOW,
  termsVersion: "doctor-terms-v1",
} as const;

export const DOCTOR_TOPIC: Topic = {
  id: "doctor-topic",
  sourceRef,
  externalId: "doctor-1",
  title: "Kiểm tra kết nối model",
  createdAt: NOW,
  score: { total: 100, breakdown: [], scoringConfigVersion: "doctor-v1" },
  categories: ["AI News"],
};

export const DOCTOR_RESEARCH: ResearchResult = {
  id: "doctor-research",
  topicId: DOCTOR_TOPIC.id,
  items: [
    {
      id: "doctor-research-item",
      content:
        "FB_AI là nền tảng sản xuất nội dung có kiểm chứng, chạy theo mô hình " +
        "human-in-the-loop và không tự động đăng bài ở Phase 1.",
      kind: "Summarized",
      evidenceRefs: [sourceRef],
    },
  ],
  status: "Ok",
  unreachableSources: [],
  skippedSources: [],
};

const draftContent: ContentDraft = {
  topicId: DOCTOR_TOPIC.id,
  facebookPost:
    "FB_AI là nền tảng sản xuất nội dung có kiểm chứng, chạy theo mô hình human-in-the-loop.",
  guide: [
    {
      heading: "Tổng quan",
      body: "FB_AI không tự động đăng bài ở Phase 1.",
      imageSuggestions: [{ description: "Sơ đồ quy trình duyệt bài" }],
    },
  ],
  videoScript: {
    intro: "Giới thiệu FB_AI.",
    body: "Nội dung được kiểm chứng chéo bởi hai model khác nhà cung cấp.",
    conclusion: "Người vận hành duyệt trước khi đăng.",
  },
  originLinks: [sourceRef.url],
  language: "vi",
};

export const DOCTOR_REVISION: DraftRevision = {
  id: "doctor-revision",
  draftId: "doctor-draft",
  revision: 1,
  content: draftContent,
  contentHash: "doctor-hash",
  createdBy: "System",
  createdAt: NOW,
};

export const DOCTOR_CLAIMS: readonly Claim[] = [
  {
    id: "doctor-claim-1",
    draftRevisionId: DOCTOR_REVISION.id,
    format: "FacebookPost",
    path: "facebookPost",
    startOffset: 0,
    endOffset: draftContent.facebookPost.length,
    text: "FB_AI không tự động đăng bài ở Phase 1.",
  },
];

export interface ModelDiagnosis {
  readonly label: string;
  readonly model: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly elapsedMs: number;
}

function control(deadlineMs: number): { signal: AbortSignal; deadlineAt: string } {
  return {
    signal: AbortSignal.timeout(deadlineMs),
    deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
  };
}

function metadata(provider: string, model: string): ReproducibilityMetadata {
  return {
    provider,
    model,
    promptVersion: "doctor",
    configurationVersion: "doctor",
  };
}

/** Asks Model A for one short draft, so a prompt or schema break surfaces without a cycle. */
export async function diagnoseModelA(
  client: ModelAGenerationPort,
  model: string,
  deadlineMs: number,
): Promise<ModelDiagnosis> {
  const startedAt = Date.now();
  try {
    const response = await client.generate(
      {
        topic: DOCTOR_TOPIC,
        research: DOCTOR_RESEARCH,
        inputHash: "doctor-input-hash",
        requestedModel: metadata("anthropic", model),
        language: "vi",
      },
      control(deadlineMs),
    );
    const words = response.content.facebookPost.trim().split(/\s+/).length;
    return {
      label: "Model A (Claude)",
      model: response.provenance.model,
      ok: true,
      detail: `viết được bài ${words} từ`,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      label: "Model A (Claude)",
      model,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/** Asks Model B to judge one claim that the research plainly supports. */
export async function diagnoseModelB(
  client: ModelBCritiquePort,
  model: string,
  deadlineMs: number,
): Promise<ModelDiagnosis> {
  const startedAt = Date.now();
  try {
    const response = await client.critique(
      {
        revision: DOCTOR_REVISION,
        claims: DOCTOR_CLAIMS,
        research: DOCTOR_RESEARCH,
        round: 1,
        requestedModel: metadata("google", model),
      },
      control(deadlineMs),
    );
    const verdicts = response.findings.map(({ verdict }) => verdict).join(", ");
    return {
      label: "Model B (Gemini)",
      model: response.provenance.model,
      ok: true,
      detail: `phán quyết: ${verdicts || "(rỗng)"}`,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      label: "Model B (Gemini)",
      model,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    };
  }
}
