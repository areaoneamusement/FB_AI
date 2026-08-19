import { describe, expect, it, vi } from "vitest";

import type {
  ModelBCritiquePort,
  ModelBCritiqueRequest,
  ModelBCritiqueResponse,
  ModelCallControl,
} from "../src/adapters/ports.js";
import type {
  ContentDraft,
  DraftRevision,
  ResearchResult,
  VerificationFinding,
} from "../src/domain/content.js";
import { hashGenerationValue } from "../src/pipeline/content-generator.js";
import {
  VerificationEngine,
  VerificationInputError,
  extractClaims,
  type ModelACorrectionPort,
  type VerificationOperations,
} from "../src/pipeline/verification-engine.js";

const NOW = new Date("2025-05-01T10:00:00.000Z");
const sourceRef = {
  sourceId: "source-1",
  captureId: "capture-1",
  url: "https://example.test/source",
  capturedAt: "2025-05-01T09:00:00.000Z",
  termsVersion: "terms-v1",
} as const;
const modelBMetadata = {
  provider: "provider-b",
  model: "critic-b",
  promptVersion: "verify-v2",
  configurationVersion: "config-v4",
} as const;
const modelAMetadata = {
  provider: "provider-a",
  model: "corrector-a",
  promptVersion: "correct-v1",
  configurationVersion: "config-v2",
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
  items: [{
    id: "research-item-1",
    content: "Nguồn xác nhận các phát biểu trong bản nháp.",
    kind: "Summarized",
    evidenceRefs: [sourceRef],
  }],
};

function modelB(
  handler: (
    request: ModelBCritiqueRequest,
    control: ModelCallControl,
  ) => ModelBCritiqueResponse | Promise<ModelBCritiqueResponse>,
): ModelBCritiquePort {
  return {
    critique: vi.fn(async (request, control) => await handler(request, control)),
  };
}

function operations(): VerificationOperations & {
  recordError: ReturnType<typeof vi.fn>;
  notifyOperator: ReturnType<typeof vi.fn>;
} {
  return {
    recordError: vi.fn(async () => undefined),
    notifyOperator: vi.fn(async () => undefined),
  };
}

function idFactory() {
  const counts = new Map<string, number>();
  return (kind: "draft-revision" | "verification-report" | "verification-error") => {
    const count = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, count);
    return `${kind}-${count}`;
  };
}

function engine(
  critic: ModelBCritiquePort,
  options: {
    readonly modelA?: ModelACorrectionPort;
    readonly operations?: VerificationOperations;
  } = {},
): VerificationEngine {
  return new VerificationEngine(critic, options.operations, {
    modelA: options.modelA,
    now: () => NOW,
    createId: idFactory(),
  });
}

function passFindings(request: ModelBCritiqueRequest): readonly VerificationFinding[] {
  return request.claims.map(({ id }) => ({
    claimId: id,
    verdict: "Pass",
    evidenceRefs: [sourceRef],
  }));
}

function response(
  request: ModelBCritiqueRequest,
  findings: readonly VerificationFinding[] = passFindings(request),
): ModelBCritiqueResponse {
  return { provenance: modelBMetadata, findings };
}

describe("extractClaims", () => {
  it("deterministically decomposes FacebookPost, Guide, and VideoScript prose", () => {
    const first = extractClaims(revision);
    const second = extractClaims(structuredClone(revision));

    expect(second).toEqual(first);
    expect(first.map(({ format }) => format)).toEqual([
      "FacebookPost", "FacebookPost",
      "Guide", "Guide",
      "Guide", "Guide",
      "Guide", "Guide",
      "VideoScript", "VideoScript", "VideoScript",
    ]);
    // Image suggestions are art direction, not assertions a reader can be misled by, so
    // there is nothing in them for research to support (CR-0003).
    expect(first.map(({ path }) => path)).toEqual([
      "facebookPost", "facebookPost",
      "guide[0].heading", "guide[0].body",
      "guide[1].heading", "guide[1].body",
      "guide[2].heading", "guide[2].body",
      "videoScript.intro", "videoScript.body", "videoScript.conclusion",
    ]);
    expect(new Set(first.map(({ id }) => id)).size).toBe(first.length);
    expect(first.every(({ draftRevisionId }) => draftRevisionId === revision.id)).toBe(true);
    expect(first.every(({ id }) => /^claim-[a-f0-9]{24}$/u.test(id))).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.every(Object.isFrozen)).toBe(true);
  });

  it("does not treat a run of hashtags as a claim", () => {
    // A live draft was blocked on `Đây là các hashtag, không phải thông tin từ research` —
    // a correct verdict on a span that should never have been a claim (CR-0003).
    const tagged = {
      ...revision,
      content: {
        ...content,
        facebookPost: `${content.facebookPost}\n#AI #LLM #TrungCahaAI`,
      },
    };

    const texts = extractClaims(tagged).map(({ text }) => text);
    expect(texts.some((text) => text.startsWith("#"))).toBe(false);
    // The prose around them is untouched.
    expect(texts).toContain("Công cụ hỗ trợ tiếng Việt.");
  });

  it("still claims a sentence that merely mentions a hashtag", () => {
    // Narrow on purpose: only a span that is nothing but tags is excluded.
    const mixed = {
      ...revision,
      content: { ...content, facebookPost: "Dự án #AI này đạt 1.200 sao." },
    };
    const post = extractClaims(mixed).filter(({ path }) => path === "facebookPost");
    expect(post.map(({ text }) => text)).toEqual(["Dự án #AI này đạt 1.200 sao."]);
  });

  it("does not split a Vietnamese thousands separator into two claims", () => {
    // "1.200 sao" used to become "Dự án #AI này đạt 1." and "200 sao." — two fragments,
    // neither judgeable, both counted against the critique's coverage (CR-0003).
    const numeric = {
      ...revision,
      content: { ...content, facebookPost: "Dự án đạt 1.200 sao. Phiên bản mới nhanh hơn." },
    };
    const post = extractClaims(numeric).filter(({ path }) => path === "facebookPost");
    expect(post.map(({ text }) => text)).toEqual([
      "Dự án đạt 1.200 sao.",
      "Phiên bản mới nhanh hơn.",
    ]);
  });
});

describe("VerificationEngine", () => {
  it("returns one immutable source-backed finding per claim bound to the exact revision hash", async () => {
    const critic = modelB((request) => response(request, [...passFindings(request)].reverse()));
    const result = await engine(critic).verify({
      revision,
      research,
      requestedModel: modelBMetadata,
      maxRounds: 1,
    });

    expect(result).toMatchObject({
      kind: "Passed",
      eligibleStage: "Verified",
      attempts: 1,
      report: {
        draftRevisionId: revision.id,
        contentHash: revision.contentHash,
        researchResultId: research.id,
        round: 1,
        modelB: modelBMetadata,
        passed: true,
      },
    });
    if (result.kind !== "Passed") return;
    expect(result.report.findings.map(({ claimId }) => claimId))
      .toEqual(result.claims.map(({ id }) => id));
    expect(result.report.findings).toHaveLength(result.claims.length);
    expect(Object.isFrozen(result.report)).toBe(true);
    expect(Object.isFrozen(result.report.findings)).toBe(true);
    expect(Object.isFrozen(result.artifacts.reports)).toBe(true);

    const call = (critic.critique as ReturnType<typeof vi.fn>).mock.calls[0] as [
      ModelBCritiqueRequest,
      ModelCallControl,
    ];
    expect(call[0]).toMatchObject({ revision, research, round: 1 });
    expect(call[0].claims).toEqual(result.claims);
    expect(call[1].deadlineAt).toBe("2025-05-01T10:01:00.000Z");
  });

  it("runs a bounded Model A correction round and retains every revision and report", async () => {
    const critic = modelB((request) => response(
      request,
      request.round === 1
        ? request.claims.map(({ id }) => ({
            claimId: id,
            verdict: "Unsupported",
            evidenceRefs: [sourceRef],
            description: "Nguồn hiện tại chưa hỗ trợ phát biểu này.",
          }))
        : passFindings(request),
    ));
    const corrector: ModelACorrectionPort = {
      correct: vi.fn(async ({ revision: source }) => ({
        content: {
          ...source.content,
          facebookPost: `${source.content.facebookPost} Đã chỉnh theo nguồn.`,
        },
        provenance: modelAMetadata,
      })),
    };
    const result = await engine(critic, { modelA: corrector }).verify({
      revision,
      research,
      requestedModel: modelBMetadata,
      requestedCorrectionModel: modelAMetadata,
    });

    expect(result).toMatchObject({ kind: "Passed", attempts: 3 });
    if (result.kind !== "Passed") return;
    expect(result.activeRevision).toMatchObject({
      id: "draft-revision-1",
      draftId: revision.draftId,
      revision: 2,
      parentRevisionId: revision.id,
    });
    expect(result.activeRevision.contentHash).toBe(
      hashGenerationValue(result.activeRevision.content),
    );
    expect(result.artifacts.revisions).toEqual([result.activeRevision]);
    expect(result.artifacts.reports).toHaveLength(2);
    expect(result.artifacts.reports.map(({ draftRevisionId }) => draftRevisionId))
      .toEqual([revision.id, result.activeRevision.id]);
    expect(result.report.draftRevisionId).toBe(result.activeRevision.id);
    expect(critic.critique).toHaveBeenCalledTimes(2);
    expect(corrector.correct).toHaveBeenCalledOnce();
  });

  it("blocks at the configured round bound and never recommends approval", async () => {
    const critic = modelB((request) => response(request, request.claims.map(({ id }) => ({
      claimId: id,
      verdict: "Contradiction",
      evidenceRefs: [sourceRef],
      description: "Nguồn nói điều ngược lại.",
    }))));
    const result = await engine(critic).verify({
      revision,
      research,
      requestedModel: modelBMetadata,
      maxRounds: 1,
    });

    expect(result).toMatchObject({
      kind: "VerificationBlocked",
      eligibleStage: "Generated",
      workStatus: "VerificationBlocked",
      report: { passed: false, round: 1 },
    });
    expect(critic.critique).toHaveBeenCalledOnce();
  });

  it("downgrades inferred-only Pass verdicts to described Unsupported findings", async () => {
    const inferredResearch: ResearchResult = {
      ...research,
      items: [{
        id: "inferred-1",
        content: "Suy luận từ ngữ cảnh.",
        kind: "Inferred",
        evidenceRefs: [sourceRef],
        modelProvenance: modelBMetadata,
      }],
    };
    const result = await engine(modelB((request) => response(request))).verify({
      revision,
      research: inferredResearch,
      requestedModel: modelBMetadata,
      maxRounds: 1,
    });

    expect(result.kind).toBe("VerificationBlocked");
    if (result.kind !== "VerificationBlocked") return;
    expect(result.report.findings.every(({ verdict }) => verdict === "Unsupported"))
      .toBe(true);
    expect(result.report.findings[0]).toMatchObject({
      evidenceRefs: [sourceRef],
      description: expect.stringContaining("source-backed"),
    });
  });

  it("treats malformed coverage and ungrounded contradiction as retryable model responses", async () => {
    const incomplete = await engine(modelB(() => ({
      provenance: modelBMetadata,
      findings: [],
    }))).verify({
      revision,
      research,
      requestedModel: modelBMetadata,
      maxAttempts: 1,
    });
    expect(incomplete).toMatchObject({
      kind: "RetryableBlocked",
      failure: "InvalidModelResponse",
      error: { reason: "Model B must return exactly one finding per claim" },
    });

    const noDescription = await engine(modelB((request) => response(
      request,
      request.claims.map(({ id }) => ({
        claimId: id,
        verdict: "Contradiction",
        evidenceRefs: [sourceRef],
      })),
    ))).verify({
      revision,
      research,
      requestedModel: modelBMetadata,
      maxAttempts: 1,
    });
    expect(noDescription).toMatchObject({
      kind: "RetryableBlocked",
      failure: "InvalidModelResponse",
      error: { reason: expect.stringContaining("requires a useful description") },
    });
  });

  it("retries Model B at most three times then returns Generated/RetryableBlocked and notifies", async () => {
    const ops = operations();
    const critic = modelB(() => { throw new Error("provider unavailable"); });
    const result = await engine(critic, { operations: ops }).verify({
      revision,
      research,
      requestedModel: modelBMetadata,
    });

    expect(result).toMatchObject({
      kind: "RetryableBlocked",
      eligibleStage: "Generated",
      workStatus: "RetryableBlocked",
      attempts: 3,
      failure: "ModelUnresponsive",
      error: {
        draftRevisionId: revision.id,
        dependency: "ModelB",
        attempts: 3,
        reason: "provider unavailable",
      },
      notification: {
        eventKey: `verification:${revision.id}:1:ModelB:retryable-blocked`,
        action: "RetryVerification",
      },
    });
    expect(critic.critique).toHaveBeenCalledTimes(3);
    expect(ops.recordError).toHaveBeenCalledOnce();
    expect(ops.notifyOperator).toHaveBeenCalledOnce();
    expect("report" in result).toBe(false);
  });

  it("bounds deadlines and rejects stale revision hashes before calling either model", async () => {
    const hanging = modelB(() => new Promise<ModelBCritiqueResponse>(() => undefined));
    const deadline = await engine(hanging).verify({
      revision,
      research,
      requestedModel: modelBMetadata,
      maxAttempts: 1,
      deadlineMs: 5,
    });
    expect(deadline).toMatchObject({
      kind: "RetryableBlocked",
      failure: "DeadlineExceeded",
      attempts: 1,
    });

    const critic = modelB((request) => response(request));
    await expect(engine(critic).verify({
      revision: { ...revision, contentHash: "stale-hash" },
      research,
      requestedModel: modelBMetadata,
    })).rejects.toThrow(VerificationInputError);
    expect(critic.critique).not.toHaveBeenCalled();
  });
});
