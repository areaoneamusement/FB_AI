import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type {
  ComplianceResult,
  DraftRevision,
  PlatformArtifact,
  ResearchResult,
  TargetPlatform,
  Topic,
  VerificationFinding,
  VerificationReport,
} from "../src/domain/content.js";
import type {
  ApprovalRecord,
  DeliveryRecord,
  PipelineRun,
} from "../src/domain/workflow.js";
import type { GuardedTransitionCommand } from "../src/adapters/ports.js";
import { SqliteRepository } from "../src/persistence/sqlite-repository.js";

/**
 * Property + integration tests for the SQLite repository's explainability
 * persistence (tasks 12.2 and 12.3).
 *
 * The property runs against `SqliteRepository` backed by an in-memory database;
 * the integration test uses a real on-disk SQLite file and reloads it through a
 * second repository handle to prove the round trip survives the file format.
 */
const RUNS = { numRuns: 100 } as const;

const CREATED = "2025-03-01T10:00:00.000Z";
const STAMP = "2025-03-01T10:05:00.000Z";

const PLATFORMS = [
  "Facebook_Page",
  "Facebook_Group",
  "YouTube",
] as const satisfies readonly TargetPlatform[];

/**
 * Characters that stress JSON encoding: quotes, backslashes, newline, tab,
 * C0 control characters, a real NUL, a literal `\u0000` escape-looking
 * sequence, astral-plane emoji (including a ZWJ sequence) and a surrogate-pair
 * mathematical alphabet.
 */
const JSON_STRESS = `"kép" \\thư_mục\\ \n \t \u0001 \u001f \u0000 \\u0000 🧪🚀 👩‍💻 𝕁𝕊𝕆ℕ`;

/** Vietnamese / non-ASCII chunks combined into every generated string field. */
const TEXT_CHUNKS = [
  "Tiếng Việt có dấu đầy đủ",
  "công cụ AI mới nhất",
  "trích dẫn “kép” và 'đơn'",
  "khoảng   trắng   liên   tiếp",
  '{"nhúng":"json","số":1}',
  "</script>&amp;#39;",
  "日本語とРусский",
  "ﬁ ligature ／ fullwidth ＊",
] as const;

/** Every string field carries Vietnamese text and the full JSON stress set. */
const textArb = fc
  .array(fc.constantFrom(...TEXT_CHUNKS), { minLength: 1, maxLength: 3 })
  .map((parts) => `${parts.join(" | ")} ${JSON_STRESS}`);

function label(prefix: string, text: string): string {
  return `${prefix} · ${text}`;
}

/** Component values in [0,100], with the 0 and 100 boundaries oversampled. */
const componentArb = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(0, 100) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 100 }) },
);

const breakdownArb = fc
  .integer({ min: 1, max: 5 })
  .chain((count) =>
    fc.record({
      components: fc.array(componentArb, {
        minLength: count,
        maxLength: count,
      }),
      text: textArb,
    }),
  )
  .map(({ components, text }) => {
    const share = Math.floor((100 / components.length) * 100) / 100;
    return components.map((componentValue, index) => ({
      criterionId: label(`tiêu-chí-${index}`, text),
      componentValue,
      weightPercent:
        index === components.length - 1
          ? Number((100 - share * (components.length - 1)).toFixed(2))
          : share,
    }));
  });

const findingArb = fc.record({
  verdict: fc.constantFrom<VerificationFinding["verdict"]>(
    "Pass",
    "Contradiction",
    "Unsupported",
  ),
  described: fc.boolean(),
  confidence: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), {
    nil: undefined,
  }),
});

interface CaseSpec {
  readonly text: string;
  readonly breakdown: readonly {
    readonly criterionId: string;
    readonly componentValue: number;
    readonly weightPercent: number;
  }[];
  readonly scored: boolean;
  readonly findings: readonly {
    readonly verdict: VerificationFinding["verdict"];
    readonly described: boolean;
    readonly confidence: number | undefined;
  }[];
  readonly round: number;
  /** Compliance outcome per platform, aligned with `PLATFORMS`. */
  readonly compliancePassed: readonly boolean[];
  readonly categoryCount: number;
}

const caseSpecArb: fc.Arbitrary<CaseSpec> = fc.record({
  text: textArb,
  breakdown: breakdownArb,
  scored: fc.boolean(),
  // Zero findings is a required edge case, so the minimum length is 0.
  findings: fc.array(findingArb, { minLength: 0, maxLength: 4 }),
  round: fc.integer({ min: 1, max: 5 }),
  compliancePassed: fc
    .array(fc.boolean(), { minLength: 3, maxLength: 3 })
    // At least one platform passes so every case also exercises the
    // approval/delivery path; each platform still sees both outcomes.
    .map((flags) => (flags.some(Boolean) ? flags : [true, ...flags.slice(1)])),
  categoryCount: fc.integer({ min: 1, max: 5 }),
});

interface CaseRecords {
  readonly topic: Topic;
  readonly run: PipelineRun;
  readonly research: ResearchResult;
  readonly revision: DraftRevision;
  readonly report: VerificationReport;
  readonly artifacts: readonly PlatformArtifact[];
  readonly compliance: readonly ComplianceResult[];
  readonly approval: ApprovalRecord;
  readonly delivery: DeliveryRecord;
}

function buildRecords(spec: CaseSpec): CaseRecords {
  const text = spec.text;
  const sourceRef = {
    sourceId: label("nguồn", text),
    captureId: label("bản-chụp", text),
    url: `https://example.test/${encodeURIComponent("nguồn")}?q=${encodeURIComponent(text)}`,
    capturedAt: CREATED,
    termsVersion: label("điều-khoản-v1", text),
  };
  const total = spec.breakdown.reduce(
    (sum, item) => sum + (item.componentValue * item.weightPercent) / 100,
    0,
  );
  const topic: Topic = {
    id: "topic-1",
    sourceRef,
    externalId: label("external", text),
    title: label("Chủ đề", text),
    createdAt: CREATED,
    score: {
      total: spec.scored ? Math.min(100, total) : null,
      breakdown: spec.breakdown,
      scoringConfigVersion: label("score-v1", text),
      ...(spec.scored
        ? {}
        : { unscoredReason: label("Thiếu dữ liệu đầu vào", text) }),
    },
    categories: Array.from({ length: spec.categoryCount }, (_, index) =>
      label(`hạng-mục-${index}`, text),
    ),
  };

  const research: ResearchResult = {
    id: "research-1",
    topicId: topic.id,
    items: [
      {
        id: label("item-1", text),
        content: label("Nội dung tổng hợp", text),
        kind: "Quoted",
        evidenceRefs: [sourceRef],
      },
      {
        id: label("item-2", text),
        content: label("Suy luận của mô hình", text),
        kind: "Inferred",
        evidenceRefs: [sourceRef],
        modelProvenance: {
          provider: label("provider-a", text),
          model: label("model-a", text),
          promptVersion: label("prompt-v1", text),
          configurationVersion: label("config-v1", text),
          confidence: 0.5,
        },
      },
    ],
    status: "Ok",
    unreachableSources: [],
  };

  const contentHash = `content-hash-${encodeURIComponent(text).slice(0, 24)}`;
  const revision: DraftRevision = {
    id: "revision-1",
    draftId: "draft-1",
    revision: 1,
    content: {
      topicId: topic.id,
      facebookPost: label("Bài đăng Facebook", text),
      guide: [
        {
          heading: label("Phần mở đầu", text),
          body: label("Nội dung hướng dẫn", text),
          imageSuggestions: [{ description: label("Ảnh minh họa", text) }],
        },
        {
          heading: label("Phần thân", text),
          body: label("Chi tiết kỹ thuật", text),
          imageSuggestions: [{ description: label("Sơ đồ", text) }],
        },
      ],
      videoScript: {
        intro: label("Mở đầu", text),
        body: label("Nội dung chính", text),
        conclusion: label("Kết luận", text),
      },
      originLinks: [sourceRef.url],
      language: "vi",
      brandVoiceVersion: label("brand-v1", text),
    },
    contentHash,
    createdBy: "System",
    createdAt: CREATED,
  };

  const findings: readonly VerificationFinding[] = spec.findings.map(
    (finding, index) => ({
      claimId: label(`claim-${index}`, text),
      verdict: finding.verdict,
      evidenceRefs: [sourceRef],
      ...(finding.described
        ? { description: label("Mô tả mâu thuẫn", text) }
        : {}),
      ...(finding.confidence === undefined
        ? {}
        : { confidence: finding.confidence }),
    }),
  );
  const report: VerificationReport = {
    id: "report-1",
    draftRevisionId: revision.id,
    contentHash: revision.contentHash,
    researchResultId: research.id,
    round: spec.round,
    modelB: {
      provider: label("provider-b", text),
      model: label("model-b", text),
      promptVersion: label("prompt-v2", text),
      configurationVersion: label("config-v2", text),
    },
    findings,
    // Zero findings means nothing contradicts the research corpus.
    passed: findings.every((finding) => finding.verdict === "Pass"),
  };

  const artifacts: readonly PlatformArtifact[] = PLATFORMS.map(
    (platform, index) => ({
      id: `artifact-${index}`,
      draftRevisionId: revision.id,
      platform,
      rendererVersion: label("renderer-v1", text),
      body: label(`Nội dung ${platform}`, text),
      metadata: {
        tiêu_đề: label("Tiêu đề", text),
        [label("khóa", text)]: label("giá trị", text),
      },
      attribution: label("Nguồn", text),
      imageSuggestions: [{ description: label("Ảnh bìa", text) }],
      artifactHash: `artifact-hash-${index}-${encodeURIComponent(text).slice(0, 16)}`,
      createdAt: CREATED,
    }),
  );

  const compliance: readonly ComplianceResult[] = artifacts.map(
    (artifact, index) => {
      const passed = spec.compliancePassed[index] === true;
      return {
        id: `compliance-${index}`,
        artifactId: artifact.id,
        artifactHash: artifact.artifactHash,
        draftRevisionId: revision.id,
        platform: artifact.platform,
        ruleSetVersion: label("rules-v1", text),
        sourceTermsVersions: [sourceRef.termsVersion],
        evaluatorVersion: label("evaluator-v1", text),
        passed,
        violatedRuleIds: passed ? [] : [label(`rule-${index}`, text)],
        attributionOk: passed,
        copyrightOk: passed,
        reasons: passed
          ? [label("Đạt toàn bộ quy tắc", text)]
          : [label("Vi phạm quy tắc", text), label("Rủi ro bản quyền", text)],
        checkedAt: CREATED,
      };
    },
  );

  const approvedArtifacts = artifacts.filter(
    (_, index) => compliance[index]!.passed,
  );
  const approval: ApprovalRecord = {
    id: "approval-1",
    pipelineRunId: "run-1",
    draftRevisionId: revision.id,
    contentHash: revision.contentHash,
    approvedArtifactIds: approvedArtifacts.map((artifact) => artifact.id),
    approvedArtifactHashes: approvedArtifacts.map(
      (artifact) => artifact.artifactHash,
    ),
    operatorId: label("operator-1", text),
    approvedAt: STAMP,
  };

  const delivered = approvedArtifacts[0]!;
  const delivery: DeliveryRecord = {
    id: "delivery-1",
    kind: "Export",
    platform: delivered.platform,
    targetId: label("target-1", text),
    approvalId: approval.id,
    artifactId: delivered.id,
    artifactHash: delivered.artifactHash,
    idempotencyKey: `Export:${delivered.id}:${delivered.artifactHash}`,
    status: "Exported",
    attempts: 1,
    exportBundle: {
      id: "bundle-1",
      platform: delivered.platform,
      targetId: label("target-1", text),
      approvalId: approval.id,
      artifactId: delivered.id,
      artifactHash: delivered.artifactHash,
      rendererVersion: delivered.rendererVersion,
      body: delivered.body,
      metadata: delivered.metadata,
      attribution: delivered.attribution,
      imageSuggestions: delivered.imageSuggestions,
      createdAt: STAMP,
    },
    createdAt: STAMP,
    updatedAt: STAMP,
  };

  const run: PipelineRun = {
    id: "run-1",
    topicId: topic.id,
    stage: "Collected",
    workStatus: "Ready",
    version: 0,
    categories: topic.categories,
    createdAt: CREATED,
    updatedAt: CREATED,
  };

  return {
    topic,
    run,
    research,
    revision,
    report,
    artifacts,
    compliance,
    approval,
    delivery,
  };
}

function prepareTransition(records: CaseRecords): GuardedTransitionCommand {
  return {
    pipelineRunId: records.run.id,
    expectedVersion: 0,
    expectedStage: "Collected",
    expectedStatus: "Ready",
    nextStage: "PendingApproval",
    nextStatus: "Ready",
    nextActiveDraftRevisionId: records.revision.id,
    actorType: "System",
    artifactRevisionId: records.revision.id,
    records: {
      researchResults: [records.research],
      draftRevisions: [records.revision],
      verificationReports: [records.report],
      platformArtifacts: records.artifacts,
      complianceResults: records.compliance,
    },
    idempotencyKey: "prepare-review",
  };
}

function approveTransition(records: CaseRecords): GuardedTransitionCommand {
  return {
    pipelineRunId: records.run.id,
    expectedVersion: 1,
    expectedStage: "PendingApproval",
    expectedStatus: "Ready",
    nextStage: "Approved",
    nextStatus: "Ready",
    nextActiveDraftRevisionId: records.revision.id,
    actorType: "Operator",
    actorId: records.approval.operatorId,
    artifactRevisionId: records.revision.id,
    records: { approvals: [records.approval], deliveries: [records.delivery] },
    idempotencyKey: "approve-and-export",
  };
}

function rejectTransition(
  records: CaseRecords,
  expectedVersion: number,
  expectedStage: GuardedTransitionCommand["expectedStage"],
): GuardedTransitionCommand {
  return {
    pipelineRunId: records.run.id,
    expectedVersion,
    expectedStage,
    expectedStatus: "Ready",
    nextStage: "Rejected",
    nextStatus: "Rejected",
    blockedReason: `[${expectedStage}] ${label("Operator từ chối", records.topic.title)}`,
    actorType: "Operator",
    actorId: records.approval.operatorId,
    reason: label("Ghi chú từ chối", records.topic.title),
    artifactRevisionId: records.revision.id,
    records: {},
    idempotencyKey: "reject-run",
  };
}

/** Key-order-independent serialisation so extra or missing fields both fail. */
function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, sortDeep(source[key])]),
    );
  }
  return value;
}

/** Deep equality plus a canonical-JSON check that no field was dropped. */
function expectExact<T>(actual: T | undefined, expected: T): void {
  expect(actual).toEqual(expected);
  expect(canonical(actual)).toBe(canonical(expected));
}

function rawPayload(
  database: Database.Database,
  table: string,
  id: string,
): string {
  const row = database
    .prepare(`SELECT payload FROM ${table} WHERE id = ?`)
    .get(id) as { payload: string } | undefined;
  expect(row).toBeDefined();
  return row!.payload;
}

/** The stored text is JSON: no literal NUL leaks into the SQLite column. */
function expectStoredJson(
  database: Database.Database,
  table: string,
  id: string,
  expected: unknown,
): void {
  const payload = rawPayload(database, table, id);
  expect(payload.includes("\u0000")).toBe(false);
  expect(canonical(JSON.parse(payload))).toBe(canonical(expected));
}

describe("SqliteRepository explainability persistence properties", () => {
  // Feature: fb-ai, Property 33: Explainability artifacts persist with their draft/topic
  it("Property 33: score breakdowns, verification reports, and compliance results survive guarded transitions and rejection", async () => {
    await fc.assert(
      fc.asyncProperty(caseSpecArb, async (spec) => {
        const records = buildRecords(spec);
        const database = new Database(":memory:");
        const repository = new SqliteRepository(database, { now: () => STAMP });
        try {
          expectExact(
            await repository.createPipelineRun({
              run: records.run,
              topic: records.topic,
              idempotencyKey: "create-run",
            }),
            records.run,
          );

          const prepared = await repository.commitGuardedTransition(
            prepareTransition(records),
          );
          expect(prepared.kind).toBe("Applied");
          expect(prepared).toMatchObject({
            run: {
              stage: "PendingApproval",
              version: 1,
              activeDraftRevisionId: records.revision.id,
            },
          });

          // Explainability artifacts are retrievable alongside their topic/draft.
          expectExact(await repository.getTopic(records.topic.id), records.topic);
          expectExact(
            await repository.getResearchResult(records.research.id),
            records.research,
          );
          expectExact(
            await repository.getDraftRevision(records.revision.id),
            records.revision,
          );
          expectExact(
            await repository.getVerificationReport(records.report.id),
            records.report,
          );
          expectExact(
            await repository.listVerificationReportsByDraftRevision(
              records.revision.id,
            ),
            [records.report],
          );
          expectExact(
            await repository.listPlatformArtifactsByDraftRevision(
              records.revision.id,
            ),
            records.artifacts,
          );
          expectExact(
            await repository.listComplianceResultsByDraftRevision(
              records.revision.id,
            ),
            records.compliance,
          );
          for (const result of records.compliance) {
            expectExact(await repository.getComplianceResult(result.id), result);
          }
          expectStoredJson(database, "topics", records.topic.id, records.topic);
          expectStoredJson(
            database,
            "verification_reports",
            records.report.id,
            records.report,
          );
          expectStoredJson(
            database,
            "compliance_results",
            records.compliance[0]!.id,
            records.compliance[0],
          );

          // Approval and delivery keep their exact hashes and payloads.
          const approved = await repository.commitGuardedTransition(
            approveTransition(records),
          );
          expect(approved).toMatchObject({
            kind: "Applied",
            run: { stage: "Approved", version: 2 },
          });
          expectExact(
            await repository.getApproval(records.approval.id),
            records.approval,
          );
          expectExact(
            await repository.getDelivery(records.delivery.id),
            records.delivery,
          );
          expectExact(
            await repository.getDeliveryByIdempotencyKey(
              records.delivery.idempotencyKey,
            ),
            records.delivery,
          );

          // Unique delivery idempotency key: a replay returns the original.
          const replayedDelivery = await repository.recordDelivery({
            ...records.delivery,
            id: "delivery-duplicate",
            status: "Failed",
            attempts: 2,
          });
          expect(replayedDelivery.replayed).toBe(true);
          expectExact(replayedDelivery.record, records.delivery);
          expectExact(
            await repository.listDeliveriesByApproval(records.approval.id),
            [records.delivery],
          );
          expect(() =>
            database
              .prepare(
                "INSERT INTO deliveries (id, approval_id, artifact_id, artifact_hash, platform, idempotency_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
              )
              .run(
                "delivery-raw-duplicate",
                records.approval.id,
                records.delivery.artifactId,
                records.delivery.artifactHash,
                records.delivery.platform,
                records.delivery.idempotencyKey,
                JSON.stringify(records.delivery),
              ),
          ).toThrow(/UNIQUE/i);

          // A rejection record never overwrites or deletes existing draft data.
          const rejected = await repository.commitGuardedTransition(
            rejectTransition(records, 2, "Approved"),
          );
          expect(rejected).toMatchObject({
            kind: "Applied",
            run: {
              stage: "Rejected",
              workStatus: "Rejected",
              version: 3,
              activeDraftRevisionId: records.revision.id,
            },
          });
          expectExact(await repository.getTopic(records.topic.id), records.topic);
          expectExact(
            await repository.getDraftRevision(records.revision.id),
            records.revision,
          );
          expectExact(
            await repository.getVerificationReport(records.report.id),
            records.report,
          );
          expectExact(
            await repository.listComplianceResultsByDraftRevision(
              records.revision.id,
            ),
            records.compliance,
          );
          expectExact(
            await repository.getApproval(records.approval.id),
            records.approval,
          );
          expectExact(
            await repository.getDelivery(records.delivery.id),
            records.delivery,
          );

          // Unique transition idempotency key per run: the replay returns the
          // original result instead of applying the transition twice.
          const replay = await repository.commitGuardedTransition(
            rejectTransition(records, 2, "Approved"),
          );
          expect(replay).toEqual({
            ...(rejected as Exclude<typeof rejected, { kind: "Conflict" }>),
            kind: "Replayed",
          });
          expect(await repository.listTransitions(records.run.id)).toHaveLength(3);
          expect(
            (await repository.getPipelineRun(records.run.id))?.version,
          ).toBe(3);
          expect(() =>
            database
              .prepare(
                "INSERT INTO pipeline_transitions (id, pipeline_run_id, from_stage, to_stage, from_status, to_status, idempotency_key, payload, result_run_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              )
              .run(
                "transition-raw-duplicate",
                records.run.id,
                "Approved",
                "Rejected",
                "Ready",
                "Rejected",
                "reject-run",
                "{}",
                "{}",
              ),
          ).toThrow(/UNIQUE/i);

          // Optimistic locking on PipelineRun.version: a command whose stage and
          // status match but whose version is stale changes nothing at all.
          const staleVersion = await repository.commitGuardedTransition({
            ...rejectTransition(records, 2, "Rejected"),
            expectedStatus: "Rejected",
            nextStage: "Approved",
            nextStatus: "Ready",
            records: {
              draftRevisions: [
                {
                  ...records.revision,
                  id: "revision-stale-version",
                  draftId: "draft-stale-version",
                  contentHash: `${records.revision.contentHash}-stale-version`,
                },
              ],
            },
            idempotencyKey: "stale-version-write",
          });
          expectExact(staleVersion, {
            kind: "Conflict",
            current: (
              rejected as Exclude<typeof rejected, { kind: "Conflict" }>
            ).run,
          });
          expect(
            await repository.getDraftRevision("revision-stale-version"),
          ).toBeUndefined();
          expect(
            (await repository.getPipelineRun(records.run.id))?.stage,
          ).toBe("Rejected");

          // A stale stage/status guard is likewise rejected without side effects.
          const stale = await repository.commitGuardedTransition({
            ...prepareTransition(records),
            records: {
              draftRevisions: [
                {
                  ...records.revision,
                  id: "revision-stale",
                  draftId: "draft-stale",
                  contentHash: `${records.revision.contentHash}-stale`,
                },
              ],
            },
            idempotencyKey: "stale-write",
          });
          expect(stale.kind).toBe("Conflict");
          expect(await repository.getDraftRevision("revision-stale")).toBeUndefined();
          expect(
            (await repository.getPipelineRun(records.run.id))?.version,
          ).toBe(3);
          expect(await repository.listTransitions(records.run.id)).toHaveLength(3);

          // Unique (draft_id, revision) rejects a second revision 1 of the draft.
          await expect(
            repository.commitGuardedTransition({
              ...prepareTransition(records),
              expectedVersion: 3,
              expectedStage: "Rejected",
              expectedStatus: "Rejected",
              records: {
                draftRevisions: [
                  {
                    ...records.revision,
                    id: "revision-duplicate",
                    contentHash: `${records.revision.contentHash}-duplicate`,
                  },
                ],
              },
              idempotencyKey: "duplicate-revision",
            }),
          ).rejects.toThrow();
          expect(
            await repository.getDraftRevision("revision-duplicate"),
          ).toBeUndefined();
          expectExact(
            await repository.getDraftRevision(records.revision.id),
            records.revision,
          );
          expect(await repository.listTransitions(records.run.id)).toHaveLength(3);

          // One active revision per run, bound to a persisted revision row.
          const activeRows = database
            .prepare(
              "SELECT active_draft_revision_id AS id FROM pipeline_runs WHERE id = ?",
            )
            .all(records.run.id) as { id: string | null }[];
          expect(activeRows).toEqual([{ id: records.revision.id }]);
          expect(() =>
            database
              .prepare(
                "UPDATE pipeline_runs SET active_draft_revision_id = ? WHERE id = ?",
              )
              .run("revision-missing", records.run.id),
          ).toThrow();
        } finally {
          repository.close();
        }
      }),
      RUNS,
    );
  });
});

describe("SqliteRepository explainability persistence integration", () => {
  it("reloads score breakdowns, verification reports, and compliance results from a real SQLite file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fb-ai-repository-"));
    const file = join(directory, "repository.sqlite");
    const spec: CaseSpec = {
      text: `Tiếng Việt có dấu đầy đủ | công cụ AI mới nhất ${JSON_STRESS}`,
      breakdown: [
        { criterionId: "độ-mới", componentValue: 0, weightPercent: 25 },
        { criterionId: "uy-tín", componentValue: 100, weightPercent: 25 },
        { criterionId: `liên-quan ${JSON_STRESS}`, componentValue: 73, weightPercent: 50 },
      ],
      scored: true,
      findings: [
        { verdict: "Pass", described: false, confidence: 1 },
        { verdict: "Contradiction", described: true, confidence: 0 },
        { verdict: "Unsupported", described: true, confidence: undefined },
      ],
      round: 2,
      compliancePassed: [true, false, true],
      categoryCount: 3,
    };
    const records = buildRecords(spec);
    const writer = new SqliteRepository(file, { now: () => STAMP });
    try {
      await writer.createPipelineRun({
        run: records.run,
        topic: records.topic,
        idempotencyKey: "create-run",
      });
      const prepared = await writer.commitGuardedTransition(
        prepareTransition(records),
      );
      expect(prepared).toMatchObject({ kind: "Applied", run: { version: 1 } });
      const approved = await writer.commitGuardedTransition(
        approveTransition(records),
      );
      expect(approved).toMatchObject({ kind: "Applied", run: { version: 2 } });
    } finally {
      writer.close();
    }

    // A second handle re-opens the same file and re-runs migrations idempotently.
    const reader = new SqliteRepository(file, { now: () => STAMP });
    try {
      const topic = await reader.getTopic(records.topic.id);
      expectExact(topic, records.topic);
      expectExact(topic?.score.breakdown, records.topic.score.breakdown);
      expect(topic?.score.breakdown.map((item) => item.componentValue)).toEqual([
        0, 100, 73,
      ]);

      expectExact(
        await reader.getVerificationReport(records.report.id),
        records.report,
      );
      expectExact(
        await reader.listVerificationReportsByDraftRevision(records.revision.id),
        [records.report],
      );
      expectExact(
        await reader.listComplianceResultsByDraftRevision(records.revision.id),
        records.compliance,
      );
      for (const result of records.compliance) {
        expectExact(await reader.getComplianceResult(result.id), result);
      }
      expect(
        (
          await reader.listComplianceResultsByDraftRevision(records.revision.id)
        ).map((result) => [result.platform, result.passed]),
      ).toEqual([
        ["Facebook_Page", true],
        ["Facebook_Group", false],
        ["YouTube", true],
      ]);
      expectExact(
        await reader.getDraftRevision(records.revision.id),
        records.revision,
      );
      expectExact(
        await reader.listPlatformArtifactsByDraftRevision(records.revision.id),
        records.artifacts,
      );
      expectExact(await reader.getApproval(records.approval.id), records.approval);
      expectExact(await reader.getDelivery(records.delivery.id), records.delivery);
      expectExact(
        await reader.getDeliveryByIdempotencyKey(records.delivery.idempotencyKey),
        records.delivery,
      );
      expect(await reader.listTransitions(records.run.id)).toHaveLength(2);
    } finally {
      reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
