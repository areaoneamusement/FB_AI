import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  AnthropicModelAClient,
  ModelResponseError,
  parseDraftPayload,
  renderResearch,
  withDeadline,
} from "../src/adapters/anthropic-model-client.js";
import {
  DEFAULT_MODEL_B,
  GeminiModelBClient,
  buildEvidenceIndex,
  parseFindings,
} from "../src/adapters/gemini-model-client.js";
import type { GeminiLike } from "../src/adapters/gemini-model-client.js";
import type { ModelCallControl } from "../src/adapters/ports.js";
import type {
  Claim,
  ReproducibilityMetadata,
  ResearchResult,
  Topic,
} from "../src/domain/content.js";
import { rankCandidates } from "../src/app/gemini-model-search.js";
import type { SourceReference } from "../src/domain/source.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");

const sourceRef: SourceReference = {
  sourceId: "github-llm",
  captureId: "capture-1",
  url: "https://github.com/acme/agent",
  capturedAt: NOW.toISOString(),
  termsVersion: "terms-v1",
};

const secondRef: SourceReference = { ...sourceRef, captureId: "capture-2" };

const topic: Topic = {
  id: "topic-1",
  sourceRef,
  externalId: "1",
  title: "acme/agent",
  createdAt: NOW.toISOString(),
  score: { total: 80, breakdown: [], scoringConfigVersion: "score-v1" },
  categories: ["AI Tools"],
};

const research: ResearchResult = {
  id: "research-1",
  topicId: "topic-1",
  items: [
    {
      id: "item-1",
      content: "Bản phát hành mới hỗ trợ chạy cục bộ.",
      kind: "Summarized",
      evidenceRefs: [sourceRef],
    },
    {
      id: "item-2",
      content: "Dự án có 1.200 sao trên GitHub.",
      kind: "Summarized",
      evidenceRefs: [secondRef],
    },
  ],
  status: "Ok",
  unreachableSources: [],
  skippedSources: [],
};

const requestedModel: ReproducibilityMetadata = {
  provider: "anthropic",
  model: "claude-opus-5",
  promptVersion: "prompt-v1",
  configurationVersion: "config-v1",
};

function control(offsetMs = 60_000): ModelCallControl {
  return {
    signal: new AbortController().signal,
    deadlineAt: new Date(Date.now() + offsetMs).toISOString(),
  };
}

const draftJson = JSON.stringify({
  facebookPost: "Bài đăng thử nghiệm.",
  guide: [
    { heading: "Tổng quan", body: "Nội dung.", imageSuggestions: [{ description: "Ảnh minh hoạ" }] },
  ],
  videoScript: { intro: "Mở đầu", body: "Thân bài", conclusion: "Kết" },
  originLinks: ["https://github.com/acme/agent"],
});

function anthropicStub(
  response: Partial<Anthropic.Message> & { content: Anthropic.Message["content"] },
): { client: Pick<Anthropic, "messages">; prompts: string[] } {
  const prompts: string[] = [];
  const client = {
    messages: {
      create: async (params: { messages: { content: string }[] }) => {
        prompts.push(params.messages[0]!.content);
        return { stop_reason: "end_turn", ...response };
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
  return { client, prompts };
}

function textBlocks(text: string): Anthropic.Message["content"] {
  return [{ type: "text", text, citations: null }] as unknown as Anthropic.Message["content"];
}

describe("withDeadline", () => {
  it("rejects a deadline that has already passed", () => {
    expect(() => withDeadline(control(-1_000))).toThrow(ModelResponseError);
  });

  it("rejects a malformed deadline", () => {
    expect(() =>
      withDeadline({ signal: new AbortController().signal, deadlineAt: "not-a-date" }),
    ).toThrow(ModelResponseError);
  });

  it("aborts when the caller's signal aborts", () => {
    const controller = new AbortController();
    const signal = withDeadline({
      signal: controller.signal,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("parseDraftPayload", () => {
  it("reads a well-formed draft", () => {
    const payload = parseDraftPayload(draftJson);
    expect(payload.facebookPost).toBe("Bài đăng thử nghiệm.");
    expect(payload.guide).toHaveLength(1);
    expect(payload.originLinks).toEqual(["https://github.com/acme/agent"]);
  });

  it("rejects text that is not JSON", () => {
    expect(() => parseDraftPayload("Xin chào")).toThrow(ModelResponseError);
  });

  it("rejects JSON missing the required fields", () => {
    expect(() => parseDraftPayload(JSON.stringify({ facebookPost: "x" }))).toThrow(
      ModelResponseError,
    );
  });
});

describe("renderResearch", () => {
  it("numbers items and lists their source URLs", () => {
    const rendered = renderResearch(research);
    expect(rendered).toContain("[1]");
    expect(rendered).toContain("[2]");
    expect(rendered).toContain("https://github.com/acme/agent");
  });

  it("says so when there is nothing to work from", () => {
    expect(renderResearch({ ...research, items: [] })).toContain("không có dữ liệu");
  });
});

describe("AnthropicModelAClient", () => {
  it("returns a draft bound to the requested topic and language", async () => {
    const { client, prompts } = anthropicStub({ content: textBlocks(draftJson) });
    const modelA = new AnthropicModelAClient({ client, model: "claude-opus-5" });

    const result = await modelA.generate(
      { topic, research, inputHash: "hash-1", requestedModel, language: "vi" },
      control(),
    );

    expect(result.content.topicId).toBe("topic-1");
    expect(result.content.language).toBe("vi");
    expect(result.content.guide[0]?.imageSuggestions[0]?.description).toBe("Ảnh minh hoạ");
    expect(result.provenance).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
      promptVersion: "model-a-generate-v1",
      configurationVersion: "config-v1",
    });
    // The research must reach the model, or it has nothing to ground claims in.
    expect(prompts[0]).toContain("Bản phát hành mới hỗ trợ chạy cục bộ.");
  });

  it("surfaces a refusal instead of returning an empty draft", async () => {
    const { client } = anthropicStub({ content: textBlocks(""), stop_reason: "refusal" });
    const modelA = new AnthropicModelAClient({ client });
    await expect(
      modelA.generate(
        { topic, research, inputHash: "hash-1", requestedModel, language: "vi" },
        control(),
      ),
    ).rejects.toThrow(/refusal/i);
  });

  it("surfaces a truncated response rather than parsing half a draft", async () => {
    const { client } = anthropicStub({
      content: textBlocks(draftJson.slice(0, 20)),
      stop_reason: "max_tokens",
    });
    const modelA = new AnthropicModelAClient({ client });
    await expect(
      modelA.generate(
        { topic, research, inputHash: "hash-1", requestedModel, language: "vi" },
        control(),
      ),
    ).rejects.toThrow(/max_tokens/);
  });
});

describe("parseFindings", () => {
  const claims: readonly Claim[] = [
    {
      id: "claim-1",
      draftRevisionId: "rev-1",
      format: "FacebookPost",
      path: "facebookPost",
      startOffset: 0,
      endOffset: 10,
      text: "Hỗ trợ chạy cục bộ",
    },
    {
      id: "claim-2",
      draftRevisionId: "rev-1",
      format: "FacebookPost",
      path: "facebookPost",
      startOffset: 10,
      endOffset: 20,
      text: "Có 5.000 sao",
    },
  ];
  const evidenceIndex = buildEvidenceIndex(research);

  it("maps evidence indices back to real source references", () => {
    const findings = parseFindings(
      JSON.stringify({
        findings: [
          { claimId: "claim-1", verdict: "Pass", evidence: [1], description: "ok", confidence: 0.9 },
          {
            claimId: "claim-2",
            verdict: "Contradiction",
            evidence: [2],
            description: "research nói 1.200",
            confidence: 0.8,
          },
        ],
      }),
      claims,
      evidenceIndex,
    );

    expect(findings).toHaveLength(2);
    expect(findings[0]!.verdict).toBe("Pass");
    expect(findings[0]!.evidenceRefs).toEqual([sourceRef]);
    expect(findings[1]!.verdict).toBe("Contradiction");
    expect(findings[1]!.evidenceRefs).toEqual([secondRef]);
  });

  /** Judges one claim, so a case about verdicts is not also a case about coverage. */
  const oneClaim = claims.slice(0, 1);

  it("rejects an answer that skips a claim instead of inventing a verdict for it", () => {
    // Filling the gap with Unsupported would make a model that stopped answering look like
    // one that judged every claim, and would defeat the engine's coverage guarantee.
    expect(() =>
      parseFindings(
        JSON.stringify({ findings: [{ claimId: "claim-1", verdict: "Pass", evidence: [1] }] }),
        claims,
        evidenceIndex,
      ),
    ).toThrow(/1\/2 claim/);
  });

  it("downgrades a Pass that cites no traceable evidence, and still cites the corpus", () => {
    // This used to return no evidence at all, which VerificationEngine rejects — rightly:
    // design.md requires "Contradiction/unsupported findings include evidence and
    // explanation". The result was that Unsupported could not be delivered: every cycle
    // failed three attempts deep as InvalidModelResponse, blamed on the model.
    const findings = parseFindings(
      JSON.stringify({ findings: [{ claimId: "claim-1", verdict: "Pass", evidence: [] }] }),
      oneClaim,
      evidenceIndex,
    );
    expect(findings[0]!.verdict).toBe("Unsupported");
    expect(findings[0]!.evidenceRefs.length).toBeGreaterThan(0);
    expect(findings[0]!.description).not.toHaveLength(0);
  });

  it("gives every finding evidence and a reason the engine will accept", () => {
    // Whatever the model answers, the finding has to be deliverable.
    for (const raw of [
      { claimId: "claim-1", verdict: "Pass", evidence: [] },
      { claimId: "claim-1", verdict: "Unsupported", evidence: [] },
      { claimId: "claim-1", verdict: "Contradiction", evidence: [] },
      { claimId: "claim-1", verdict: "nonsense", evidence: [99] },
    ]) {
      const finding = parseFindings(
        JSON.stringify({ findings: [raw] }),
        oneClaim,
        evidenceIndex,
      )[0]!;
      expect(finding.evidenceRefs.length).toBeGreaterThan(0);
      if (finding.verdict !== "Pass") expect(finding.description ?? "").not.toHaveLength(0);
    }
  });

  it("keeps the model's own explanation when it gave one", () => {
    const findings = parseFindings(
      JSON.stringify({
        findings: [
          { claimId: "claim-1", verdict: "Unsupported", evidence: [], description: "Research không nhắc tới con số này" },
        ],
      }),
      oneClaim,
      evidenceIndex,
    );
    expect(findings[0]!.description).toBe("Research không nhắc tới con số này");
  });

  it("ignores evidence indices that do not exist", () => {
    const findings = parseFindings(
      JSON.stringify({ findings: [{ claimId: "claim-1", verdict: "Pass", evidence: [99] }] }),
      oneClaim,
      evidenceIndex,
    );
    expect(findings[0]!.verdict).toBe("Unsupported");
  });

  it("clamps confidence into [0, 1]", () => {
    const findings = parseFindings(
      JSON.stringify({
        findings: [{ claimId: "claim-1", verdict: "Pass", evidence: [1], confidence: 7 }],
      }),
      oneClaim,
      evidenceIndex,
    );
    expect(findings[0]!.confidence).toBe(1);
  });

  it("rejects a response that is not JSON", () => {
    expect(() => parseFindings("nope", claims, evidenceIndex)).toThrow(ModelResponseError);
  });
});

describe("GeminiModelBClient", () => {
  it("sends the claims and research, and reports its own provenance", async () => {
    let seenPrompt = "";
    const client: GeminiLike = {
      models: {
        generateContent: async (params) => {
          seenPrompt = params.contents;
          return {
            text: JSON.stringify({
              findings: [{ claimId: "claim-1", verdict: "Pass", evidence: [1] }],
            }),
          };
        },
      },
    };

    const modelB = new GeminiModelBClient({ client, model: "gemini-2.5-pro" });
    const result = await modelB.critique(
      {
        revision: {
          id: "rev-1",
          draftId: "draft-1",
          revision: 1,
          content: {
            topicId: "topic-1",
            facebookPost: "x",
            guide: [],
            videoScript: { intro: "", body: "", conclusion: "" },
            originLinks: [],
            language: "vi",
          },
          contentHash: "hash",
          createdBy: "System",
          createdAt: NOW.toISOString(),
        },
        claims: [
          {
            id: "claim-1",
            draftRevisionId: "rev-1",
            format: "FacebookPost",
            path: "facebookPost",
            startOffset: 0,
            endOffset: 1,
            text: "Hỗ trợ chạy cục bộ",
          },
        ],
        research,
        round: 1,
        requestedModel: { ...requestedModel, provider: "google", model: "gemini-2.5-pro" },
      },
      control(),
    );

    expect(seenPrompt).toContain("Hỗ trợ chạy cục bộ");
    expect(seenPrompt).toContain("[1]");
    expect(result.findings[0]!.verdict).toBe("Pass");
    expect(result.provenance.provider).toBe("google");
    expect(result.provenance.promptVersion).toBe("model-b-critique-v1");
  });

  it("surfaces an empty response instead of silently passing every claim", async () => {
    const client: GeminiLike = { models: { generateContent: async () => ({ text: "" }) } };
    const modelB = new GeminiModelBClient({ client });
    await expect(
      modelB.critique(
        {
          revision: {
            id: "rev-1",
            draftId: "draft-1",
            revision: 1,
            content: {
              topicId: "topic-1",
              facebookPost: "x",
              guide: [],
              videoScript: { intro: "", body: "", conclusion: "" },
              originLinks: [],
              language: "vi",
            },
            contentHash: "hash",
            createdBy: "System",
            createdAt: NOW.toISOString(),
          },
          claims: [],
          research,
          round: 1,
          requestedModel,
        },
        control(),
      ),
    ).rejects.toThrow(/rỗng/);
  });
});

describe("DEFAULT_MODEL_B", () => {
  it("is not one of the names that already failed against a live key", () => {
    // `gemini-2.5-pro` answered 404 (retired for new accounts); the replacement Google
    // named in that message answered 429 `limit: 0` (free tier not entitled). Both blocked
    // every cycle, three attempts at a time.
    expect(DEFAULT_MODEL_B).not.toBe("gemini-2.5-pro");
    expect(DEFAULT_MODEL_B).not.toBe("gemini-3.1-pro-preview");
    expect(DEFAULT_MODEL_B).not.toHaveLength(0);
  });

  it("is what the doctor's own ranking would pick first", () => {
    // The second bad default was a pro-tier preview — the two properties rankCandidates
    // pushes to the back. Holding the default to that ordering stops the shipped choice
    // and the recovery logic from contradicting each other again.
    const ranked = rankCandidates([
      { name: "gemini-3.1-pro" },
      { name: "gemini-3.1-pro-preview" },
      { name: "gemini-2.5-flash" },
      { name: DEFAULT_MODEL_B },
    ]);
    expect(ranked[0]?.name).toBe(DEFAULT_MODEL_B);
  });
});
