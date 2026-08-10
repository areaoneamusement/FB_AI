import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FakeModelAGenerationClient,
  FakeModelBCritiqueClient,
  FakeSourceFetcher,
} from "../src/adapters/fakes.js";
import {
  createMvpApplication,
  type MvpApplication,
  type MvpCompositionConfig,
} from "../src/app/mvp-composition-root.js";
import type {
  ContentDraft,
  PlatformArtifact,
  ReproducibilityMetadata,
} from "../src/domain/content.js";
import type { SourceConfig } from "../src/domain/source.js";
import { WORKFLOW_STAGE_INDEX } from "../src/domain/workflow.js";
import type {
  ExportBundle,
  PipelineTransition,
} from "../src/domain/workflow.js";
import type { ModelACorrectionPort } from "../src/pipeline/verification-engine.js";

const NOW = new Date("2025-08-01T12:00:00.000Z");
const OPERATOR = { id: "operator-1", role: "Operator" } as const;
const MODEL_A: ReproducibilityMetadata = {
  provider: "fake-a",
  model: "generator-a",
  promptVersion: "prompt-a-v1",
  configurationVersion: "config-a-v1",
};
const MODEL_B: ReproducibilityMetadata = {
  provider: "fake-b",
  model: "critic-b",
  promptVersion: "prompt-b-v1",
  configurationVersion: "config-b-v1",
};

const sources: readonly SourceConfig[] = [
  {
    id: "github-main",
    type: "GitHub",
    url: "https://origin.test/repository",
    active: true,
    priority: 100,
    filterMode: "Best",
  },
];

function generatedContent(topicId: string, originUrl: string): ContentDraft {
  return {
    topicId,
    facebookPost:
      "Bản tin AI hữu ích cho cộng đồng, có kiểm chứng và nguồn rõ ràng. ".repeat(2),
    guide: ["Khởi động", "Thực hành", "Đánh giá"].map((heading) => ({
      heading,
      body: `Nội dung hướng dẫn cho phần ${heading}.`,
      imageSuggestions: [{ description: `Minh họa chi tiết cho phần ${heading}` }],
    })),
    videoScript: {
      intro: "Giới thiệu cập nhật AI.",
      body: "Phân tích nội dung chính.",
      conclusion: "Tổng kết và khuyến nghị.",
    },
    originLinks: [originUrl],
    language: "vi",
  };
}

interface Harness {
  readonly app: MvpApplication;
  readonly modelA: FakeModelAGenerationClient;
  readonly modelB: FakeModelBCritiqueClient;
  readonly fetcher: FakeSourceFetcher;
}

/** Boots the real Phase 1 composition root against an on-disk SQLite database. */
function createHarness(sqlitePath: string): Harness {
  const fetcher = new FakeSourceFetcher({
    fetch: (source) => ({
      items: [{
        sourceId: source.id,
        externalId: "release-1",
        canonicalUrl: source.url,
        normalizedContentHash: "capture-release-1",
        publishedOrUpdatedAt: NOW.toISOString(),
        title: "AI release 1",
        body: "Research evidence for the release.",
        github: { stars: 500, lastUpdatedAt: NOW.toISOString(), changelog: "v1" },
      }],
    }),
    isAllowed: () => ({
      allowed: true,
      termsVersion: "terms-v1",
      robotsCapturedAt: NOW.toISOString(),
    }),
  });
  const modelA = new FakeModelAGenerationClient(
    (request) => ({
      content: generatedContent(request.topic.id, request.topic.sourceRef.url),
      provenance: MODEL_A,
    }),
    () => NOW.getTime(),
  );
  const modelACorrection: ModelACorrectionPort = {
    correct: async () => {
      throw new Error("correction is not expected on the happy path");
    },
  };
  const modelB = new FakeModelBCritiqueClient(
    (request) => ({
      provenance: MODEL_B,
      findings: request.claims.map(({ id }) => ({
        claimId: id,
        verdict: "Pass" as const,
        evidenceRefs: [request.research.items[0]!.evidenceRefs[0]!],
      })),
    }),
    () => NOW.getTime(),
  );
  const config: MvpCompositionConfig = {
    sqlitePath,
    sources,
    collection: { windowHours: 24, maxRetries: 1 },
    scoring: {
      config: {
        version: "score-v1",
        criteria: [
          { id: "freshness", weightPercent: 40 },
          { id: "authority", weightPercent: 30 },
          { id: "relevance", weightPercent: 30 },
        ],
      },
      minScore: 70,
      valuesFor: () => ({ freshness: 95, authority: 90, relevance: 100 }),
    },
    research: { minItems: 1 },
    generation: { requestedModel: MODEL_A },
    verification: {
      requestedModel: MODEL_B,
      requestedCorrectionModel: MODEL_A,
    },
    rendering: {
      rendererVersion: "renderer-v1",
      platforms: ["Facebook_Page", "YouTube"],
    },
    compliance: {
      evaluatorVersion: "compliance-v1",
      resolve: (artifact) => ({
        ruleSet: {
          version: "rules-v1",
          rules: [{
            id: `forbidden-${artifact.platform}`,
            platform: artifact.platform,
            version: "1",
            kind: "Keyword",
            parameters: { keywords: ["nội dung bị cấm tuyệt đối"] },
            effectiveFrom: "2020-01-01T00:00:00.000Z",
          }],
        },
        sourceTerms: [{
          sourceId: "github-main",
          version: "terms-v1",
          attributionRequired: true,
          requiredAttributionUrl: sources[0]!.url,
        }],
        sourceCaptures: [{
          sourceId: "github-main",
          captureId: "copyright-capture-1",
          termsVersion: "terms-v1",
          url: sources[0]!.url,
          content: "completely unrelated vocabulary for copyright comparison",
        }],
      }),
    },
    categories: { allowed: ["AI Tools", "AI News"], selectFor: () => ["AI News"] },
    dashboardHttp: {
      authenticate: async () => OPERATOR,
      issueCsrfToken: async () => "csrf-test",
      validateCsrfToken: async (_request, _operator, token) => token === "csrf-test",
    },
    now: () => NOW,
  };
  const app = createMvpApplication(config, {
    sourceFetcher: fetcher,
    modelA,
    modelACorrection,
    modelB,
  });
  return { app, modelA, modelB, fetcher };
}

function stageSequence(
  transitions: readonly PipelineTransition[],
): readonly string[] {
  return transitions.map(({ fromStage, toStage }) => `${fromStage}->${toStage}`);
}

/** Fails unless every transition advances exactly one stage in the canonical order. */
function expectStrictlyAdjacent(transitions: readonly PipelineTransition[]): void {
  for (const transition of transitions) {
    const from = WORKFLOW_STAGE_INDEX[
      transition.fromStage as keyof typeof WORKFLOW_STAGE_INDEX
    ];
    const to = WORKFLOW_STAGE_INDEX[
      transition.toStage as keyof typeof WORKFLOW_STAGE_INDEX
    ];
    expect(from, `unknown from stage ${transition.fromStage}`).toBeTypeOf("number");
    expect(to, `unknown to stage ${transition.toStage}`).toBeTypeOf("number");
    expect(to - from, `${transition.fromStage}->${transition.toStage} is not adjacent`)
      .toBe(1);
  }
}

function expectByteIdentical(actual: string, expected: string, label: string): void {
  expect(
    Buffer.from(actual, "utf8").equals(Buffer.from(expected, "utf8")),
    `${label} is not byte-identical`,
  ).toBe(true);
}

function expectBundleMatchesArtifact(
  bundle: ExportBundle,
  artifact: PlatformArtifact,
): void {
  expectByteIdentical(bundle.body, artifact.body, `${artifact.platform} body`);
  expectByteIdentical(
    bundle.attribution,
    artifact.attribution,
    `${artifact.platform} attribution`,
  );
  expect(Object.keys(bundle.metadata).sort()).toEqual(
    Object.keys(artifact.metadata).sort(),
  );
  for (const [key, value] of Object.entries(artifact.metadata)) {
    expectByteIdentical(
      bundle.metadata[key] ?? "",
      value,
      `${artifact.platform} metadata.${key}`,
    );
  }
  expect(bundle.imageSuggestions).toEqual(artifact.imageSuggestions);
  expect(bundle.artifactHash).toBe(artifact.artifactHash);
  expect(bundle.rendererVersion).toBe(artifact.rendererVersion);
  expect(bundle.platform).toBe(artifact.platform);
}

describe("MVP end-to-end happy path", () => {
  let directory: string;
  let harness: Harness;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "fb-ai-e2e-"));
    harness = createHarness(join(directory, "mvp.sqlite"));
  });

  afterEach(() => {
    harness.app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("flows a seeded source to an Exported copy-ready bundle behind Operator approval", async () => {
    const { app, modelA, modelB } = harness;

    const cycle = await app.pipeline.runCycle();
    expect(cycle.collection).toMatchObject({ skipped: [], errors: [] });
    expect(cycle.items).toHaveLength(1);
    expect(cycle.items[0]).toMatchObject({
      kind: "PendingReview",
      run: { stage: "PendingApproval", workStatus: "Ready" },
    });

    const pending = await app.dashboardApi.listPending();
    expect(pending).toHaveLength(1);
    const runId = pending[0]!.pipelineRunId;

    const automatic = await app.repository.listTransitions(runId);
    expect(stageSequence(automatic)).toEqual([
      "Collected->Scored",
      "Scored->Researched",
      "Researched->Generated",
      "Generated->Verified",
      "Verified->ComplianceChecked",
      "ComplianceChecked->PendingApproval",
    ]);
    expectStrictlyAdjacent(automatic);
    expect(automatic.every(({ actorType }) => actorType === "System")).toBe(true);

    const review = await app.dashboardApi.getReviewPackage(runId);
    const verification = review.verification;
    expect(verification).toBeDefined();
    expect(verification).toMatchObject({
      draftRevisionId: review.revision.id,
      contentHash: review.revision.contentHash,
      passed: true,
    });
    expect(review.artifacts).toHaveLength(2);
    expect(review.compliance).toHaveLength(2);
    expect(review.compliance.every(({ passed }) => passed)).toBe(true);

    const facebook = review.artifacts.find(
      ({ platform }) => platform === "Facebook_Page",
    )!;
    const youtube = review.artifacts.find(({ platform }) => platform === "YouTube")!;

    // Delivery is refused while the run is still awaiting explicit approval.
    await expect(app.dashboardApi.deliverApprovedArtifact(runId, {
      operator: OPERATOR,
      approvalId: `${runId}:approval:approve-1`,
      artifactId: facebook.id,
      artifactHash: facebook.artifactHash,
      targetId: "manual-copy-page",
      idempotencyKey: "blocked-before-approval",
    })).rejects.toMatchObject({ code: "CONTENT_NOT_APPROVED" });
    expect(await app.output.deliver({
      approvalId: `${runId}:approval:approve-1`,
      artifactId: facebook.id,
      artifactHash: facebook.artifactHash,
      targetId: "manual-copy-page",
      idempotencyKey: "blocked-before-approval-port",
    })).toMatchObject({ status: "Failed", errorCode: "APPROVAL_NOT_FOUND" });
    expect(await app.repository.getPipelineRun(runId)).toMatchObject({
      stage: "PendingApproval",
    });

    // Explicit, confirmed Operator approval bound to the exact revision/artifact hashes.
    const complianceFor = (artifactId: string): string =>
      review.compliance.find((result) => result.artifactId === artifactId)!.id;
    const pendingRun = (await app.repository.getPipelineRun(runId))!;
    const approval = await app.dashboardApi.approve(runId, {
      operator: OPERATOR,
      expectedVersion: pendingRun.version,
      idempotencyKey: "approve-1",
      confirmed: true,
      draftRevisionId: review.revision.id,
      contentHash: review.revision.contentHash,
      verificationReportId: verification!.id,
      complianceResultIds: [complianceFor(facebook.id), complianceFor(youtube.id)],
      artifactIds: [facebook.id, youtube.id],
      artifactHashes: [facebook.artifactHash, youtube.artifactHash],
    });
    expect(approval).toMatchObject({
      pipelineRunId: runId,
      draftRevisionId: review.revision.id,
      contentHash: review.revision.contentHash,
      operatorId: OPERATOR.id,
      approvedArtifactIds: [facebook.id, youtube.id],
      approvedArtifactHashes: [facebook.artifactHash, youtube.artifactHash],
    });

    const approvedRun = (await app.repository.getPipelineRun(runId))!;
    expect(approvedRun).toMatchObject({ stage: "Approved", workStatus: "Ready" });
    const allTransitions = await app.repository.listTransitions(runId);
    expect(stageSequence(allTransitions)).toEqual([
      "Collected->Scored",
      "Scored->Researched",
      "Researched->Generated",
      "Generated->Verified",
      "Verified->ComplianceChecked",
      "ComplianceChecked->PendingApproval",
      "PendingApproval->Approved",
    ]);
    expectStrictlyAdjacent(allTransitions);
    expect(allTransitions.at(-1)).toMatchObject({
      actorType: "Operator",
      actorId: OPERATOR.id,
    });

    // Export through the OutputPort; bundles must mirror the immutable artifacts.
    const exports = await Promise.all([facebook, youtube].map(async (artifact) => {
      const outcome = await app.output.deliver({
        approvalId: approval.id,
        artifactId: artifact.id,
        artifactHash: artifact.artifactHash,
        targetId: `manual-copy-${artifact.platform}`,
        idempotencyKey: `export:${approval.id}:${artifact.id}`,
      });
      expect(outcome.status).toBe("Exported");
      expect(outcome.exportedBundleId).toBeTypeOf("string");
      expect(outcome.externalId).toBeUndefined();
      expect(outcome.externalUrl).toBeUndefined();
      const bundle = await app.output.getExportBundle(outcome.exportedBundleId!);
      expect(bundle).toBeDefined();
      const stored = (await app.repository.getPlatformArtifact(artifact.id))!;
      expectBundleMatchesArtifact(bundle!, stored);
      expect(stored).toEqual(artifact);
      return { outcome, artifact };
    }));
    expect(exports).toHaveLength(2);

    // Re-running the same export command is idempotent: same bundle, one record.
    for (const { outcome, artifact } of exports) {
      const replay = await app.output.deliver({
        approvalId: approval.id,
        artifactId: artifact.id,
        artifactHash: artifact.artifactHash,
        targetId: `manual-copy-${artifact.platform}`,
        idempotencyKey: `export:${approval.id}:${artifact.id}`,
      });
      expect(replay).toEqual(outcome);
    }
    const deliveries = await app.repository.listDeliveriesByApproval(approval.id);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map(({ artifactId }) => artifactId).sort()).toEqual(
      [facebook.id, youtube.id].sort(),
    );

    // No Phase 2 publishing path exists or was taken in Phase 1.
    for (const delivery of deliveries) {
      expect(delivery.kind).toBe("Export");
      expect(delivery.status).toBe("Exported");
      expect(delivery.attempts).toBe(1);
      expect(delivery.externalId).toBeUndefined();
      expect(delivery.externalUrl).toBeUndefined();
      expect(delivery.nextAttemptAt).toBeUndefined();
      expect(delivery.exportBundle).toBeDefined();
    }
    expect(
      Object.keys(app).filter((key) => /publish|credential|group/iu.test(key)),
    ).toEqual([]);
    expect(app.output.constructor.name).toBe("CopyReadyExporter");
    expect(modelA.calls).toHaveLength(1);
    expect(modelB.calls).toHaveLength(1);
  });

  it("returns an edited PendingApproval run to Generated and invalidates prior evidence", async () => {
    const { app } = harness;
    await app.pipeline.runCycle();
    const runId = (await app.dashboardApi.listPending())[0]!.pipelineRunId;
    const review = await app.dashboardApi.getReviewPackage(runId);
    const facebook = review.artifacts.find(
      ({ platform }) => platform === "Facebook_Page",
    )!;
    const verificationId = review.verification!.id;
    const complianceIds = review.artifacts.map(
      (artifact) =>
        review.compliance.find((result) => result.artifactId === artifact.id)!.id,
    );
    const pendingRun = (await app.repository.getPipelineRun(runId))!;

    const edited: ContentDraft = {
      ...review.revision.content,
      facebookPost: `${review.revision.content.facebookPost} Operator đã bổ sung ghi chú.`,
    };
    const newRevision = await app.dashboardApi.editDraft(runId, {
      operator: OPERATOR,
      expectedVersion: pendingRun.version,
      idempotencyKey: "edit-1",
      patch: { content: edited },
    });
    expect(newRevision.parentRevisionId).toBe(review.revision.id);
    expect(newRevision.contentHash).not.toBe(review.revision.contentHash);

    const editedRun = (await app.repository.getPipelineRun(runId))!;
    expect(editedRun).toMatchObject({
      stage: "Generated",
      workStatus: "Ready",
      activeDraftRevisionId: newRevision.id,
    });
    const transitions = await app.repository.listTransitions(runId);
    expect(stageSequence(transitions).at(-1)).toBe("PendingApproval->Generated");

    // The superseded revision and its evidence are retained but no longer eligible.
    expect(await app.repository.getDraftRevision(review.revision.id)).toEqual(
      review.revision,
    );
    const reopened = await app.dashboardApi.getReviewPackage(runId);
    expect(reopened.verification).toBeUndefined();
    expect(reopened.artifacts).toEqual([]);
    expect(reopened.compliance).toEqual([]);

    await expect(app.dashboardApi.approve(runId, {
      operator: OPERATOR,
      expectedVersion: editedRun.version,
      idempotencyKey: "approve-after-edit",
      confirmed: true,
      draftRevisionId: review.revision.id,
      contentHash: review.revision.contentHash,
      verificationReportId: verificationId,
      complianceResultIds: complianceIds,
      artifactIds: review.artifacts.map(({ id }) => id),
      artifactHashes: review.artifacts.map(({ artifactHash }) => artifactHash),
    })).rejects.toMatchObject({ code: "EVIDENCE_MISMATCH" });

    await expect(app.dashboardApi.deliverApprovedArtifact(runId, {
      operator: OPERATOR,
      approvalId: `${runId}:approval:approve-after-edit`,
      artifactId: facebook.id,
      artifactHash: facebook.artifactHash,
      targetId: "manual-copy-page",
      idempotencyKey: "deliver-after-edit",
    })).rejects.toMatchObject({ code: "CONTENT_NOT_APPROVED" });
    expect(await app.repository.listApprovalsByPipelineRun(runId)).toEqual([]);
    expect((await app.repository.getPipelineRun(runId))!.stage).toBe("Generated");
  });

  it("rejects a PendingApproval run with a valid note while preserving draft data", async () => {
    const { app } = harness;
    await app.pipeline.runCycle();
    const runId = (await app.dashboardApi.listPending())[0]!.pipelineRunId;
    const review = await app.dashboardApi.getReviewPackage(runId);
    const pendingRun = (await app.repository.getPipelineRun(runId))!;
    const note = "Operator rejected this draft: the release notes need a rewrite.";

    const rejected = await app.dashboardApi.reject(runId, {
      operator: OPERATOR,
      expectedVersion: pendingRun.version,
      idempotencyKey: "reject-1",
      note,
    });
    expect(rejected).toMatchObject({
      stage: "Rejected",
      workStatus: "Rejected",
      activeDraftRevisionId: review.revision.id,
      blockedReason: `[PendingApproval] ${note}`,
    });

    const transitions = await app.repository.listTransitions(runId);
    expect(transitions.at(-1)).toMatchObject({
      fromStage: "PendingApproval",
      toStage: "Rejected",
      actorType: "Operator",
      actorId: OPERATOR.id,
      reason: note,
    });

    // All draft data and evidence survive the terminal rejection.
    expect(await app.repository.getDraftRevision(review.revision.id)).toEqual(
      review.revision,
    );
    expect(
      await app.repository.listVerificationReportsByDraftRevision(review.revision.id),
    ).toContainEqual(review.verification!);
    expect(
      await app.repository.listPlatformArtifactsByDraftRevision(review.revision.id),
    ).toEqual(review.artifacts);
    expect(
      await app.repository.listComplianceResultsByDraftRevision(review.revision.id),
    ).toEqual(review.compliance);
    expect(await app.repository.listApprovalsByPipelineRun(runId)).toEqual([]);
    expect(await app.dashboardApi.listPending()).toEqual([]);
  });

  it("leaves no stray SQLite side files in the temporary directory", () => {
    expect(readdirSync(directory)).toEqual(["mvp.sqlite"]);
  });
});
