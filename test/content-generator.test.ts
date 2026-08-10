import { describe, expect, it, vi } from "vitest";

import type {
  ModelAGenerationPort,
  ModelAGenerationRequest,
  ModelAGenerationResponse,
  ModelCallControl,
} from "../src/adapters/ports.js";
import type {
  ContentDraft,
  ResearchResult,
  Topic,
} from "../src/domain/content.js";
import {
  ContentGenerationInputError,
  ContentGenerator,
  ModelFormatGenerationError,
  hashGenerationValue,
} from "../src/pipeline/content-generator.js";

const NOW = new Date("2025-04-10T10:00:00.000Z");
const metadata = {
  provider: "provider-a",
  model: "model-a",
  promptVersion: "prompt-v2",
  configurationVersion: "config-v3",
} as const;

const topic: Topic = {
  id: "topic-1",
  externalId: "external-1",
  title: "Cập nhật công cụ AI",
  createdAt: NOW.toISOString(),
  score: { total: 92, breakdown: [], scoringConfigVersion: "score-v1" },
  categories: ["AI Tools"],
  sourceRef: {
    sourceId: "source-1",
    captureId: "capture-1",
    url: "https://example.test/origin",
    capturedAt: NOW.toISOString(),
    termsVersion: "terms-v1",
  },
};
const research: ResearchResult = {
  id: "research-1",
  topicId: topic.id,
  items: [{
    id: "item-1",
    content: "Thông tin có nguồn về công cụ AI.",
    kind: "Summarized",
    evidenceRefs: [topic.sourceRef],
  }],
  status: "Ok",
  unreachableSources: [],
};

const validContent: ContentDraft = {
  topicId: topic.id,
  facebookPost:
    "Đây là bài viết Facebook bằng tiếng Việt có đủ độ dài và dựa trên nguồn gốc rõ ràng.",
  guide: [1, 2, 3].map((number) => ({
    heading: `Phần ${number}`,
    body: `Nội dung hướng dẫn chi tiết cho phần ${number}.`,
    imageSuggestions: [{
      description: `Minh họa trực quan cho phần hướng dẫn số ${number}`,
    }],
  })),
  videoScript: {
    intro: "Mở đầu giới thiệu chủ đề.",
    body: "Nội dung chính giải thích thông tin từ nguồn.",
    conclusion: "Kết luận và lời kêu gọi tìm hiểu thêm.",
  },
  originLinks: [topic.sourceRef.url],
  language: "en",
};

function model(
  handler: (
    request: ModelAGenerationRequest,
    control: ModelCallControl,
  ) => ModelAGenerationResponse | Promise<ModelAGenerationResponse>,
): ModelAGenerationPort {
  return {
    generate: vi.fn(async (request, control) =>
      await handler(request, control)),
  };
}

function generator(modelA: ModelAGenerationPort): ContentGenerator {
  return new ContentGenerator(modelA, {
    now: () => NOW,
    createId: (kind) => kind === "draft" ? "draft-1" : "revision-1",
  });
}

describe("ContentGenerator", () => {
  it("creates an immutable multi-format revision with default language and reproducibility metadata", async () => {
    const modelA = model((request) => ({
      content: validContent,
      provenance: metadata,
    }));
    const result = await generator(modelA).generate({
      topic,
      research,
      requestedModel: metadata,
      brandVoiceVersion: "friendly-v4",
    });

    expect(result.kind).toBe("Generated");
    if (result.kind !== "Generated") return;
    expect(result.revision).toMatchObject({
      id: "revision-1",
      draftId: "draft-1",
      revision: 1,
      createdBy: "System",
      createdAt: NOW.toISOString(),
      content: {
        topicId: topic.id,
        language: "vi",
        brandVoiceVersion: "friendly-v4",
      },
    });
    expect(result.metadata).toEqual({
      modelA: metadata,
      researchResultId: research.id,
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      contentHash: result.revision.contentHash,
      language: "vi",
      brandVoiceVersion: "friendly-v4",
    });
    expect(result.revision.contentHash).toBe(
      hashGenerationValue(result.revision.content),
    );
    expect(Object.isFrozen(result.revision)).toBe(true);
    expect(Object.isFrozen(result.revision.content.guide)).toBe(true);
    expect(Object.isFrozen(
      result.revision.content.guide[0]?.imageSuggestions,
    )).toBe(true);

    const generate = modelA.generate as ReturnType<typeof vi.fn>;
    expect(generate).toHaveBeenCalledOnce();
    const [request, control] = generate.mock.calls[0] as [
      ModelAGenerationRequest,
      ModelCallControl,
    ];
    expect(request).toMatchObject({
      topic,
      research,
      language: "vi",
      brandVoiceVersion: "friendly-v4",
      requestedModel: metadata,
      inputHash: result.metadata.inputHash,
    });
    expect(control.deadlineAt).toBe("2025-04-10T10:01:00.000Z");
    expect(control.signal).toBeInstanceOf(AbortSignal);
  });

  it("retains invalid output diagnostically and reports exactly its failing components", async () => {
    const invalid: ContentDraft = {
      ...validContent,
      facebookPost: "quá ngắn",
      guide: [
        {
          heading: "Một phần",
          body: "Nội dung",
          imageSuggestions: [{ description: "ngắn" }],
        },
      ],
      language: "vi",
    };
    const result = await generator(model(() => ({
      content: invalid,
      provenance: metadata,
    }))).generate({ topic, research, requestedModel: metadata });

    expect(result.kind).toBe("Failed");
    if (result.kind !== "Failed") return;
    expect(result.failureKind).toBe("Validation");
    expect(result.failingFormats).toEqual(["FacebookPost", "Guide"]);
    expect(result.errors.map(({ path }) => path)).toEqual([
      "facebookPost",
      "guide",
      "guide[0].imageSuggestions[0].description",
    ]);
    expect(result.partialContent).toEqual(invalid);
    expect(Object.isFrozen(result.partialContent)).toBe(true);
    expect("revision" in result).toBe(false);
    expect(result.metadata.contentHash).toBe(
      hashGenerationValue(result.partialContent),
    );
  });
  it("preserves exact adapter-reported format failures without creating a revision", async () => {
    const partial = { ...validContent, guide: [] };
    const result = await generator(model(() => {
      throw new ModelFormatGenerationError(
        "Guide generation failed",
        ["Guide"],
        partial,
      );
    })).generate({ topic, research, requestedModel: metadata });

    expect(result).toMatchObject({
      kind: "Failed",
      failureKind: "ModelError",
      failingFormats: ["Guide"],
      errors: [{
        format: "Guide",
        path: "guide",
        message: "Guide generation failed",
      }],
      partialContent: { language: "vi" },
      metadata: {
        researchResultId: research.id,
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect("revision" in result).toBe(false);
  });

  it("honors caller cancellation and generation deadlines", async () => {
    const generate = vi.fn(() => new Promise<ModelAGenerationResponse>(() => undefined));
    const modelA: ModelAGenerationPort = { generate };
    const cancelled = new AbortController();
    cancelled.abort(new Error("operator cancelled"));

    await expect(generator(modelA).generate({
      topic,
      research,
      requestedModel: metadata,
      signal: cancelled.signal,
    })).resolves.toMatchObject({
      kind: "Failed",
      failureKind: "Cancelled",
      failingFormats: ["FacebookPost", "Guide", "VideoScript"],
    });
    expect(generate).not.toHaveBeenCalled();

    const deadlineResult = await generator(modelA).generate({
      topic,
      research,
      requestedModel: metadata,
      deadlineMs: 5,
    });
    expect(deadlineResult).toMatchObject({
      kind: "Failed",
      failureKind: "DeadlineExceeded",
      failingFormats: ["FacebookPost", "Guide", "VideoScript"],
    });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("rejects insufficient or mismatched research before calling Model A", async () => {
    const modelA = model(() => ({ content: validContent, provenance: metadata }));
    await expect(generator(modelA).generate({
      topic,
      research: { ...research, status: "InsufficientData" },
      requestedModel: metadata,
    })).rejects.toBeInstanceOf(ContentGenerationInputError);
    expect(modelA.generate).not.toHaveBeenCalled();
  });
});
