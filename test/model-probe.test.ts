import { describe, expect, it } from "vitest";

import { AnthropicModelAClient } from "../src/adapters/anthropic-model-client.js";
import { GeminiModelBClient, type GeminiLike } from "../src/adapters/gemini-model-client.js";
import {
  DOCTOR_CLAIMS,
  DOCTOR_RESEARCH,
  DOCTOR_REVISION,
  DOCTOR_TOPIC,
  diagnoseModelA,
  diagnoseModelB,
} from "../src/app/model-probe.js";

const DEADLINE_MS = 5_000;

/**
 * The probe is only worth running if its fixtures survive the real adapters. A malformed
 * topic or research result would make a healthy provider look broken, which is precisely
 * the wrong answer to send an operator chasing.
 */
type AnthropicSeam = NonNullable<
  NonNullable<ConstructorParameters<typeof AnthropicModelAClient>[0]>["client"]
>;

function anthropicStub(reply: unknown): AnthropicSeam {
  return { messages: { create: async () => reply } } as unknown as AnthropicSeam;
}

function anthropicThrowing(error: Error): AnthropicSeam {
  return {
    messages: {
      create: async () => {
        throw error;
      },
    },
  } as unknown as AnthropicSeam;
}

const validDraft = {
  topicId: DOCTOR_TOPIC.id,
  facebookPost: "FB_AI kiểm chứng nội dung bằng hai model khác nhà cung cấp.",
  guide: [
    {
      heading: "Tổng quan",
      body: "Không tự động đăng bài ở Phase 1.",
      imageSuggestions: [{ description: "Sơ đồ duyệt bài" }],
    },
  ],
  videoScript: { intro: "Mở đầu.", body: "Nội dung.", conclusion: "Kết luận." },
  originLinks: [DOCTOR_RESEARCH.items[0]!.evidenceRefs[0]!.url],
  language: "vi",
};

describe("diagnoseModelA", () => {
  it("passes fixtures the real Anthropic adapter accepts", async () => {
    const client = new AnthropicModelAClient({
      model: "claude-opus-5",
      client: anthropicStub({
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(validDraft) }],
      }),
    });

    const result = await diagnoseModelA(client, "claude-opus-5", DEADLINE_MS);

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/viết được bài \d+ từ/);
    expect(result.label).toBe("Model A (Claude)");
  });

  it("surfaces the provider's own message instead of throwing", async () => {
    const client = new AnthropicModelAClient({
      client: anthropicThrowing(new Error("401 authentication_error: invalid x-api-key")),
    });

    const result = await diagnoseModelA(client, "claude-opus-5", DEADLINE_MS);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("invalid x-api-key");
  });

  it("reports a refusal rather than parsing a partial answer", async () => {
    const client = new AnthropicModelAClient({
      client: anthropicStub({ stop_reason: "max_tokens", content: [{ type: "text", text: "{" }] }),
    });

    const result = await diagnoseModelA(client, "claude-opus-5", DEADLINE_MS);
    expect(result.ok).toBe(false);
    expect(result.detail).not.toHaveLength(0);
  });
});

describe("diagnoseModelB", () => {
  function gemini(text: string | undefined): GeminiLike {
    return { models: { generateContent: async () => ({ text }) } };
  }

  it("passes fixtures the real Gemini adapter accepts", async () => {
    const client = new GeminiModelBClient({
      model: "gemini-2.5-pro",
      client: gemini(
        JSON.stringify({
          findings: DOCTOR_CLAIMS.map(({ id }) => ({
            claimId: id,
            verdict: "Pass",
            evidence: [1],
          })),
        }),
      ),
    });

    const result = await diagnoseModelB(client, "gemini-2.5-pro", DEADLINE_MS);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("Pass");
  });

  it("downgrades a Pass whose evidence points nowhere", async () => {
    // The adapter requires every supported claim to point at a real capture. A probe that
    // ignored this would call a healthy Model B broken the moment it cited nothing.
    const client = new GeminiModelBClient({
      client: gemini(
        JSON.stringify({
          findings: DOCTOR_CLAIMS.map(({ id }) => ({ claimId: id, verdict: "Pass", evidence: [] })),
        }),
      ),
    });

    const result = await diagnoseModelB(client, "gemini-2.5-pro", DEADLINE_MS);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("Unsupported");
  });

  it("says so when the model answers with nothing", async () => {
    const client = new GeminiModelBClient({ client: gemini(undefined) });
    const result = await diagnoseModelB(client, "gemini-2.5-pro", DEADLINE_MS);

    expect(result.ok).toBe(false);
    expect(result.detail).not.toHaveLength(0);
  });

  it("surfaces the provider's own message", async () => {
    const client = new GeminiModelBClient({
      client: {
        models: {
          generateContent: async () => {
            throw new Error("404 models/gemini-9 is not found for API version v1beta");
          },
        },
      },
    });

    const result = await diagnoseModelB(client, "gemini-9", DEADLINE_MS);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("is not found");
  });
});

describe("probe fixtures", () => {
  it("describe one claim that the research plainly supports", () => {
    // A claim the research does not support would make a working Model B return
    // Contradiction, and the probe would read as a failure of the provider.
    expect(DOCTOR_RESEARCH.status).toBe("Ok");
    expect(DOCTOR_RESEARCH.items).toHaveLength(1);
    expect(DOCTOR_CLAIMS).toHaveLength(1);
    expect(DOCTOR_RESEARCH.items[0]!.content).toContain("không tự động đăng bài");
    expect(DOCTOR_CLAIMS[0]!.text).toContain("không tự động đăng bài");
  });

  it("point every claim at the revision being judged", () => {
    for (const claim of DOCTOR_CLAIMS) {
      expect(claim.draftRevisionId).toBe(DOCTOR_REVISION.id);
    }
  });
});
