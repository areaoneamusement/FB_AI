import Anthropic from "@anthropic-ai/sdk";

import type {
  ModelAGenerationPort,
  ModelAGenerationRequest,
  ModelAGenerationResponse,
  ModelCallControl,
} from "./ports.js";
import type {
  ContentDraft,
  GuideSection,
  ReproducibilityMetadata,
  ResearchResult,
  Topic,
  VideoScript,
} from "../domain/content.js";
import type {
  ModelACorrectionPort,
  ModelACorrectionRequest,
  ModelACorrectionResponse,
} from "../pipeline/verification-engine.js";

/**
 * Model A — content generation and correction, backed by the Claude Messages API.
 *
 * The draft is requested as JSON constrained by a schema, so the pipeline never has to
 * parse prose. Every response carries the provider/model/prompt/config versions the
 * design requires for reproducibility.
 */
export interface AnthropicModelClientOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  /** Injected for tests. */
  readonly client?: Pick<Anthropic, "messages">;
}

export const ANTHROPIC_PROVIDER = "anthropic";
export const DEFAULT_MODEL_A = "claude-opus-5";
export const GENERATION_PROMPT_VERSION = "model-a-generate-v1";
export const CORRECTION_PROMPT_VERSION = "model-a-correct-v1";
export const MODEL_A_CONFIGURATION_VERSION = "model-a-config-v1";

const DEFAULT_MAX_TOKENS = 16_000;

export class ModelResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResponseError";
  }
}

/** JSON Schema for `ContentDraft` minus the fields the caller already knows. */
const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    facebookPost: {
      type: "string",
      description: "Bài đăng Facebook hoàn chỉnh, tiếng Việt, kèm hashtag ở cuối.",
    },
    guide: {
      type: "array",
      description: "Cẩm nang chia theo từng phần.",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          body: { type: "string" },
          imageSuggestions: {
            type: "array",
            items: {
              type: "object",
              properties: { description: { type: "string" } },
              required: ["description"],
              additionalProperties: false,
            },
          },
        },
        required: ["heading", "body", "imageSuggestions"],
        additionalProperties: false,
      },
    },
    videoScript: {
      type: "object",
      properties: {
        intro: { type: "string" },
        body: { type: "string" },
        conclusion: { type: "string" },
      },
      required: ["intro", "body", "conclusion"],
      additionalProperties: false,
    },
    originLinks: {
      type: "array",
      description: "URL của mọi nguồn đã dùng. Chỉ dùng URL có trong phần research.",
      items: { type: "string" },
    },
  },
  required: ["facebookPost", "guide", "videoScript", "originLinks"],
  additionalProperties: false,
} as const;

interface DraftPayload {
  readonly facebookPost: string;
  readonly guide: readonly {
    readonly heading: string;
    readonly body: string;
    readonly imageSuggestions: readonly { readonly description: string }[];
  }[];
  readonly videoScript: VideoScript;
  readonly originLinks: readonly string[];
}

const SYSTEM_PROMPT = [
  "Bạn viết nội dung về AI cho một trang Facebook tiếng Việt và kênh YouTube đi kèm.",
  "",
  "Chỉ dùng thông tin có trong phần research được cung cấp. Không thêm số liệu, ngày tháng,",
  "tên sản phẩm hay trích dẫn nào không xuất hiện ở đó — mọi câu khẳng định sẽ được một mô",
  "hình thứ hai đối chiếu lại với chính phần research này.",
  "",
  "Nếu research không đủ để nói một điều gì đó, hãy bỏ điều đó đi thay vì suy đoán.",
  "originLinks chỉ được chứa URL xuất hiện trong research.",
  "",
  "Viết cho người đọc phổ thông: câu ngắn, không thuật ngữ khi có từ thường dùng thay được,",
  "không phóng đại, không hứa hẹn kết quả. Bài Facebook mở đầu bằng thông tin đáng chú ý nhất.",
].join("\n");

export class AnthropicModelAClient implements ModelAGenerationPort, ModelACorrectionPort {
  private readonly client: Pick<Anthropic, "messages">;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicModelClientOptions = {}) {
    this.client =
      options.client ??
      new Anthropic(options.apiKey === undefined ? {} : { apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_MODEL_A;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async generate(
    request: ModelAGenerationRequest,
    control: ModelCallControl,
  ): Promise<ModelAGenerationResponse> {
    const prompt = [
      renderTopic(request.topic),
      renderResearch(request.research),
      "",
      `Ngôn ngữ đầu ra: ${request.language}.`,
      request.brandVoiceVersion === undefined
        ? ""
        : `Phiên bản giọng thương hiệu: ${request.brandVoiceVersion}.`,
      "",
      "Viết bài Facebook, cẩm nang có gợi ý hình ảnh, và kịch bản video cho chủ đề trên.",
    ]
      .filter((line) => line.length > 0)
      .join("\n");

    const payload = await this.complete(prompt, control);
    return {
      content: toContentDraft(payload, request),
      provenance: this.provenance(request.requestedModel, GENERATION_PROMPT_VERSION),
    };
  }

  async correct(
    request: ModelACorrectionRequest,
    control: ModelCallControl,
  ): Promise<ModelACorrectionResponse> {
    const findings = request.findings
      .map((finding, index) => {
        const evidence = finding.evidenceRefs.map((ref) => ref.url).join(", ");
        return [
          `${index + 1}. [${finding.verdict}] ${finding.description ?? "(không có mô tả)"}`,
          evidence.length > 0 ? `   Bằng chứng: ${evidence}` : "",
        ]
          .filter((line) => line.length > 0)
          .join("\n");
      })
      .join("\n");

    const prompt = [
      renderResearch(request.research),
      "",
      "Bản nháp hiện tại:",
      JSON.stringify(request.revision.content, null, 2),
      "",
      `Vòng kiểm chứng ${request.round}. Mô hình kiểm chứng đã đánh dấu các vấn đề sau:`,
      findings,
      "",
      "Sửa lại bản nháp để mọi câu khẳng định đều có căn cứ trong research. Xoá hoặc viết lại",
      "những câu không chứng minh được. Giữ nguyên phần đã đúng.",
    ].join("\n");

    const payload = await this.complete(prompt, control);
    return {
      content: toContentDraft(payload, {
        topic: { id: request.revision.content.topicId },
        language: request.revision.content.language,
        ...(request.revision.content.brandVoiceVersion === undefined
          ? {}
          : { brandVoiceVersion: request.revision.content.brandVoiceVersion }),
      }),
      provenance: this.provenance(request.requestedModel, CORRECTION_PROMPT_VERSION),
    };
  }

  private provenance(
    requested: ReproducibilityMetadata,
    promptVersion: string,
  ): ReproducibilityMetadata {
    return {
      provider: ANTHROPIC_PROVIDER,
      model: this.model,
      promptVersion,
      configurationVersion: requested.configurationVersion || MODEL_A_CONFIGURATION_VERSION,
    };
  }

  private async complete(prompt: string, control: ModelCallControl): Promise<DraftPayload> {
    const signal = withDeadline(control);
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
        output_config: { format: { type: "json_schema", schema: DRAFT_SCHEMA } },
      } as Anthropic.MessageCreateParamsNonStreaming,
      { signal },
    );

    if (response.stop_reason === "refusal") {
      throw new ModelResponseError("Model A từ chối yêu cầu (stop_reason: refusal)");
    }
    if (response.stop_reason === "max_tokens") {
      throw new ModelResponseError(
        `Model A bị cắt ở max_tokens=${this.maxTokens}; tăng maxTokens rồi thử lại`,
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.trim().length === 0) {
      throw new ModelResponseError("Model A trả về nội dung rỗng");
    }
    return parseDraftPayload(text);
  }
}

// --------------------------------------------------------------- utilities

/**
 * Combines the caller's cancellation signal with the absolute deadline the pipeline set,
 * so a slow model call cannot outlive the stage that started it.
 */
export function withDeadline(control: ModelCallControl): AbortSignal {
  const deadline = Date.parse(control.deadlineAt);
  if (!Number.isFinite(deadline)) {
    throw new ModelResponseError(`Deadline không hợp lệ: ${control.deadlineAt}`);
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ModelResponseError("Deadline đã trôi qua trước khi gọi model");
  return AbortSignal.any([control.signal, AbortSignal.timeout(remaining)]);
}

export function parseDraftPayload(text: string): DraftPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ModelResponseError(
      `Không đọc được JSON từ model: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ModelResponseError("Model trả về JSON không phải object");
  }
  const record = parsed as Record<string, unknown>;
  const facebookPost = record.facebookPost;
  const videoScript = record.videoScript;
  if (typeof facebookPost !== "string" || typeof videoScript !== "object" || videoScript === null) {
    throw new ModelResponseError("JSON thiếu facebookPost hoặc videoScript");
  }
  return {
    facebookPost,
    guide: Array.isArray(record.guide) ? (record.guide as DraftPayload["guide"]) : [],
    videoScript: videoScript as VideoScript,
    originLinks: Array.isArray(record.originLinks)
      ? (record.originLinks as readonly string[]).filter((link) => typeof link === "string")
      : [],
  };
}

interface DraftContext {
  readonly topic: { readonly id: string };
  readonly language: string;
  readonly brandVoiceVersion?: string;
}

function toContentDraft(payload: DraftPayload, context: DraftContext): ContentDraft {
  const guide: GuideSection[] = payload.guide.map((section) => ({
    heading: section.heading,
    body: section.body,
    imageSuggestions: (section.imageSuggestions ?? []).map((suggestion) => ({
      description: suggestion.description,
    })),
  }));

  return {
    topicId: context.topic.id,
    facebookPost: payload.facebookPost,
    guide,
    videoScript: payload.videoScript,
    originLinks: payload.originLinks,
    language: context.language,
    ...(context.brandVoiceVersion === undefined
      ? {}
      : { brandVoiceVersion: context.brandVoiceVersion }),
  };
}

export function renderTopic(topic: Topic): string {
  return [
    `Chủ đề: ${topic.title}`,
    `Nguồn: ${topic.sourceRef.url}`,
    topic.categories.length > 0 ? `Phân loại: ${topic.categories.join(", ")}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function renderResearch(research: ResearchResult): string {
  if (research.items.length === 0) return "Research: (không có dữ liệu)";
  const lines = research.items.map((item, index) => {
    const sources = item.evidenceRefs.map((ref) => ref.url).join(", ");
    return [
      `[${index + 1}] (${item.kind}) ${item.content}`,
      sources.length > 0 ? `    Nguồn: ${sources}` : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  });
  return ["Research:", ...lines].join("\n");
}
