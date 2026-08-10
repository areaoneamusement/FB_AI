import assert from "node:assert/strict";
import test from "node:test";

import {
  ComplianceChecker,
  compareCopyright,
  tokenizeForCopyright,
  type ArtifactComplianceResult,
  type ComplianceCheckInput,
  type ComplianceResultPersistence,
  type PlatformRuleSet,
  type SourceCapture,
  type SourceTermsDefinition,
} from "../src/compliance/compliance-checker.ts";
import type { DraftRevision, PlatformArtifact } from "../src/domain/content.ts";

class RecordingPersistence implements ComplianceResultPersistence {
  readonly results: ArtifactComplianceResult[] = [];

  async persistComplianceResult(result: ArtifactComplianceResult): Promise<void> {
    this.results.push(result);
  }
}

const revision: DraftRevision = {
  id: "revision-7",
  draftId: "draft-1",
  revision: 7,
  content: {
    topicId: "topic-1",
    facebookPost: "Nội dung kiểm tra tuân thủ an toàn.",
    guide: [],
    videoScript: { intro: "Mở đầu", body: "Nội dung", conclusion: "Kết" },
    originLinks: ["https://source.example/article"],
    language: "vi",
  },
  contentHash: "revision-hash-7",
  createdBy: "System",
  createdAt: "2025-06-01T00:00:00.000Z",
};

function artifact(overrides: Partial<PlatformArtifact> = {}): PlatformArtifact {
  return {
    id: "artifact-facebook-7",
    draftRevisionId: revision.id,
    platform: "Facebook_Page",
    rendererVersion: "facebook-renderer-v4",
    body: "Nội dung có từ cấm cần phát hiện.",
    metadata: { title: "Bản tin riêng" },
    attribution: "Theo Nguồn Chính: https://source.example/article",
    imageSuggestions: [],
    artifactHash: "artifact-hash-7",
    createdAt: "2025-06-01T01:00:00.000Z",
    ...overrides,
  };
}

const capture: SourceCapture = {
  sourceId: "source-1",
  captureId: "capture-1",
  termsVersion: "terms-v5",
  url: "https://source.example/article",
  content: "vật liệu gốc tách biệt hoàn toàn",
};

const terms: SourceTermsDefinition = {
  sourceId: "source-1",
  version: "terms-v5",
  attributionRequired: true,
  requiredAttributionText: "Nguồn Chính",
  requiredAttributionUrl: capture.url,
};

function checker(persistence: RecordingPersistence): ComplianceChecker {
  let id = 0;
  return new ComplianceChecker({
    persistence,
    evaluatorVersion: "compliance-evaluator-v2",
    now: () => new Date("2025-06-01T02:00:00.000Z"),
    idFactory: () => `compliance-${++id}`,
  });
}

test("evaluates every active platform rule and persists exact violated IDs and artifact binding", async () => {
  const persistence = new RecordingPersistence();
  const ruleSet: PlatformRuleSet = {
    version: "facebook-rules-2025.06",
    rules: [
      { id: "fb.keyword.v3", platform: "Facebook_Page", version: "3", kind: "Keyword", parameters: { keywords: ["từ cấm"] }, effectiveFrom: "2025-01-01T00:00:00.000Z" },
      { id: "fb.pattern.v2", platform: "Facebook_Page", version: "2", kind: "Pattern", parameters: { pattern: "không xuất hiện" }, effectiveFrom: "2025-01-01T00:00:00.000Z" },
      { id: "fb.future.v1", platform: "Facebook_Page", version: "1", kind: "Keyword", parameters: { keywords: ["Nội dung"] }, effectiveFrom: "2026-01-01T00:00:00.000Z" },
      { id: "yt.rule.v1", platform: "YouTube", version: "1", kind: "Keyword", parameters: { keywords: ["Nội dung"] }, effectiveFrom: "2025-01-01T00:00:00.000Z" },
    ],
  };

  const result = await checker(persistence).check({ artifact: artifact(), draftRevision: revision, ruleSet, sourceTerms: [terms], sourceCaptures: [capture] });

  assert.deepEqual(result.evaluatedRuleIds, ["fb.keyword.v3", "fb.pattern.v2"]);
  assert.deepEqual(result.violatedRuleIds, ["fb.keyword.v3"]);
  assert.equal(result.passed, false);
  assert.equal(result.artifactId, "artifact-facebook-7");
  assert.equal(result.artifactHash, "artifact-hash-7");
  assert.equal(result.draftRevisionId, "revision-7");
  assert.equal(result.rendererVersion, "facebook-renderer-v4");
  assert.equal(result.ruleSetVersion, ruleSet.version);
  assert.deepEqual(result.sourceTermsVersions, ["terms-v5"]);
  assert.equal(persistence.results[0], result);
});

test("fails closed for missing standards and Source Terms without mutating draft content", async () => {
  const persistence = new RecordingPersistence();
  const before = structuredClone(revision.content);
  const inputArtifact = artifact();
  const result = await checker(persistence).check({
    artifact: inputArtifact,
    draftRevision: revision,
    sourceCaptures: [capture],
  });

  assert.equal(result.passed, false);
  assert.equal(result.configurationAvailable, false);
  assert.equal(result.ruleSetVersion, "unavailable");
  assert.ok(result.errors.some((error) => error.detail.includes("Community standards")));
  assert.ok(result.errors.some((error) => error.detail.includes("Source Terms")));
  assert.deepEqual(revision.content, before);
  assert.equal(inputArtifact.body, "Nội dung có từ cấm cần phát hiện.");
  assert.equal(persistence.results.length, 1);
});

test("checks required Source Terms attribution and reports its exact rule ID", async () => {
  const persistence = new RecordingPersistence();
  const ruleSet: PlatformRuleSet = {
    version: "facebook-rules-attribution-v1",
    rules: [{
      id: "fb.attribution.required.v1",
      platform: "Facebook_Page",
      version: "1",
      kind: "Attribution",
      parameters: {},
      effectiveFrom: "2025-01-01T00:00:00.000Z",
    }],
  };
  const result = await checker(persistence).check({
    artifact: artifact({ attribution: "" }),
    draftRevision: revision,
    ruleSet,
    sourceTerms: [terms],
    sourceCaptures: [capture],
  });

  assert.equal(result.attributionOk, false);
  assert.deepEqual(result.violatedRuleIds, ["fb.attribution.required.v1"]);
  assert.match(result.reasons.join("\n"), /ATTRIBUTION_REQUIRED/);
});

test("uses deterministic Vietnamese normalization and exact copyright boundaries", () => {
  assert.deepEqual(tokenizeForCopyright("<p>ĐIỆN&nbsp;TOÁN</p>"), ["điện", "toán"]);

  const words = Array.from({ length: 100 }, (_, index) => `từ${index}`);
  const text = words.join(" ");
  const source = (count: number): SourceCapture => ({
    ...capture,
    content: words.slice(0, count).join(" "),
  });

  const limits = { consecutiveWords: 50, matchedDraftRatio: 1, minRunTokens: 5 };
  const ratioLimits = { ...limits, matchedDraftRatio: 0.2 };
  const run49 = compareCopyright(text, [source(49)], limits);
  const run50 = compareCopyright(text, [source(50)], limits);
  const ratio19 = compareCopyright(text, [source(19)], ratioLimits);
  const ratio20 = compareCopyright(text, [source(20)], ratioLimits);

  assert.equal(run49.violatedByConsecutiveWords, false);
  assert.equal(run50.violatedByConsecutiveWords, true);
  assert.equal(ratio19.violatedByMatchedDraftRatio, false);
  assert.equal(ratio20.violatedByMatchedDraftRatio, true);
  assert.deepEqual(ratio20.qualifyingRunLengths, [20]);
  assert.equal(ratio20.minRunTokens, 5);
});

test("counts only contiguous copied runs of at least minRunTokens toward the matched ratio", () => {
  // Isolated overlap of common Vietnamese function words is not verbatim copying.
  const draft = "và zqa của zqb là zqc cho zqd một zqe được zqf";
  const scattered = compareCopyright(draft, [{
    ...capture,
    content: "một bài viết và nội dung của tác giả là bản tin cho bạn đọc được phát hành",
  }]);
  assert.equal(scattered.longestConsecutiveWords, 1);
  assert.equal(scattered.matchedDraftWords, 0);
  assert.deepEqual(scattered.qualifyingRunLengths, []);
  assert.equal(scattered.violatedByMatchedDraftRatio, false);

  // A copied fragment of exactly minRunTokens counts; one token shorter does not.
  const fragment = "alpha beta gamma delta epsilon";
  const tuned = { consecutiveWords: 50, matchedDraftRatio: 0.2, minRunTokens: 5 };
  const copied = compareCopyright(`zq1 zq2 ${fragment} zq3 zq4 zq5`, [{ ...capture, content: `x ${fragment} y` }], tuned);
  assert.equal(copied.matchedDraftWords, 5);
  assert.deepEqual(copied.qualifyingRunLengths, [5]);

  const shorter = compareCopyright(`zq1 zq2 alpha beta gamma delta zq3 zq4 zq5`, [{ ...capture, content: "x alpha beta gamma delta y" }], tuned);
  assert.equal(shorter.longestConsecutiveWords, 4);
  assert.equal(shorter.matchedDraftWords, 0);
  assert.deepEqual(shorter.qualifyingRunLengths, []);
});
