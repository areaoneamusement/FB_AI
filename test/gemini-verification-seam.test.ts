import { describe, expect, it } from "vitest";

import { GeminiModelBClient, type GeminiLike } from "../src/adapters/gemini-model-client.js";
import { hashGenerationValue } from "../src/pipeline/content-generator.js";
import { VerificationEngine, extractClaims } from "../src/pipeline/verification-engine.js";
import type { ContentDraft, DraftRevision, ResearchResult } from "../src/domain/content.js";

/**
 * The seam where two halves of this codebase disagreed.
 *
 * `GeminiModelBClient` downgraded any verdict it could not trace to `Unsupported` and blanked
 * its `evidenceRefs`. `VerificationEngine` rejects a finding that cites nothing — correctly,
 * since design.md requires "Contradiction/unsupported findings include evidence and
 * explanation". So `Unsupported` was undeliverable: the engine raised
 * `InvalidModelResponse`, retried three times, and reported `RetryableBlocked`, which reads
 * as a broken provider. Neither component was testable into revealing this alone.
 */
const NOW = new Date("2026-08-19T00:00:00.000Z");

const sourceRef = {
  sourceId: "source-1",
  captureId: "capture-1",
  url: "https://example.test/source",
  capturedAt: NOW.toISOString(),
  termsVersion: "terms-v1",
} as const;

const content: ContentDraft = {
  topicId: "topic-1",
  facebookPost: "Công cụ hỗ trợ tiếng Việt. Phiên bản mới chạy nhanh hơn!",
  guide: [1, 2, 3].map((number) => ({
    heading: `Phần ${number}`,
    body: `Bước ${number} dùng dữ liệu từ nguồn.`,
    imageSuggestions: [{ description: `Minh họa chi tiết cho phần ${number}` }],
  })),
  videoScript: {
    intro: "Video giới thiệu công cụ.",
    body: "Nội dung giải thích tính năng.",
    conclusion: "Hãy kiểm tra nguồn để biết thêm.",
  },
  originLinks: [sourceRef.url],
  language: "vi",
};

const revision: DraftRevision = {
  id: "revision-1",
  draftId: "draft-1",
  revision: 1,
  content,
  contentHash: hashGenerationValue(content),
  createdBy: "System",
  createdAt: NOW.toISOString(),
};

const research: ResearchResult = {
  id: "research-1",
  topicId: content.topicId,
  status: "Ok",
  unreachableSources: [],
  skippedSources: [],
  items: [
    {
      id: "research-item-1",
      content: "Nguồn xác nhận các phát biểu trong bản nháp.",
      kind: "Summarized",
      evidenceRefs: [sourceRef],
    },
  ],
};

const modelMetadata = {
  provider: "google",
  model: "gemini-3.1-flash-lite",
  promptVersion: "p",
  configurationVersion: "c",
} as const;

/** Answers every claim in the revision the way `reply` describes. */
function geminiAnswering(
  reply: (claimId: string) => Record<string, unknown>,
): GeminiLike {
  const claimIds = extractClaims(revision).map(({ id }) => id);
  return {
    models: {
      generateContent: async () => ({
        text: JSON.stringify({ findings: claimIds.map(reply) }),
      }),
    },
  };
}

async function verifyWith(client: GeminiLike) {
  // Real clock on purpose: the adapter derives its abort deadline from wall time, so a
  // frozen clock in the past makes every call fail before it is made.
  return await new VerificationEngine(
    new GeminiModelBClient({ client, model: modelMetadata.model }),
  ).verify({ revision, research, requestedModel: modelMetadata, maxRounds: 1, maxAttempts: 1 });
}

describe("Gemini findings against the real VerificationEngine", () => {
  it("accepts a Pass the model grounded in research", async () => {
    const result = await verifyWith(
      geminiAnswering((claimId) => ({ claimId, verdict: "Pass", evidence: [1] })),
    );

    expect(result.kind).toBe("Passed");
  });

  it("delivers Unsupported as a verdict rather than a model failure", async () => {
    // The live symptom: `ModelB InvalidModelResponse: Finding claim-... must cite research
    // evidence`, three times per topic, on a model that was answering correctly.
    const result = await verifyWith(
      geminiAnswering((claimId) => ({
        claimId,
        verdict: "Unsupported",
        evidence: [],
        description: "Research không nhắc tới điều này",
      })),
    );

    expect(result.kind).toBe("VerificationBlocked");
    if (result.kind !== "VerificationBlocked") return;
    expect(result.report.findings.every(({ verdict }) => verdict === "Unsupported")).toBe(true);
    expect(result.report.findings.every(({ evidenceRefs }) => evidenceRefs.length > 0)).toBe(true);
  });

  it("delivers a Pass the model could not ground, downgraded rather than rejected", async () => {
    const result = await verifyWith(
      geminiAnswering((claimId) => ({ claimId, verdict: "Pass", evidence: [] })),
    );

    expect(result.kind).toBe("VerificationBlocked");
    if (result.kind !== "VerificationBlocked") return;
    expect(result.report.findings.every(({ verdict }) => verdict === "Unsupported")).toBe(true);
  });

  it("delivers a finding the model answered with nothing but a claim id", async () => {
    // A weaker model returns sparser objects; that is a verdict of Unsupported, not a fault.
    const result = await verifyWith(geminiAnswering((claimId) => ({ claimId })));

    expect(result.kind).toBe("VerificationBlocked");
  });

  it("still reports a genuinely unusable answer as a model failure", async () => {
    // An empty findings array covers no claim at all. Filling those in with an invented
    // Unsupported would make a model that stopped answering look like one that judged
    // every claim — and would quietly defeat the engine's coverage guarantee.
    const result = await verifyWith({
      models: { generateContent: async () => ({ text: JSON.stringify({ findings: [] }) }) },
    });

    expect(result.kind).toBe("RetryableBlocked");
    if (result.kind !== "RetryableBlocked") return;
    expect(result.error.reason).toContain("không trả phán quyết");
  });

  it("reports partial coverage as a failure too", async () => {
    // Judging thirteen of fourteen claims is not a verdict on the draft.
    const claimIds = extractClaims(revision).map(({ id }) => id);
    const result = await verifyWith({
      models: {
        generateContent: async () => ({
          text: JSON.stringify({
            findings: claimIds.slice(1).map((claimId) => ({ claimId, verdict: "Pass", evidence: [1] })),
          }),
        }),
      },
    });

    expect(result.kind).toBe("RetryableBlocked");
  });
});
