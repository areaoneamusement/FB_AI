import { describe, expect, it } from "vitest";

import {
  FakeModelAGenerationClient,
  FakeModelBCritiqueClient,
  FakeSourceFetcher,
} from "../src/adapters/fakes.js";
import {
  createMvpApplication,
} from "../src/app/mvp-composition-root.js";
import { CopyReadyExporter } from "../src/output/copy-ready-exporter.js";
import type { ReproducibilityMetadata } from "../src/domain/content.js";
import type { SourceConfig } from "../src/domain/source.js";
import type { ModelACorrectionPort } from "../src/pipeline/verification-engine.js";
import { VerificationEngine } from "../src/pipeline/verification-engine.js";

const NOW = new Date("2025-08-01T12:00:00.000Z");
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
  {
    id: "website-disabled",
    type: "Website",
    url: "https://website.test",
    active: false,
    priority: 50,
    filterMode: "High",
  },
  {
    id: "forum-disabled",
    type: "Forum",
    url: "https://forum.test",
    active: false,
    priority: 10,
    filterMode: "All",
  },
];

function generatedContent(topicId: string, originUrl: string) {
  return {
    topicId,
    facebookPost: "Bản tin AI hữu ích cho cộng đồng, có kiểm chứng và nguồn rõ ràng. ".repeat(2),
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

describe("MVP composition root", () => {
  it("constructs and reaches every Phase 1 component through pending review on SQLite", async () => {
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
    const modelA = new FakeModelAGenerationClient((request) => ({
      content: generatedContent(request.topic.id, request.topic.sourceRef.url),
      provenance: MODEL_A,
    }), () => NOW.getTime());
    const modelACorrection: ModelACorrectionPort = {
      correct: async () => { throw new Error("correction is not expected on the smoke path"); },
    };
    const modelB = new FakeModelBCritiqueClient((request) => ({
      provenance: MODEL_B,
      findings: request.claims.map(({ id }) => ({
        claimId: id,
        verdict: "Pass",
        evidenceRefs: [request.research.items[0]!.evidenceRefs[0]!],
      })),
    }), () => NOW.getTime());
    const app = createMvpApplication({
      sqlitePath: ":memory:",
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
      categories: {
        allowed: ["AI Tools", "AI News"],
        selectFor: () => ["AI News"],
      },
      dashboardHttp: {
        authenticate: async () => ({ id: "operator-1", role: "Operator" }),
        issueCsrfToken: async () => "csrf-test",
        validateCsrfToken: async (_request, _operator, token) => token === "csrf-test",
      },
      now: () => NOW,
    }, {
      sourceFetcher: fetcher,
      modelA,
      modelACorrection,
      modelB,
    });

    try {
      const cycle = await app.pipeline.runCycle();
      expect(cycle.collection).toMatchObject({ skipped: [], errors: [] });
      expect(cycle.items).toHaveLength(1);
      expect(cycle.items[0]).toMatchObject({
        kind: "PendingReview",
        run: { stage: "PendingApproval", version: 6 },
      });
      expect(app.dashboardHttpHandler).toBeTypeOf("function");
      expect(app.verification).toBeInstanceOf(VerificationEngine);
      expect(app.output).toBeInstanceOf(CopyReadyExporter);

      const pending = await app.dashboardApi.listPending();
      expect(pending).toHaveLength(1);
      const runId = pending[0]!.pipelineRunId;
      const review = await app.dashboardApi.getReviewPackage(runId);
      expect(review.verification).toMatchObject({
        draftRevisionId: review.revision.id,
        contentHash: review.revision.contentHash,
        passed: true,
      });
      expect(review.artifacts).toHaveLength(2);
      expect(review.compliance).toHaveLength(2);
      expect(review.compliance.every((result) => result.passed)).toBe(true);

      const transitions = await app.repository.listTransitions(runId);
      expect(transitions.map(({ fromStage, toStage }) => `${fromStage}->${toStage}`))
        .toEqual([
          "Collected->Scored",
          "Scored->Researched",
          "Researched->Generated",
          "Generated->Verified",
          "Verified->ComplianceChecked",
          "ComplianceChecked->PendingApproval",
        ]);
      const artifact = review.artifacts[0]!;
      await expect(app.dashboardApi.deliverApprovedArtifact(runId, {
        operator: { id: "operator-1", role: "Operator" },
        approvalId: "not-approved",
        artifactId: artifact.id,
        artifactHash: artifact.artifactHash,
        targetId: "manual-copy-page",
        idempotencyKey: "blocked-before-approval",
      })).rejects.toMatchObject({ code: "CONTENT_NOT_APPROVED" });
      expect(await app.repository.getPipelineRun(runId)).toMatchObject({
        stage: "PendingApproval",
        activeDraftRevisionId: review.revision.id,
      });
      expect(modelA.calls).toHaveLength(1);
      expect(modelB.calls).toHaveLength(1);
    } finally {
      app.close();
    }
  });

  it("renders deterministic immutable artifacts bound to revision content", async () => {
    const fetcher = new FakeSourceFetcher();
    const modelA = new FakeModelAGenerationClient(() => {
      throw new Error("not called");
    });
    const modelACorrection: ModelACorrectionPort = {
      correct: async () => { throw new Error("not called"); },
    };
    const modelB = new FakeModelBCritiqueClient(() => {
      throw new Error("not called");
    });
    const base = {
      sqlitePath: ":memory:",
      sources,
      scoring: {
        config: { version: "v1", criteria: [{ id: "score", weightPercent: 100 }] },
        minScore: 0,
        valuesFor: () => ({ score: 100 }),
      },
      generation: { requestedModel: MODEL_A },
      verification: {
        requestedModel: MODEL_B,
        requestedCorrectionModel: MODEL_A,
      },
      rendering: { rendererVersion: "renderer-v1", platforms: ["Facebook_Page"] as const },
      compliance: {
        evaluatorVersion: "v1",
        resolve: async () => ({ sourceCaptures: [] }),
      },
      categories: { allowed: ["AI News"], selectFor: () => ["AI News"] },
      dashboardHttp: {
        authenticate: async () => ({ id: "operator", role: "Operator" as const }),
        issueCsrfToken: async () => "csrf",
        validateCsrfToken: async () => true,
      },
      now: () => NOW,
    };
    const app = createMvpApplication(base, {
      sourceFetcher: fetcher,
      modelA,
      modelACorrection,
      modelB,
    });
    try {
      const topic = {
        id: "topic-render",
        sourceRef: {
          sourceId: "github-main",
          captureId: "capture",
          url: sources[0]!.url,
          capturedAt: NOW.toISOString(),
          termsVersion: "terms-v1",
        },
        externalId: "render",
        title: "Render title",
        createdAt: NOW.toISOString(),
        score: { total: 100, breakdown: [], scoringConfigVersion: "v1" },
        categories: ["AI News"],
      };
      const content = generatedContent(topic.id, topic.sourceRef.url);
      const revision = {
        id: "revision-render",
        draftId: "draft-render",
        revision: 1,
        content,
        contentHash: "content-hash-render",
        createdBy: "System" as const,
        createdAt: NOW.toISOString(),
      };
      const first = app.renderer.render({ revision, topic, platforms: ["Facebook_Page"] })[0]!;
      const second = app.renderer.render({ revision, topic, platforms: ["Facebook_Page"] })[0]!;
      expect(second).toEqual(first);
      expect(Object.isFrozen(first)).toBe(true);
      expect(first.artifactHash).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      app.close();
    }
  });
});
