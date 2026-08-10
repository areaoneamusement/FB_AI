import { createHash, randomUUID } from "node:crypto";

import type {
  ModelBCritiquePort,
  ModelBCritiqueResponse,
  ModelCallControl,
} from "../adapters/ports.js";
import type {
  Claim,
  ContentDraft,
  DraftRevision,
  ReproducibilityMetadata,
  ResearchResult,
  SourceReference,
  VerificationFinding,
  VerificationReport,
} from "../domain/index.js";

export const DEFAULT_VERIFICATION_MAX_ROUNDS = 2;
export const DEFAULT_VERIFICATION_MAX_ATTEMPTS = 3;
export const DEFAULT_VERIFICATION_DEADLINE_MS = 60_000;
export const MAX_VERIFICATION_DEADLINE_MS = 300_000;

export interface ModelACorrectionRequest {
  readonly revision: DraftRevision;
  readonly findings: readonly VerificationFinding[];
  readonly research: ResearchResult;
  readonly round: number;
  readonly inputHash: string;
  readonly requestedModel: ReproducibilityMetadata;
}

export interface ModelACorrectionResponse {
  readonly content: ContentDraft;
  readonly provenance: ReproducibilityMetadata;
}

export interface ModelACorrectionPort {
  correct(
    request: ModelACorrectionRequest,
    control: ModelCallControl,
  ): Promise<ModelACorrectionResponse>;
}

export interface VerifyDraftCommand {
  readonly revision: DraftRevision;
  readonly research: ResearchResult;
  readonly requestedModel: ReproducibilityMetadata;
  readonly requestedCorrectionModel?: ReproducibilityMetadata;
  readonly round?: number;
  readonly maxRounds?: number;
  readonly maxAttempts?: number;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

export type VerificationDependency = "ModelA" | "ModelB";
export type VerificationDependencyFailure =
  | "ModelUnresponsive"
  | "DeadlineExceeded"
  | "Cancelled"
  | "InvalidModelResponse";

export interface VerificationErrorRecord {
  readonly id: string;
  readonly draftRevisionId: string;
  readonly researchResultId: string;
  readonly round: number;
  /** Attempts made against the dependency that exhausted its budget. */
  readonly attempts: number;
  readonly dependency: VerificationDependency;
  readonly code: VerificationDependencyFailure;
  readonly reason: string;
  readonly occurredAt: string;
}

export interface VerificationOperatorNotification {
  readonly eventKey: string;
  readonly draftRevisionId: string;
  readonly round: number;
  readonly message: string;
  readonly action: "RetryVerification";
}

/** Optional logging/notification boundary. The same values are always returned. */
export interface VerificationOperations {
  recordError(error: VerificationErrorRecord): Promise<void>;
  notifyOperator(notification: VerificationOperatorNotification): Promise<void>;
}

export interface VerificationCorrectionRecord {
  readonly sourceRevisionId: string;
  readonly sourceReportId: string;
  readonly correctedRevisionId: string;
  readonly round: number;
  readonly inputHash: string;
  readonly modelA: ReproducibilityMetadata;
}

export interface VerificationArtifacts {
  readonly revisions: readonly DraftRevision[];
  readonly reports: readonly VerificationReport[];
  readonly corrections: readonly VerificationCorrectionRecord[];
}

interface VerificationResultBase {
  readonly activeRevision: DraftRevision;
  readonly claims: readonly Claim[];
  /** Total model calls across critique and correction for this invocation. */
  readonly attempts: number;
  readonly artifacts: VerificationArtifacts;
}

export type VerificationResult =
  | (VerificationResultBase & {
      readonly kind: "Passed";
      readonly eligibleStage: "Verified";
      readonly report: VerificationReport;
    })
  | (VerificationResultBase & {
      readonly kind: "VerificationBlocked";
      readonly eligibleStage: "Generated";
      readonly workStatus: "VerificationBlocked";
      readonly report: VerificationReport;
    })
  | (VerificationResultBase & {
      readonly kind: "RetryableBlocked";
      readonly eligibleStage: "Generated";
      readonly workStatus: "RetryableBlocked";
      readonly failure: VerificationDependencyFailure;
      readonly error: VerificationErrorRecord;
      readonly notification: VerificationOperatorNotification;
    });

export interface VerificationEngineDependencies {
  readonly modelA?: ModelACorrectionPort;
  readonly operations?: VerificationOperations;
  readonly now?: () => Date;
  readonly createId?: (
    kind: "draft-revision" | "verification-report" | "verification-error",
  ) => string;
}

export class VerificationInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "VerificationInputError";
  }
}

class InvalidModelResponseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidModelResponseError";
  }
}

class VerificationDeadlineError extends Error {
  public constructor(
    readonly dependency: VerificationDependency,
    readonly deadlineMs: number,
  ) {
    super(`${dependency} deadline exceeded after ${deadlineMs}ms`);
    this.name = "VerificationDeadlineError";
  }
}

interface VerificationSettings {
  readonly startRound: number;
  readonly maxRounds: number;
  readonly maxAttempts: number;
  readonly deadlineMs: number;
}

interface AttemptFailure {
  readonly failure: VerificationDependencyFailure;
  readonly reason: string;
  readonly attempts: number;
}

interface CritiqueSuccess {
  readonly findings: readonly VerificationFinding[];
  readonly provenance: ReproducibilityMetadata;
  readonly attempts: number;
}

interface CorrectionSuccess {
  readonly response: ModelACorrectionResponse;
  readonly attempts: number;
}

/** Extracts stable field-local claims from all factual prose formats. */
export function extractClaims(revision: DraftRevision): readonly Claim[] {
  const fields: Array<{ format: Claim["format"]; path: string; text: string }> = [
    { format: "FacebookPost", path: "facebookPost", text: revision.content.facebookPost },
  ];
  revision.content.guide.forEach((section, index) => {
    fields.push(
      { format: "Guide", path: `guide[${index}].heading`, text: section.heading },
      { format: "Guide", path: `guide[${index}].body`, text: section.body },
    );
    section.imageSuggestions.forEach((suggestion, suggestionIndex) => {
      fields.push({
        format: "Guide",
        path: `guide[${index}].imageSuggestions[${suggestionIndex}].description`,
        text: suggestion.description,
      });
    });
  });
  fields.push(
    { format: "VideoScript", path: "videoScript.intro", text: revision.content.videoScript.intro },
    { format: "VideoScript", path: "videoScript.body", text: revision.content.videoScript.body },
    { format: "VideoScript", path: "videoScript.conclusion", text: revision.content.videoScript.conclusion },
  );

  const claims = fields.flatMap((field) =>
    statementSpans(field.text).map(({ startOffset, endOffset }) => {
      const text = field.text.slice(startOffset, endOffset);
      return Object.freeze({
        id: claimId(revision.id, field.format, field.path, startOffset, endOffset, text),
        draftRevisionId: revision.id,
        format: field.format,
        path: field.path,
        startOffset,
        endOffset,
        text,
      });
    }),
  );
  return Object.freeze(claims);
}

/**
 * Produces immutable evidence and transition recommendations only. It never
 * receives a Repository or PipelineRun and therefore cannot mutate workflow.
 */
export class VerificationEngine {
  readonly #now: () => Date;
  readonly #createId: NonNullable<VerificationEngineDependencies["createId"]>;
  readonly #modelA: ModelACorrectionPort | undefined;
  readonly #modelB: ModelBCritiquePort;
  readonly #operations: VerificationOperations;

  public constructor(
    modelA: ModelACorrectionPort,
    modelB: ModelBCritiquePort,
    dependencies?: VerificationEngineDependencies,
  );
  public constructor(
    modelB: ModelBCritiquePort,
    operations?: VerificationOperations,
    dependencies?: VerificationEngineDependencies,
  );
  public constructor(
    first: ModelACorrectionPort | ModelBCritiquePort,
    second?: ModelBCritiquePort | VerificationOperations,
    dependencies: VerificationEngineDependencies = {},
  ) {
    if ("correct" in first) {
      if (second === undefined || !("critique" in second)) {
        throw new VerificationInputError("Model B critique adapter is required");
      }
      this.#modelA = first;
      this.#modelB = second;
      this.#operations = dependencies.operations ?? NOOP_OPERATIONS;
    } else {
      this.#modelA = dependencies.modelA;
      this.#modelB = first;
      this.#operations = second === undefined || "critique" in second
        ? dependencies.operations ?? NOOP_OPERATIONS
        : second;
    }
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId = dependencies.createId ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  public async verify(command: VerifyDraftCommand): Promise<VerificationResult> {
    const settings = validateCommand(command);
    let activeRevision = command.revision;
    let totalAttempts = 0;
    const revisions: DraftRevision[] = [];
    const reports: VerificationReport[] = [];
    const corrections: VerificationCorrectionRecord[] = [];

    for (let round = settings.startRound; round <= settings.maxRounds; round += 1) {
      const claims = extractClaims(activeRevision);
      if (claims.length === 0) {
        throw new VerificationInputError("Draft revision must contain at least one claim");
      }
      const critique = await this.critiqueWithRetries(
        command,
        activeRevision,
        claims,
        round,
        settings,
      );
      totalAttempts += critique.attempts;
      if ("failure" in critique) {
        return await this.retryableBlocked(
          command,
          activeRevision,
          claims,
          round,
          totalAttempts,
          "ModelB",
          critique,
          freezeArtifacts(revisions, reports, corrections),
        );
      }

      const report = this.makeReport(
        activeRevision,
        command.research,
        round,
        critique.findings,
        critique.provenance,
      );
      reports.push(report);
      if (report.passed) {
        return Object.freeze({
          kind: "Passed",
          eligibleStage: "Verified",
          activeRevision,
          claims,
          report,
          attempts: totalAttempts,
          artifacts: freezeArtifacts(revisions, reports, corrections),
        });
      }
      if (round === settings.maxRounds) {
        return Object.freeze({
          kind: "VerificationBlocked",
          eligibleStage: "Generated",
          workStatus: "VerificationBlocked",
          activeRevision,
          claims,
          report,
          attempts: totalAttempts,
          artifacts: freezeArtifacts(revisions, reports, corrections),
        });
      }

      const correctionModel = command.requestedCorrectionModel;
      if (correctionModel === undefined) {
        throw new VerificationInputError(
          "requestedCorrectionModel is required for correction rounds",
        );
      }
      const inputHash = hashCanonical({
        revisionId: activeRevision.id,
        contentHash: activeRevision.contentHash,
        researchResultId: command.research.id,
        findings: report.findings,
        round,
        requestedModel: correctionModel,
      });
      const correction = await this.correctWithRetries(
        command,
        activeRevision,
        report.findings,
        round,
        inputHash,
        correctionModel,
        settings,
      );
      totalAttempts += correction.attempts;
      if ("failure" in correction) {
        return await this.retryableBlocked(
          command,
          activeRevision,
          claims,
          round,
          totalAttempts,
          "ModelA",
          correction,
          freezeArtifacts(revisions, reports, corrections),
        );
      }
      const correctedRevision = this.makeCorrectedRevision(
        activeRevision,
        correction.response.content,
      );
      corrections.push(Object.freeze({
        sourceRevisionId: activeRevision.id,
        sourceReportId: report.id,
        correctedRevisionId: correctedRevision.id,
        round,
        inputHash,
        modelA: freezeProvenance(correction.response.provenance),
      }));
      revisions.push(correctedRevision);
      activeRevision = correctedRevision;
    }
    throw new VerificationInputError("Verification round bounds are invalid");
  }

  private async critiqueWithRetries(
    command: VerifyDraftCommand,
    revision: DraftRevision,
    claims: readonly Claim[],
    round: number,
    settings: VerificationSettings,
  ): Promise<CritiqueSuccess | AttemptFailure> {
    let last: Omit<AttemptFailure, "attempts"> = {
      failure: "ModelUnresponsive",
      reason: "Model B did not return a critique",
    };
    for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
      if (command.signal?.aborted === true) {
        return cancelledFailure(command.signal, attempt - 1);
      }
      try {
        const response = await this.callWithDeadline(
          "ModelB",
          settings.deadlineMs,
          command.signal,
          (control) => this.#modelB.critique({
            revision,
            claims,
            research: command.research,
            round,
            requestedModel: command.requestedModel,
          }, control),
        );
        return {
          findings: normalizeFindings(response, claims, command.research),
          provenance: freezeProvenance(response.provenance),
          attempts: attempt,
        };
      } catch (error) {
        if (isSignalAborted(command.signal)) {
          return cancelledFailure(command.signal, attempt);
        }
        last = classifyFailure(error);
      }
    }
    return { ...last, attempts: settings.maxAttempts };
  }

  private async correctWithRetries(
    command: VerifyDraftCommand,
    revision: DraftRevision,
    findings: readonly VerificationFinding[],
    round: number,
    inputHash: string,
    requestedModel: ReproducibilityMetadata,
    settings: VerificationSettings,
  ): Promise<CorrectionSuccess | AttemptFailure> {
    const modelA = this.#modelA;
    if (modelA === undefined) {
      throw new VerificationInputError("Model A correction adapter is required");
    }
    let last: Omit<AttemptFailure, "attempts"> = {
      failure: "ModelUnresponsive",
      reason: "Model A did not return a correction",
    };
    for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
      if (command.signal?.aborted === true) {
        return cancelledFailure(command.signal, attempt - 1);
      }
      try {
        const response = await this.callWithDeadline(
          "ModelA",
          settings.deadlineMs,
          command.signal,
          (control) => modelA.correct({
            revision,
            findings,
            research: command.research,
            round,
            inputHash,
            requestedModel,
          }, control),
        );
        validateProvenance(response.provenance, InvalidModelResponseError);
        validateCorrectedContent(response.content, revision);
        return {
          response: Object.freeze({
            content: freezeContent(response.content),
            provenance: freezeProvenance(response.provenance),
          }),
          attempts: attempt,
        };
      } catch (error) {
        if (isSignalAborted(command.signal)) {
          return cancelledFailure(command.signal, attempt);
        }
        last = classifyFailure(error);
      }
    }
    return { ...last, attempts: settings.maxAttempts };
  }

  private async callWithDeadline<T>(
    dependency: VerificationDependency,
    deadlineMs: number,
    outerSignal: AbortSignal | undefined,
    invoke: (control: ModelCallControl) => Promise<T>,
  ): Promise<T> {
    const startedAt = this.#now();
    if (!Number.isFinite(startedAt.getTime())) {
      throw new VerificationInputError("Verification clock returned an invalid Date");
    }
    const controller = new AbortController();
    const deadlineError = new VerificationDeadlineError(dependency, deadlineMs);
    const forwardAbort = (): void =>
      controller.abort(outerSignal?.reason ?? abortError());
    if (outerSignal?.aborted === true) forwardAbort();
    else outerSignal?.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(deadlineError), deadlineMs);
    const control = Object.freeze({
      signal: controller.signal,
      deadlineAt: new Date(startedAt.getTime() + deadlineMs).toISOString(),
    });
    try {
      return await raceWithAbort(invoke(control), controller.signal);
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  private makeReport(
    revision: DraftRevision,
    research: ResearchResult,
    round: number,
    findings: readonly VerificationFinding[],
    provenance: ReproducibilityMetadata,
  ): VerificationReport {
    return Object.freeze({
      id: this.makeId("verification-report"),
      draftRevisionId: revision.id,
      contentHash: revision.contentHash,
      researchResultId: research.id,
      round,
      modelB: freezeProvenance(provenance),
      findings,
      passed: findings.every(({ verdict }) => verdict === "Pass"),
    });
  }

  private makeCorrectedRevision(
    parent: DraftRevision,
    content: ContentDraft,
  ): DraftRevision {
    const frozenContent = freezeContent(content);
    return Object.freeze({
      id: this.makeId("draft-revision"),
      draftId: parent.draftId,
      revision: parent.revision + 1,
      parentRevisionId: parent.id,
      content: frozenContent,
      contentHash: hashCanonical(frozenContent),
      createdBy: "System",
      createdAt: this.nowIso(),
    });
  }

  private async retryableBlocked(
    command: VerifyDraftCommand,
    activeRevision: DraftRevision,
    claims: readonly Claim[],
    round: number,
    totalAttempts: number,
    dependency: VerificationDependency,
    failure: AttemptFailure,
    artifacts: VerificationArtifacts,
  ): Promise<VerificationResult> {
    const error = Object.freeze({
      id: this.makeId("verification-error"),
      draftRevisionId: activeRevision.id,
      researchResultId: command.research.id,
      round,
      attempts: failure.attempts,
      dependency,
      code: failure.failure,
      reason: failure.reason,
      occurredAt: this.nowIso(),
    });
    const notification = Object.freeze({
      eventKey: `verification:${activeRevision.id}:${round}:${dependency}:retryable-blocked`,
      draftRevisionId: activeRevision.id,
      round,
      message: `${dependency} verification dependency could not complete: ${failure.reason}`,
      action: "RetryVerification" as const,
    });
    await Promise.allSettled([
      this.#operations.recordError(error),
      this.#operations.notifyOperator(notification),
    ]);
    return Object.freeze({
      kind: "RetryableBlocked",
      eligibleStage: "Generated",
      workStatus: "RetryableBlocked",
      activeRevision,
      claims,
      attempts: totalAttempts,
      failure: failure.failure,
      error,
      notification,
      artifacts,
    });
  }

  private makeId(
    kind: "draft-revision" | "verification-report" | "verification-error",
  ): string {
    const id = this.#createId(kind);
    if (id.trim().length === 0) {
      throw new VerificationInputError(`${kind} ID is required`);
    }
    return id;
  }

  private nowIso(): string {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new VerificationInputError("Verification clock returned an invalid Date");
    }
    return now.toISOString();
  }
}

const NOOP_OPERATIONS: VerificationOperations = Object.freeze({
  recordError: async () => undefined,
  notifyOperator: async () => undefined,
});

function validateCommand(command: VerifyDraftCommand): VerificationSettings {
  assertNonEmpty(command.revision.id, "revision.id");
  assertNonEmpty(command.research.id, "research.id");
  if (command.research.status !== "Ok") {
    throw new VerificationInputError("Verification requires completed research");
  }
  if (command.research.topicId !== command.revision.content.topicId) {
    throw new VerificationInputError("Research and revision must belong to the same topic");
  }
  if (hashCanonical(command.revision.content) !== command.revision.contentHash) {
    throw new VerificationInputError(
      "Draft revision contentHash does not match its exact canonical content",
    );
  }
  validateProvenance(command.requestedModel, VerificationInputError);
  if (command.requestedCorrectionModel !== undefined) {
    validateProvenance(command.requestedCorrectionModel, VerificationInputError);
  }
  for (const item of command.research.items) {
    if (item.evidenceRefs.length === 0) {
      throw new VerificationInputError(`Research item ${item.id} has no evidence reference`);
    }
  }

  const startRound = command.round ?? 1;
  const maxRounds = command.maxRounds ?? DEFAULT_VERIFICATION_MAX_ROUNDS;
  const maxAttempts = command.maxAttempts ?? DEFAULT_VERIFICATION_MAX_ATTEMPTS;
  const deadlineMs = command.deadlineMs ?? DEFAULT_VERIFICATION_DEADLINE_MS;
  assertIntegerRange(maxRounds, 1, 5, "maxRounds");
  assertIntegerRange(startRound, 1, maxRounds, "round");
  assertIntegerRange(maxAttempts, 1, 3, "maxAttempts");
  assertIntegerRange(deadlineMs, 1, MAX_VERIFICATION_DEADLINE_MS, "deadlineMs");
  return { startRound, maxRounds, maxAttempts, deadlineMs };
}

function normalizeFindings(
  response: ModelBCritiqueResponse,
  claims: readonly Claim[],
  research: ResearchResult,
): readonly VerificationFinding[] {
  validateProvenance(response.provenance, InvalidModelResponseError);
  if (!Array.isArray(response.findings) || response.findings.length !== claims.length) {
    throw new InvalidModelResponseError(
      "Model B must return exactly one finding per claim",
    );
  }
  const claimIds = new Set(claims.map(({ id }) => id));
  const seen = new Set<string>();
  const allEvidence = new Map<string, SourceReference>();
  const sourceBackedEvidence = new Set<string>();
  for (const item of research.items) {
    for (const reference of item.evidenceRefs) {
      const key = referenceKey(reference);
      allEvidence.set(key, reference);
      if (item.kind !== "Inferred") sourceBackedEvidence.add(key);
    }
  }

  const byClaim = new Map<string, VerificationFinding>();
  for (const raw of response.findings) {
    if (!claimIds.has(raw.claimId) || seen.has(raw.claimId)) {
      throw new InvalidModelResponseError(
        "Model B returned an unknown or duplicate claim finding",
      );
    }
    seen.add(raw.claimId);
    if (!["Pass", "Contradiction", "Unsupported"].includes(raw.verdict)) {
      throw new InvalidModelResponseError(`Invalid verdict for claim ${raw.claimId}`);
    }
    if (!Array.isArray(raw.evidenceRefs) || raw.evidenceRefs.length === 0) {
      throw new InvalidModelResponseError(
        `Finding ${raw.claimId} must cite research evidence`,
      );
    }
    const evidenceRefs = raw.evidenceRefs.map((reference: SourceReference) => {
      const known = allEvidence.get(referenceKey(reference));
      if (known === undefined) {
        throw new InvalidModelResponseError(
          `Finding ${raw.claimId} cites evidence outside the research corpus`,
        );
      }
      return freezeReference(known);
    });
    const hasSourceBackedEvidence = evidenceRefs.some((reference: SourceReference) =>
      sourceBackedEvidence.has(referenceKey(reference)),
    );
    let verdict = raw.verdict;
    let description = raw.description?.trim();
    if (verdict === "Pass" && !hasSourceBackedEvidence) {
      verdict = "Unsupported";
      description =
        "The cited research is inferred context only; source-backed evidence is required for Pass.";
    }
    if (verdict === "Contradiction" && !hasSourceBackedEvidence) {
      throw new InvalidModelResponseError(
        `Contradiction ${raw.claimId} must cite source-backed research evidence`,
      );
    }
    if (verdict !== "Pass" && !description) {
      throw new InvalidModelResponseError(
        `${verdict} finding ${raw.claimId} requires a useful description`,
      );
    }
    byClaim.set(raw.claimId, Object.freeze({
      claimId: raw.claimId,
      verdict,
      evidenceRefs: Object.freeze(evidenceRefs),
      ...(description === undefined ? {} : { description }),
      ...(raw.confidence === undefined ? {} : { confidence: raw.confidence }),
    }));
  }
  return Object.freeze(claims.map(({ id }) => byClaim.get(id)!));
}

function validateCorrectedContent(content: ContentDraft, parent: DraftRevision): void {
  if (content.topicId !== parent.content.topicId) {
    throw new InvalidModelResponseError("Corrected content changed the topic binding");
  }
  const facebookLength = Array.from(content.facebookPost).length;
  if (facebookLength < 50 || facebookLength > 5_000) {
    throw new InvalidModelResponseError("Corrected FacebookPost must contain 50 to 5000 characters");
  }
  if (!Array.isArray(content.guide) || content.guide.length < 3) {
    throw new InvalidModelResponseError("Corrected Guide must contain at least three sections");
  }
  content.guide.forEach((section, index) => {
    if (!section.heading.trim() || !section.body.trim()) {
      throw new InvalidModelResponseError(`Corrected Guide section ${index} is incomplete`);
    }
    if (!Array.isArray(section.imageSuggestions) || section.imageSuggestions.length === 0) {
      throw new InvalidModelResponseError(
        `Corrected Guide section ${index} needs an image suggestion`,
      );
    }
    for (const suggestion of section.imageSuggestions) {
      const length = Array.from(suggestion.description).length;
      if (length < 10 || length > 500) {
        throw new InvalidModelResponseError(
          `Corrected Guide section ${index} has an invalid image suggestion`,
        );
      }
    }
  });
  if (
    !content.videoScript.intro.trim() ||
    !content.videoScript.body.trim() ||
    !content.videoScript.conclusion.trim()
  ) {
    throw new InvalidModelResponseError(
      "Corrected VideoScript must include intro, body, and conclusion",
    );
  }
  if (!Array.isArray(content.originLinks) || content.originLinks.length === 0) {
    throw new InvalidModelResponseError("Corrected content must retain an origin link");
  }
  assertNonEmptyForModel(content.language, "Corrected content language");
}

function statementSpans(text: string): readonly { startOffset: number; endOffset: number }[] {
  if (typeof text !== "string") return [];
  const spans: Array<{ startOffset: number; endOffset: number }> = [];
  let segmentStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\r" && text[index + 1] === "\n") index += 1;
    if (!".!?。！？\n\r".includes(character)) continue;
    pushTrimmedSpan(text, segmentStart, index + 1, spans);
    segmentStart = index + 1;
  }
  pushTrimmedSpan(text, segmentStart, text.length, spans);
  return spans;
}

function pushTrimmedSpan(
  text: string,
  rawStart: number,
  rawEnd: number,
  spans: Array<{ startOffset: number; endOffset: number }>,
): void {
  let startOffset = rawStart;
  let endOffset = rawEnd;
  while (startOffset < endOffset && /\s/u.test(text[startOffset]!)) startOffset += 1;
  while (endOffset > startOffset && /\s/u.test(text[endOffset - 1]!)) endOffset -= 1;
  if (startOffset < endOffset) spans.push({ startOffset, endOffset });
}

function claimId(
  revisionId: string,
  format: Claim["format"],
  path: string,
  startOffset: number,
  endOffset: number,
  text: string,
): string {
  return `claim-${createHash("sha256")
    .update(JSON.stringify([revisionId, format, path, startOffset, endOffset, text]), "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

function freezeArtifacts(
  revisions: readonly DraftRevision[],
  reports: readonly VerificationReport[],
  corrections: readonly VerificationCorrectionRecord[],
): VerificationArtifacts {
  return Object.freeze({
    revisions: Object.freeze([...revisions]),
    reports: Object.freeze([...reports]),
    corrections: Object.freeze([...corrections]),
  });
}

function freezeContent(content: ContentDraft): ContentDraft {
  return Object.freeze({
    ...content,
    guide: Object.freeze(content.guide.map((section) => Object.freeze({
      ...section,
      imageSuggestions: Object.freeze(
        section.imageSuggestions.map((suggestion) => Object.freeze({ ...suggestion })),
      ),
    }))),
    videoScript: Object.freeze({ ...content.videoScript }),
    originLinks: Object.freeze([...content.originLinks]),
  });
}

function freezeProvenance(
  metadata: ReproducibilityMetadata,
): ReproducibilityMetadata {
  return Object.freeze({ ...metadata });
}

function freezeReference(reference: SourceReference): SourceReference {
  return Object.freeze({ ...reference });
}

function referenceKey(reference: SourceReference): string {
  return JSON.stringify([
    reference.sourceId,
    reference.captureId,
    reference.url,
    reference.capturedAt,
    reference.termsVersion,
  ]);
}

function validateProvenance(
  metadata: ReproducibilityMetadata,
  ErrorType: new (message: string) => Error,
): void {
  for (const [label, value] of Object.entries(metadata)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ErrorType(`Model provenance ${label} is required`);
    }
  }
}

function classifyFailure(
  error: unknown,
): Omit<AttemptFailure, "attempts"> {
  if (error instanceof VerificationDeadlineError) {
    return { failure: "DeadlineExceeded", reason: error.message };
  }
  if (error instanceof InvalidModelResponseError) {
    return { failure: "InvalidModelResponse", reason: error.message };
  }
  return {
    failure: "ModelUnresponsive",
    reason: reasonFrom(error, "Model dependency did not respond"),
  };
}

function isSignalAborted(
  signal: AbortSignal | undefined,
): signal is AbortSignal {
  return signal?.aborted === true;
}

function cancelledFailure(signal: AbortSignal, attempts: number): AttemptFailure {
  return {
    failure: "Cancelled",
    reason: reasonFrom(signal.reason, "Verification was cancelled"),
    attempts,
  };
}

function reasonFrom(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.trim()) return value.message;
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function assertIntegerRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new VerificationInputError(
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new VerificationInputError(`${label} is required`);
  }
}

function assertNonEmptyForModel(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidModelResponseError(`${label} is required`);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function hashCanonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? abortError());
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError");
}
