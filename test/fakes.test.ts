import { describe, expect, it, vi } from "vitest";
import {
  FakeModelAGenerationClient,
  FakeModelBCritiqueClient,
  FakeSourceFetcher,
} from "../src/adapters/fakes.js";
import { InMemoryRepository } from "../src/adapters/in-memory-repository.js";
import type {
  ComplianceResult,
  DraftRevision,
  PlatformArtifact,
  ResearchResult,
  Topic,
  VerificationReport,
} from "../src/domain/content.js";
import type {
  ApprovalRecord,
  DeliveryRecord,
  PipelineRun,
} from "../src/domain/workflow.js";
import type { SourceConfig } from "../src/domain/source.js";

const CREATED = "2025-03-01T10:00:00.000Z";
const UPDATED = "2025-03-01T10:01:00.000Z";
const metadata = {
  provider: "provider-test",
  model: "model-test",
  promptVersion: "prompt-v1",
  configurationVersion: "config-v1",
};

const source: SourceConfig = {
  id: "source-1",
  type: "Website",
  url: "https://example.test/source",
  active: true,
  priority: 1,
  filterMode: "Best",
};

const topic: Topic = {
  id: "topic-1",
  sourceRef: {
    sourceId: source.id,
    captureId: "capture-1",
    url: source.url,
    capturedAt: CREATED,
    termsVersion: "terms-v1",
  },
  externalId: "external-1",
  title: "AI update",
  createdAt: CREATED,
  score: { total: 90, breakdown: [], scoringConfigVersion: "score-v1" },
  categories: ["AI Tools"],
};
const research: ResearchResult = {
  id: "research-1",
  topicId: topic.id,
  items: [{
    id: "research-item-1",
    content: "Source-backed fact",
    kind: "Quoted",
    evidenceRefs: [topic.sourceRef],
  }],
  status: "Ok",
  unreachableSources: [],
  skippedSources: [],
};

const content = {
  topicId: topic.id,
  facebookPost: "A source-backed Facebook post with sufficient test content.",
  guide: [{
    heading: "Guide",
    body: "Body",
    imageSuggestions: [{ description: "Detailed image suggestion" }],
  }],
  videoScript: { intro: "Intro", body: "Body", conclusion: "Conclusion" },
  originLinks: [source.url],
  language: "vi",
};

const revision: DraftRevision = {
  id: "revision-1",
  draftId: "draft-1",
  revision: 1,
  content,
  contentHash: "content-hash-1",
  createdBy: "System",
  createdAt: CREATED,
};

const report: VerificationReport = {
  id: "report-1",
  draftRevisionId: revision.id,
  contentHash: revision.contentHash,
  researchResultId: research.id,
  round: 1,
  modelB: metadata,
  findings: [{
    claimId: "claim-1",
    verdict: "Pass",
    evidenceRefs: [topic.sourceRef],
  }],
  passed: true,
};

const artifact: PlatformArtifact = {
  id: "artifact-1",
  draftRevisionId: revision.id,
  platform: "Facebook_Page",
  rendererVersion: "renderer-v1",
  body: content.facebookPost,
  metadata: {},
  attribution: source.url,
  imageSuggestions: [],
  artifactHash: "artifact-hash-1",
  createdAt: CREATED,
};
const compliance: ComplianceResult = {
  id: "compliance-1",
  artifactId: artifact.id,
  artifactHash: artifact.artifactHash,
  draftRevisionId: revision.id,
  platform: artifact.platform,
  ruleSetVersion: "rules-v1",
  sourceTermsVersions: ["terms-v1"],
  evaluatorVersion: "evaluator-v1",
  passed: true,
  violatedRuleIds: [],
  attributionOk: true,
  copyrightOk: true,
  reasons: [],
  checkedAt: CREATED,
};

const run: PipelineRun = {
  id: "run-1",
  topicId: topic.id,
  stage: "Collected",
  workStatus: "Ready",
  version: 0,
  categories: ["AI Tools"],
  createdAt: CREATED,
  updatedAt: CREATED,
};

const approval: ApprovalRecord = {
  id: "approval-1",
  pipelineRunId: run.id,
  draftRevisionId: revision.id,
  contentHash: revision.contentHash,
  approvedArtifactIds: [artifact.id],
  approvedArtifactHashes: [artifact.artifactHash],
  operatorId: "operator-1",
  approvedAt: UPDATED,
};

const delivery: DeliveryRecord = {
  id: "delivery-1",
  kind: "Export",
  platform: artifact.platform,
  targetId: "page-1",
  approvalId: approval.id,
  artifactId: artifact.id,
  artifactHash: artifact.artifactHash,
  idempotencyKey: "delivery-key-1",
  status: "Exported",
  attempts: 1,
  createdAt: UPDATED,
  updatedAt: UPDATED,
};

describe("adapter fakes", () => {
  it("configures source permissions/pages, records calls, and honors aborts", async () => {
    const page = { items: [{
      sourceId: source.id,
      externalId: "item-1",
      normalizedContentHash: "hash-1",
      publishedOrUpdatedAt: CREATED,
      title: "Item",
      body: "Body",
    }] };
    const fetcher = new FakeSourceFetcher({
      isAllowed: () => ({
        allowed: false,
        reason: "robots.txt",
        termsVersion: "terms-v2",
        robotsCapturedAt: CREATED,
      }),
      fetch: () => page,
    });
    await expect(fetcher.isAllowed(source)).resolves.toMatchObject({
      allowed: false,
      reason: "robots.txt",
    });
    await expect(fetcher.fetch(source, undefined, new AbortController().signal))
      .resolves.toEqual(page);
    expect(fetcher.permissionCalls).toEqual([source]);
    expect(fetcher.fetchCalls).toHaveLength(1);

    const controller = new AbortController();
    const pending = new FakeSourceFetcher({
      fetch: () => new Promise(() => undefined),
    }).fetch(source, undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("injects Model A and Model B independently and enforces call controls", async () => {
    const generationHandler = vi.fn(() => ({ content, provenance: metadata }));
    const critiqueHandler = vi.fn(() => ({
      findings: report.findings,
      provenance: { ...metadata, model: "model-b" },
    }));
    const modelA = new FakeModelAGenerationClient(generationHandler);
    const modelB = new FakeModelBCritiqueClient(critiqueHandler);
    const control = {
      signal: new AbortController().signal,
      deadlineAt: "2099-01-01T00:00:00.000Z",
    };
    const generationRequest = {
      topic,
      research,
      inputHash: "input-hash",
      requestedModel: metadata,
      language: "vi",
    };
    const critiqueRequest = {
      revision,
      claims: [{
        id: "claim-1",
        draftRevisionId: revision.id,
        format: "FacebookPost" as const,
        path: "facebookPost",
        startOffset: 0,
        endOffset: 10,
        text: "A fact",
      }],
      research,
      round: 1,
      requestedModel: { ...metadata, model: "model-b" },
    };

    await expect(modelA.generate(generationRequest, control)).resolves.toEqual({
      content,
      provenance: metadata,
    });
    await expect(modelB.critique(critiqueRequest, control)).resolves.toEqual({
      findings: report.findings,
      provenance: { ...metadata, model: "model-b" },
    });
    expect(modelA.calls).toEqual([{ request: generationRequest, control }]);
    expect(modelB.calls).toEqual([{ request: critiqueRequest, control }]);
    const expiredHandler = vi.fn(() => ({ content, provenance: metadata }));
    const expiredModel = new FakeModelAGenerationClient(
      expiredHandler,
      () => Date.parse("2025-01-02T00:00:00.000Z"),
    );
    await expect(expiredModel.generate(generationRequest, {
      ...control,
      deadlineAt: "2025-01-01T00:00:00.000Z",
    })).rejects.toThrow("deadline exceeded");
    expect(expiredHandler).not.toHaveBeenCalled();
  });
});

describe("InMemoryRepository", () => {
  it("atomically stores immutable linked records and replays transitions", async () => {
    const repository = new InMemoryRepository({ now: () => UPDATED });
    await repository.createPipelineRun({
      run,
      topic,
      idempotencyKey: "create-run",
    });
    const command = {
      pipelineRunId: run.id,
      expectedVersion: 0,
      expectedStage: "Collected" as const,
      expectedStatus: "Ready" as const,
      nextStage: "PendingApproval" as const,
      nextStatus: "Ready" as const,
      nextActiveDraftRevisionId: revision.id,
      actorType: "System" as const,
      records: {
        researchResults: [research],
        draftRevisions: [revision],
        verificationReports: [report],
        platformArtifacts: [artifact],
        complianceResults: [compliance],
      },
      idempotencyKey: "prepare-review",
    };

    const applied = await repository.commitGuardedTransition(command);
    expect(applied).toMatchObject({
      kind: "Applied",
      run: { stage: "PendingApproval", version: 1 },
    });
    expect(await repository.getDraftRevision(revision.id)).toEqual(revision);
    expect(await repository.getVerificationReport(report.id)).toEqual(report);
    expect(await repository.getComplianceResult(compliance.id)).toEqual(compliance);

    const loaded = await repository.getDraftRevision(revision.id);
    (loaded?.content.guide as unknown as Array<{ heading: string }>)[0]!.heading =
      "mutated";
    expect((await repository.getDraftRevision(revision.id))?.content.guide[0]?.heading)
      .toBe("Guide");

    const replayed = await repository.commitGuardedTransition(command);
    expect(replayed).toEqual({
      ...(applied as Exclude<typeof applied, { kind: "Conflict" }>),
      kind: "Replayed",
    });
    expect(await repository.listTransitions(run.id)).toHaveLength(1);
  });
  it("rejects stale or invalid writes without partial persistence", async () => {
    const repository = new InMemoryRepository({ now: () => UPDATED });
    await repository.createPipelineRun({ run, topic, idempotencyKey: "create-run" });

    await expect(repository.commitGuardedTransition({
      pipelineRunId: run.id,
      expectedVersion: 0,
      expectedStage: "Collected",
      expectedStatus: "Ready",
      nextStage: "Generated",
      nextStatus: "Ready",
      nextActiveDraftRevisionId: revision.id,
      actorType: "System",
      records: {
        researchResults: [research],
        draftRevisions: [revision],
        verificationReports: [{ ...report, contentHash: "wrong-hash" }],
      },
      idempotencyKey: "invalid-binding",
    })).rejects.toThrow("content hash mismatch");
    expect(await repository.getResearchResult(research.id)).toBeUndefined();
    expect(await repository.getDraftRevision(revision.id)).toBeUndefined();
    expect(await repository.getPipelineRun(run.id)).toEqual(run);

    await expect(repository.commitGuardedTransition({
      pipelineRunId: run.id,
      expectedVersion: 99,
      expectedStage: "Collected",
      expectedStatus: "Ready",
      nextStage: "Scored",
      nextStatus: "Ready",
      actorType: "System",
      records: { researchResults: [research] },
      idempotencyKey: "stale",
    })).resolves.toEqual({ kind: "Conflict", current: run });
    expect(await repository.getResearchResult(research.id)).toBeUndefined();
  });

  it("idempotently records only deliveries bound to approved artifact hashes", async () => {
    const repository = new InMemoryRepository({ now: () => UPDATED });
    await repository.createPipelineRun({ run, topic, idempotencyKey: "create-run" });
    await repository.commitGuardedTransition({
      pipelineRunId: run.id,
      expectedVersion: 0,
      expectedStage: "Collected",
      expectedStatus: "Ready",
      nextStage: "Approved",
      nextStatus: "Ready",
      nextActiveDraftRevisionId: revision.id,
      actorType: "Operator",
      actorId: "operator-1",
      records: {
        researchResults: [research],
        draftRevisions: [revision],
        platformArtifacts: [artifact],
        approvals: [approval],
      },
      idempotencyKey: "approve",
    });

    await expect(repository.recordDelivery(delivery)).resolves.toEqual({
      record: delivery,
      replayed: false,
    });
    await expect(repository.recordDelivery({
      ...delivery,
      id: "other-delivery",
      status: "Failed",
    })).resolves.toEqual({ record: delivery, replayed: true });
    await expect(repository.recordDelivery({
      ...delivery,
      id: "invalid-delivery",
      idempotencyKey: "invalid-key",
      artifactHash: "wrong-hash",
    })).rejects.toThrow("Delivery approval binding mismatch");
  });
});
