import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { InMemoryRepository } from "../src/adapters/in-memory-repository.js";
import type { Repository } from "../src/adapters/ports.js";
import type {
  DraftRevision,
  ImageSuggestion,
  PlatformArtifact,
  TargetPlatform,
  Topic,
} from "../src/domain/content.js";
import type {
  ApprovalRecord,
  DeliveryCommand,
  PipelineRun,
  WorkflowStage,
  WorkStatus,
} from "../src/domain/workflow.js";
import { CopyReadyExporter } from "../src/output/copy-ready-exporter.js";
import { createPhase1OutputPort } from "../src/output/index.js";

/**
 * Property test for the Phase 1 OutputPort (task 13.2).
 *
 * Interpretation notes:
 * - "Platform-correct" for Phase 1 means the bundle carries the already approved
 *   artifact body plus origin attribution for Facebook_Page/Facebook_Group, and
 *   additionally requires title/description/tags metadata for YouTube
 *   (design.md "Output port and delivery records" + tasks.md 13.1).
 * - "Copy-ready" bytes are the immutable approved artifact fields. The exporter
 *   must never re-render, so the property also asserts the exporter never reads a
 *   mutable draft revision and never changes the stored artifact.
 * - Error-code precedence follows the documented gate order: command validity →
 *   approval/run state → exact approved artifact + hash → copy-ready content.
 */

const CREATED = "2025-05-01T10:00:00.000Z";
const EXPORTED = "2025-05-01T11:00:00.000Z";

const RUN_ID = "run-export";
const TOPIC_ID = "topic-export";
const REVISION_ID = "revision-export";
const REVISION_HASH = "content-hash-export";
const APPROVAL_ID = "approval-export";
const OPERATOR_ID = "operator-export";

const PLATFORMS = [
  "Facebook_Page",
  "Facebook_Group",
  "YouTube",
] as const satisfies readonly TargetPlatform[];

const YOUTUBE_METADATA_FIELDS = ["title", "description", "tags"] as const;

const NON_APPROVED_STAGES = [
  "Collected",
  "Scored",
  "Researched",
  "Generated",
  "Verified",
  "ComplianceChecked",
  "PendingApproval",
  "Rejected",
] as const satisfies readonly WorkflowStage[];

/** Vietnamese, astral emoji, ZWJ sequences, and plain ASCII in one pool. */
const TEXT_CHUNKS = [
  "AI update",
  "Cập nhật công cụ AI mới nhất",
  "🚀",
  "👩‍💻🧠",
  "ảnh minh hoạ từng bước",
  "🇻🇳 tóm tắt",
  "Nguồn: https://origin.example/ai-update",
] as const;

const BLANK_TEXTS = ["", " ", "\t\n  ", "\n"] as const;

const filledText = fc
  .array(fc.constantFrom(...TEXT_CHUNKS), { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join(" "));

/** Covers empty, whitespace-only, and non-ASCII/astral filled text. */
const maybeBlankText = fc.oneof(
  { weight: 6, arbitrary: filledText },
  { weight: 2, arbitrary: fc.constantFrom(...BLANK_TEXTS) },
);

/** Each YouTube metadata field is present-and-filled, present-but-blank, or absent. */
const metadataArb = fc
  .record({
    title: fc.option(maybeBlankText, { nil: undefined }),
    description: fc.option(maybeBlankText, { nil: undefined }),
    tags: fc.option(maybeBlankText, { nil: undefined }),
    "chủ_đề🚀": fc.option(filledText, { nil: undefined }),
  })
  .map((fields) => {
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) metadata[key] = value;
    }
    return metadata;
  });

interface ArtifactSpec {
  readonly platform: TargetPlatform;
  readonly rendererVersion: string;
  readonly body: string;
  readonly attribution: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly imageSuggestions: readonly ImageSuggestion[];
  readonly inApproval: boolean;
}

const artifactSpecArb: fc.Arbitrary<ArtifactSpec> = fc.record({
  platform: fc.constantFrom(...PLATFORMS),
  rendererVersion: fc.constantFrom("renderer-v1", "renderer-v2🚀", "renderer-vi"),
  body: maybeBlankText,
  attribution: maybeBlankText,
  metadata: metadataArb,
  imageSuggestions: fc.array(
    fc.record({ description: maybeBlankText }),
    { maxLength: 2 },
  ),
  inApproval: fc.oneof(
    { weight: 5, arbitrary: fc.constant(true) },
    { weight: 1, arbitrary: fc.constant(false) },
  ),
});

/** Approved is over-weighted so success paths are exercised, but every stage occurs. */
const stageArb: fc.Arbitrary<WorkflowStage> = fc.oneof(
  { weight: NON_APPROVED_STAGES.length, arbitrary: fc.constant<WorkflowStage>("Approved") },
  { weight: NON_APPROVED_STAGES.length, arbitrary: fc.constantFrom(...NON_APPROVED_STAGES) },
);

interface Scenario {
  readonly stage: WorkflowStage;
  readonly artifacts: readonly ArtifactSpec[];
  readonly targetPick: number;
  readonly hashMode: "match" | "mismatch" | "blank";
  readonly targetId: string;
  readonly idempotencyKey: string;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  stage: stageArb,
  artifacts: fc.array(artifactSpecArb, { minLength: 1, maxLength: 3 }),
  targetPick: fc.nat({ max: 8 }),
  hashMode: fc.oneof(
    { weight: 6, arbitrary: fc.constant<"match">("match") },
    { weight: 2, arbitrary: fc.constant<"mismatch">("mismatch") },
    { weight: 1, arbitrary: fc.constant<"blank">("blank") },
  ),
  targetId: fc.oneof(
    { weight: 7, arbitrary: fc.constantFrom("target-page", "nhóm-🚀", "kênh-youtube") },
    { weight: 1, arbitrary: fc.constantFrom(...BLANK_TEXTS) },
  ),
  idempotencyKey: fc.constantFrom("key-a", "khóa-🚀", "export-key-1"),
});

// ---------------------------------------------------------------------------
// Pinned examples
//
// The coverage guard at the end of the property demands one occurrence of every
// label in `required`. Some of those labels need a rare conjunction of draws
// (`exported:YouTube` needs stage Approved + platform YouTube + inApproval +
// hashMode "match" + non-blank body and attribution + all three YouTube
// metadata fields filled at once), so relying on the random generator makes the
// guard seed-dependent and flaky. Every required label is therefore produced by
// an explicit example below, which makes coverage deterministic on every seed
// and independent of `numRuns`; the random runs remain as extra exploration.
// ---------------------------------------------------------------------------

function spec(overrides: Partial<ArtifactSpec> = {}): ArtifactSpec {
  return {
    platform: "Facebook_Page",
    rendererVersion: "renderer-v1",
    body: "Cập nhật công cụ AI mới nhất 🚀",
    attribution: "Nguồn: https://origin.example/ai-update",
    metadata: {},
    imageSuggestions: [],
    inApproval: true,
    ...overrides,
  };
}

/** All three YouTube metadata fields present and non-blank. */
const YOUTUBE_METADATA_FILLED: Readonly<Record<string, string>> = {
  title: "Cập nhật công cụ AI mới nhất",
  description: "ảnh minh hoạ từng bước 👩‍💻🧠",
  tags: "AI update",
};

/** All three present but whitespace-only. */
const YOUTUBE_METADATA_BLANK: Readonly<Record<string, string>> = {
  title: "",
  description: " ",
  tags: "\t\n  ",
};

function pinned(overrides: Partial<Scenario> = {}): [Scenario] {
  return [
    {
      stage: "Approved",
      artifacts: [spec()],
      targetPick: 0,
      hashMode: "match",
      targetId: "target-page",
      idempotencyKey: "key-a",
      ...overrides,
    },
  ];
}

const EXPORT_EXAMPLES: readonly [Scenario][] = [
  // outcome:CONTENT_NOT_APPROVED plus every non-Approved stage label.
  ...NON_APPROVED_STAGES.map((stage) => pinned({ stage })),

  // outcome:Exported, approved:true, hash:match and one label per platform.
  ...PLATFORMS.map((platform) =>
    pinned({
      artifacts: [
        spec({
          platform,
          metadata:
            platform === "YouTube" ? YOUTUBE_METADATA_FILLED : { "chủ_đề🚀": "AI" },
        }),
      ],
      targetId: platform === "YouTube" ? "kênh-youtube" : "nhóm-🚀",
    }),
  ),

  // hash:mismatch -> APPROVAL_ARTIFACT_MISMATCH on an otherwise valid export.
  ...[pinned({ hashMode: "mismatch" })],

  // hash:blank -> outcome:INVALID_DELIVERY_COMMAND (blank command hash).
  ...[pinned({ hashMode: "blank" })],

  // A blank targetId is the other INVALID_DELIVERY_COMMAND route.
  ...[pinned({ targetId: "   " })],

  // approved:false -> the artifact exists but is not in the approval record.
  ...[pinned({ artifacts: [spec({ inApproval: false })] })],

  // outcome:ARTIFACT_NOT_COPY_READY via a blank body, and via a blank attribution.
  ...[pinned({ artifacts: [spec({ body: "" })] })],
  ...[pinned({ artifacts: [spec({ attribution: "\t\n  " })] })],

  // youtube:<field>:blank and youtube:<field>:absent for all three fields.
  ...[pinned({ artifacts: [spec({ platform: "YouTube", metadata: YOUTUBE_METADATA_BLANK })] })],
  ...[pinned({ artifacts: [spec({ platform: "YouTube", metadata: {} })] })],
];

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function statusFor(stage: WorkflowStage): WorkStatus {
  return stage === "Rejected" ? "Rejected" : "Ready";
}

const topic: Topic = {
  id: TOPIC_ID,
  sourceRef: {
    sourceId: "source-export",
    captureId: "capture-export",
    url: "https://origin.example/ai-update",
    capturedAt: CREATED,
    termsVersion: "terms-v1",
  },
  externalId: "external-export",
  title: "AI update",
  createdAt: CREATED,
  score: { total: 90, breakdown: [], scoringConfigVersion: "score-v1" },
  categories: ["AI Tools"],
};

const revision: DraftRevision = {
  id: REVISION_ID,
  draftId: "draft-export",
  revision: 1,
  content: {
    topicId: TOPIC_ID,
    facebookPost: "Nội dung nguồn có thể thay đổi và KHÔNG được đọc khi xuất bản.",
    guide: [],
    videoScript: { intro: "Mở đầu", body: "Nội dung chính", conclusion: "Kết luận" },
    originLinks: [topic.sourceRef.url],
    language: "vi",
  },
  contentHash: REVISION_HASH,
  createdBy: "System",
  createdAt: CREATED,
};

function artifactsFor(specs: readonly ArtifactSpec[]): readonly PlatformArtifact[] {
  return specs.map((spec, index) => ({
    id: `artifact-${index}`,
    draftRevisionId: REVISION_ID,
    platform: spec.platform,
    rendererVersion: spec.rendererVersion,
    body: spec.body,
    metadata: spec.metadata,
    attribution: spec.attribution,
    imageSuggestions: spec.imageSuggestions,
    artifactHash: `artifact-hash-${index}`,
    createdAt: CREATED,
  }));
}

function initialRun(): PipelineRun {
  return {
    id: RUN_ID,
    topicId: TOPIC_ID,
    stage: "Collected",
    workStatus: "Ready",
    version: 0,
    categories: ["AI Tools"],
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

/** Records draft reads so the property can prove the exporter never re-renders. */
function trackDraftReads(repository: Repository): {
  readonly tracked: Repository;
  readonly draftReads: string[];
} {
  const draftReads: string[] = [];
  const tracked = new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (property === "getDraftRevision") draftReads.push(String(args[0]));
        return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as Repository;
  return { tracked, draftReads };
}

async function seed(
  scenario: Scenario,
): Promise<{ repository: InMemoryRepository; approval: ApprovalRecord; artifacts: readonly PlatformArtifact[] }> {
  const repository = new InMemoryRepository({ now: () => CREATED });
  const artifacts = artifactsFor(scenario.artifacts);
  const approvedArtifacts = artifacts.filter(
    (_artifact, index) => scenario.artifacts[index]!.inApproval,
  );
  const approval: ApprovalRecord = {
    id: APPROVAL_ID,
    pipelineRunId: RUN_ID,
    draftRevisionId: REVISION_ID,
    contentHash: REVISION_HASH,
    approvedArtifactIds: approvedArtifacts.map((artifact) => artifact.id),
    approvedArtifactHashes: approvedArtifacts.map(
      (artifact) => artifact.artifactHash,
    ),
    operatorId: OPERATOR_ID,
    approvedAt: CREATED,
  };

  await repository.createPipelineRun({
    run: initialRun(),
    topic,
    idempotencyKey: "create-export-run",
  });
  const outcome = await repository.commitGuardedTransition({
    pipelineRunId: RUN_ID,
    expectedVersion: 0,
    expectedStage: "Collected",
    expectedStatus: "Ready",
    nextStage: scenario.stage,
    nextStatus: statusFor(scenario.stage),
    nextActiveDraftRevisionId: REVISION_ID,
    actorType: "Operator",
    actorId: OPERATOR_ID,
    artifactRevisionId: REVISION_ID,
    records: {
      draftRevisions: [revision],
      platformArtifacts: artifacts,
      approvals: [approval],
    },
    idempotencyKey: `prepare-${scenario.stage}`,
  });
  expect(outcome.kind).toBe("Applied");
  return { repository, approval, artifacts };
}

function commandHashFor(
  artifact: PlatformArtifact,
  hashMode: Scenario["hashMode"],
): string {
  if (hashMode === "match") return artifact.artifactHash;
  if (hashMode === "blank") return "  ";
  return `${artifact.artifactHash}-mutated`;
}

/** Expected typed error code, or undefined when the export must succeed. */
function expectedErrorCode(
  scenario: Scenario,
  approval: ApprovalRecord,
  artifact: PlatformArtifact,
  commandHash: string,
): string | undefined {
  if (!hasText(scenario.targetId) || !hasText(commandHash)) {
    return "INVALID_DELIVERY_COMMAND";
  }
  if (scenario.stage !== "Approved") return "CONTENT_NOT_APPROVED";
  const index = approval.approvedArtifactIds.indexOf(artifact.id);
  if (
    index < 0 ||
    approval.approvedArtifactHashes[index] !== commandHash ||
    artifact.artifactHash !== commandHash
  ) {
    return "APPROVAL_ARTIFACT_MISMATCH";
  }
  if (!hasText(artifact.body) || !hasText(artifact.attribution)) {
    return "ARTIFACT_NOT_COPY_READY";
  }
  if (
    artifact.platform === "YouTube" &&
    !YOUTUBE_METADATA_FIELDS.every((field) => hasText(artifact.metadata[field]))
  ) {
    return "ARTIFACT_NOT_COPY_READY";
  }
  return undefined;
}

function sameBytes(actual: string, expected: string): void {
  expect(actual).toBe(expected);
  expect(
    Buffer.from(actual, "utf8").equals(Buffer.from(expected, "utf8")),
  ).toBe(true);
}

describe("CopyReadyExporter properties", () => {
  // Feature: fb-ai, Property 32: Export produces platform-correct, attributed, copy-ready content
  it("exports only exact approved artifacts as byte-identical, attributed, idempotent bundles", async () => {
    /** Guards against a vacuous run: every generated class must actually occur. */
    const seen = new Set<string>();

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { repository, approval, artifacts } = await seed(scenario);
        const artifact = artifacts[scenario.targetPick % artifacts.length]!;
        const commandHash = commandHashFor(artifact, scenario.hashMode);
        const command: DeliveryCommand = {
          approvalId: approval.id,
          artifactId: artifact.id,
          artifactHash: commandHash,
          targetId: scenario.targetId,
          idempotencyKey: scenario.idempotencyKey,
        };
        const { tracked, draftReads } = trackDraftReads(repository);
        const output = createPhase1OutputPort(tracked, { now: () => EXPORTED });
        const reader = new CopyReadyExporter(repository, { now: () => EXPORTED });
        const expectedCode = expectedErrorCode(
          scenario,
          approval,
          artifact,
          commandHash,
        );
        seen.add(`stage:${scenario.stage}`);
        seen.add(`hash:${scenario.hashMode}`);
        seen.add(`outcome:${expectedCode ?? "Exported"}`);
        seen.add(
          `approved:${approval.approvedArtifactIds.includes(artifact.id)}`,
        );
        if (expectedCode === undefined) seen.add(`exported:${artifact.platform}`);
        if (artifact.platform === "YouTube") {
          for (const field of YOUTUBE_METADATA_FIELDS) {
            const value = artifact.metadata[field];
            seen.add(
              `youtube:${field}:${
                value === undefined ? "absent" : hasText(value) ? "filled" : "blank"
              }`,
            );
          }
        }

        const outcome = await output.deliver(command);

        if (expectedCode !== undefined) {
          // Every non-approved state fails with a typed code and no bundle.
          expect(outcome.status).toBe("Failed");
          expect(outcome.errorCode).toBe(expectedCode);
          expect(outcome.errorMessage).toEqual(expect.any(String));
          expect(outcome.errorMessage!.length).toBeGreaterThan(0);
          expect(outcome.exportedBundleId).toBeUndefined();
          expect(
            await repository.getDeliveryByIdempotencyKey(command.idempotencyKey),
          ).toBeUndefined();
          expect(await repository.listDeliveriesByApproval(approval.id)).toEqual([]);
          await expect(output.deliver(command)).resolves.toEqual(outcome);
          expect(draftReads).toEqual([]);
          expect(await repository.getPlatformArtifact(artifact.id)).toEqual(artifact);
          return;
        }

        expect(outcome.status).toBe("Exported");
        expect(outcome.exportedBundleId).toMatch(/^export-[a-f0-9]{64}$/);
        const bundleId = outcome.exportedBundleId!;
        const bundle = await reader.getExportBundle(bundleId);
        expect(bundle).toBeDefined();

        // Byte-identical, attributed, platform-correct copy of the approved artifact.
        sameBytes(bundle!.body, artifact.body);
        sameBytes(bundle!.attribution, artifact.attribution);
        expect(bundle!.metadata).toEqual(artifact.metadata);
        expect(bundle!.rendererVersion).toBe(artifact.rendererVersion);
        expect(bundle!.artifactHash).toBe(artifact.artifactHash);
        expect(bundle!.imageSuggestions).toEqual(artifact.imageSuggestions);
        expect(bundle!.platform).toBe(artifact.platform);
        expect(bundle!.targetId).toBe(command.targetId);
        expect(bundle!.approvalId).toBe(approval.id);
        expect(bundle!.artifactId).toBe(artifact.id);
        expect(bundle!.createdAt).toBe(EXPORTED);
        if (artifact.platform === "YouTube") {
          for (const field of YOUTUBE_METADATA_FIELDS) {
            expect(hasText(bundle!.metadata[field])).toBe(true);
          }
        }

        // No re-render: the mutable draft is never read and the artifact never changes.
        expect(draftReads).toEqual([]);
        expect(await repository.getPlatformArtifact(artifact.id)).toEqual(artifact);

        // Idempotent replay: same key, same bundle id, one logical delivery.
        await expect(output.deliver(command)).resolves.toEqual(outcome);
        expect(await reader.getExportBundle(bundleId)).toEqual(bundle);
        expect(
          (await repository.listDeliveriesByApproval(approval.id)).length,
        ).toBe(1);

        // Same key with different target/artifact values is a conflict, not a second delivery.
        const conflicting: DeliveryCommand = {
          ...command,
          targetId: `${command.targetId}-other`,
        };
        await expect(output.deliver(conflicting)).resolves.toEqual({
          status: "Failed",
          errorCode: "IDEMPOTENCY_CONFLICT",
          errorMessage: "Idempotency key is already bound to another delivery",
        });
        expect(
          (await repository.listDeliveriesByApproval(approval.id)).length,
        ).toBe(1);
        expect(await reader.getExportBundle(bundleId)).toEqual(bundle);
      }),
      { numRuns: 300, examples: [...EXPORT_EXAMPLES] },
    );

    const required = [
      ...NON_APPROVED_STAGES.map((stage) => `stage:${stage}`),
      "stage:Approved",
      "hash:match",
      "hash:mismatch",
      "hash:blank",
      "outcome:Exported",
      "outcome:INVALID_DELIVERY_COMMAND",
      "outcome:CONTENT_NOT_APPROVED",
      "outcome:APPROVAL_ARTIFACT_MISMATCH",
      "outcome:ARTIFACT_NOT_COPY_READY",
      "approved:true",
      "approved:false",
      ...PLATFORMS.map((platform) => `exported:${platform}`),
      ...YOUTUBE_METADATA_FIELDS.flatMap((field) => [
        `youtube:${field}:filled`,
        `youtube:${field}:blank`,
        `youtube:${field}:absent`,
      ]),
    ];
    expect(required.filter((label) => !seen.has(label))).toEqual([]);
  });
});
