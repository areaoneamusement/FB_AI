import { createHash, randomUUID } from "node:crypto";

import type {
  ModelAGenerationPort,
  ModelCallControl,
} from "../adapters/ports.js";
import type {
  ContentDraft,
  DraftRevision,
  ImageSuggestion,
  ReproducibilityMetadata,
  ResearchResult,
  Topic,
} from "../domain/content.js";

export const CONTENT_DRAFT_FORMATS = [
  "FacebookPost",
  "Guide",
  "VideoScript",
] as const;

export type ContentDraftFormat = (typeof CONTENT_DRAFT_FORMATS)[number];
export type GenerationFailureComponent = ContentDraftFormat | "OriginLinks";

export interface FormatError {
  readonly format: GenerationFailureComponent;
  readonly path: string;
  readonly message: string;
}

export interface GenerationReproducibilityMetadata {
  readonly modelA: ReproducibilityMetadata;
  readonly researchResultId: string;
  readonly inputHash: string;
  readonly contentHash?: string;
  readonly language: string;
  readonly brandVoiceVersion?: string;
}

export interface GeneratedContentResult {
  readonly kind: "Generated";
  readonly revision: DraftRevision;
  readonly metadata: GenerationReproducibilityMetadata & {
    readonly contentHash: string;
  };
}
export interface FailedContentGenerationResult {
  readonly kind: "Failed";
  readonly failureKind:
    | "Validation"
    | "ModelError"
    | "Cancelled"
    | "DeadlineExceeded";
  readonly failingFormats: readonly GenerationFailureComponent[];
  readonly errors: readonly FormatError[];
  /** Diagnostic only. A failed result never contains an advanceable revision. */
  readonly partialContent?: ContentDraft;
  readonly metadata: GenerationReproducibilityMetadata;
}

export type ContentGenerationResult =
  | GeneratedContentResult
  | FailedContentGenerationResult;

export interface DraftRevisionIdentity {
  readonly draftId: string;
  readonly revision: number;
  readonly parentRevisionId?: string;
}

export interface GenerateContentCommand {
  readonly topic: Topic;
  readonly research: ResearchResult;
  readonly requestedModel: ReproducibilityMetadata;
  readonly language?: string;
  readonly brandVoiceVersion?: string;
  readonly revisionIdentity?: DraftRevisionIdentity;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

export interface ContentGeneratorDependencies {
  readonly now?: () => Date;
  readonly createId?: (kind: "draft" | "draft-revision") => string;
}

export const DEFAULT_GENERATION_DEADLINE_MS = 60_000;
export const MAX_GENERATION_DEADLINE_MS = 300_000;

export class ContentGenerationInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ContentGenerationInputError";
  }
}

/** Allows Model A adapters to identify a failed subset of the three formats. */
export class ModelFormatGenerationError extends Error {
  readonly failingFormats: readonly ContentDraftFormat[];
  readonly partialContent?: ContentDraft;

  public constructor(
    message: string,
    failingFormats: readonly ContentDraftFormat[],
    partialContent?: ContentDraft,
  ) {
    super(message);
    this.name = "ModelFormatGenerationError";
    const formats = uniqueFormats(failingFormats);
    if (formats.length === 0) {
      throw new ContentGenerationInputError(
        "A format generation error must identify at least one format",
      );
    }
    this.failingFormats = Object.freeze(formats);
    this.partialContent = partialContent;
  }
}
class GenerationDeadlineExceededError extends Error {
  public constructor(readonly deadlineMs: number) {
    super(`Model A generation deadline exceeded after ${deadlineMs}ms`);
    this.name = "GenerationDeadlineExceededError";
  }
}

/**
 * Produces immutable content artifacts only. ContentPipeline remains responsible
 * for persisting the revision and advancing Researched -> Generated.
 */
export class ContentGenerator {
  readonly #now: () => Date;
  readonly #createId: (kind: "draft" | "draft-revision") => string;

  public constructor(
    private readonly modelA: ModelAGenerationPort,
    dependencies: ContentGeneratorDependencies = {},
  ) {
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId =
      dependencies.createId ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  public async generate(
    command: GenerateContentCommand,
  ): Promise<ContentGenerationResult> {
    const language = command.language?.trim() || "vi";
    const brandVoiceVersion = command.brandVoiceVersion?.trim() || undefined;
    const deadlineMs = command.deadlineMs ?? DEFAULT_GENERATION_DEADLINE_MS;
    validateCommand(command, language, brandVoiceVersion, deadlineMs);

    const startedAt = this.#now();
    if (!Number.isFinite(startedAt.getTime())) {
      throw new ContentGenerationInputError(
        "Content generator clock returned an invalid Date",
      );
    }
    const inputHash = hashCanonical({
      topic: command.topic,
      research: command.research,
      requestedModel: command.requestedModel,
      language,
      brandVoiceVersion,
    });
    const baseMetadata = generationMetadata(
      command.requestedModel,
      command.research.id,
      inputHash,
      language,
      brandVoiceVersion,
    );
    const controller = new AbortController();
    const forwardCancellation = (): void =>
      controller.abort(command.signal?.reason ?? abortError());
    if (command.signal?.aborted === true) forwardCancellation();
    else command.signal?.addEventListener("abort", forwardCancellation, { once: true });

    const deadlineError = new GenerationDeadlineExceededError(deadlineMs);
    const timer = setTimeout(() => controller.abort(deadlineError), deadlineMs);
    const control: ModelCallControl = {
      signal: controller.signal,
      deadlineAt: new Date(startedAt.getTime() + deadlineMs).toISOString(),
    };

    try {
      if (controller.signal.aborted) {
        return failureFromAbort(controller.signal, baseMetadata);
      }
      const response = await raceWithAbort(
        this.modelA.generate(
          {
            topic: command.topic,
            research: command.research,
            inputHash,
            requestedModel: command.requestedModel,
            language,
            ...(brandVoiceVersion === undefined ? {} : { brandVoiceVersion }),
          },
          control,
        ),
        controller.signal,
      );
      validateProvenance(response.provenance);
      const content = freezeContent(bindContent(
        response.content,
        command.topic.id,
        language,
        brandVoiceVersion,
      ));
      const contentHash = hashCanonical(content);
      const metadata: GeneratedContentResult["metadata"] = Object.freeze({
        ...generationMetadata(
          response.provenance,
          command.research.id,
          inputHash,
          language,
          brandVoiceVersion,
        ),
        contentHash,
      });
      const errors = validateGeneratedContent(content, command.topic);
      if (errors.length > 0) {
        return failedResult("Validation", errors, metadata, content);
      }

      const identity = command.revisionIdentity;
      const revision: DraftRevision = Object.freeze({
        id: this.makeId("draft-revision"),
        draftId: identity?.draftId ?? this.makeId("draft"),
        revision: identity?.revision ?? 1,
        ...(identity?.parentRevisionId === undefined
          ? {}
          : { parentRevisionId: identity.parentRevisionId }),
        content,
        contentHash,
        createdBy: "System",
        createdAt: startedAt.toISOString(),
      });
      return Object.freeze({ kind: "Generated", revision, metadata });
    } catch (error) {
      return this.modelFailure(error, command, baseMetadata, language, brandVoiceVersion);
    } finally {
      clearTimeout(timer);
      command.signal?.removeEventListener("abort", forwardCancellation);
    }
  }
  private modelFailure(
    error: unknown,
    command: GenerateContentCommand,
    baseMetadata: GenerationReproducibilityMetadata,
    language: string,
    brandVoiceVersion: string | undefined,
  ): FailedContentGenerationResult {
    if (error instanceof GenerationDeadlineExceededError) {
      return failureFromAbort(
        { aborted: true, reason: error } as AbortSignal,
        baseMetadata,
      );
    }
    if (command.signal?.aborted === true) {
      return failureFromAbort(command.signal, baseMetadata);
    }
    if (error instanceof ModelFormatGenerationError) {
      const partial = error.partialContent === undefined
        ? undefined
        : freezeContent(bindContent(
            error.partialContent,
            command.topic.id,
            language,
            brandVoiceVersion,
          ));
      const metadata = partial === undefined
        ? baseMetadata
        : Object.freeze({
            ...baseMetadata,
            contentHash: hashCanonical(partial),
          });
      return failedResult(
        "ModelError",
        error.failingFormats.map((format) => ({
          format,
          path: formatPath(format),
          message: error.message,
        })),
        metadata,
        partial,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return failedResult(
      "ModelError",
      CONTENT_DRAFT_FORMATS.map((format) => ({
        format,
        path: formatPath(format),
        message,
      })),
      baseMetadata,
    );
  }

  private makeId(kind: "draft" | "draft-revision"): string {
    const id = this.#createId(kind);
    if (id.trim().length === 0) {
      throw new ContentGenerationInputError(`ID factory returned an empty ${kind} id`);
    }
    return id;
  }
}

function validateCommand(
  command: GenerateContentCommand,
  language: string,
  brandVoiceVersion: string | undefined,
  deadlineMs: number,
): void {
  if (command.research.topicId !== command.topic.id) {
    throw new ContentGenerationInputError(
      "Research result does not belong to the requested topic",
    );
  }
  if (command.research.status !== "Ok") {
    throw new ContentGenerationInputError(
      "Content generation requires a completed, sufficient research result",
    );
  }
  assertNonEmpty(language, "language");
  if (command.brandVoiceVersion !== undefined && brandVoiceVersion === undefined) {
    throw new ContentGenerationInputError("brandVoiceVersion must not be blank");
  }
  validateProvenance(command.requestedModel);
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > MAX_GENERATION_DEADLINE_MS
  ) {
    throw new ContentGenerationInputError(
      `deadlineMs must be an integer from 1 to ${MAX_GENERATION_DEADLINE_MS}`,
    );
  }
  const identity = command.revisionIdentity;
  if (identity !== undefined) {
    assertNonEmpty(identity.draftId, "draftId");
    if (!Number.isSafeInteger(identity.revision) || identity.revision < 1) {
      throw new ContentGenerationInputError("revision must be a positive integer");
    }
    if (identity.revision > 1 && identity.parentRevisionId === undefined) {
      throw new ContentGenerationInputError(
        "A revision after the first must identify its parent revision",
      );
    }
  }
}
function validateProvenance(metadata: ReproducibilityMetadata): void {
  assertNonEmpty(metadata.provider, "provider");
  assertNonEmpty(metadata.model, "model");
  assertNonEmpty(metadata.promptVersion, "promptVersion");
  assertNonEmpty(metadata.configurationVersion, "configurationVersion");
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new ContentGenerationInputError(`${label} is required`);
  }
}

function bindContent(
  content: ContentDraft,
  topicId: string,
  language: string,
  brandVoiceVersion: string | undefined,
): ContentDraft {
  return {
    ...content,
    topicId,
    language,
    ...(brandVoiceVersion === undefined
      ? { brandVoiceVersion: undefined }
      : { brandVoiceVersion }),
  };
}

function freezeContent(content: ContentDraft): ContentDraft {
  const guide = Array.isArray(content.guide)
    ? content.guide.map((section) => Object.freeze({
        ...section,
        imageSuggestions: Object.freeze(
          Array.isArray(section.imageSuggestions)
            ? (section.imageSuggestions as readonly ImageSuggestion[])
                .map((suggestion) => Object.freeze({ ...suggestion }))
            : [],
        ),
      }))
    : [];
  const originLinks = Array.isArray(content.originLinks)
    ? [...content.originLinks]
    : [];
  return Object.freeze({
    ...content,
    guide: Object.freeze(guide),
    videoScript: Object.freeze({ ...content.videoScript }),
    originLinks: Object.freeze(originLinks),
  });
}

function validateGeneratedContent(
  content: ContentDraft,
  topic: Topic,
): readonly FormatError[] {
  const errors: FormatError[] = [];
  if (typeof content.facebookPost !== "string") {
    errors.push(formatError("FacebookPost", "facebookPost", "must be text"));
  } else {
    const length = characterLength(content.facebookPost);
    if (length < 50 || length > 5_000) {
      errors.push(formatError(
        "FacebookPost",
        "facebookPost",
        "must contain 50 to 5000 characters",
      ));
    }
  }

  if (!Array.isArray(content.guide) || content.guide.length < 3) {
    errors.push(formatError("Guide", "guide", "must contain at least 3 sections"));
  }
  if (Array.isArray(content.guide)) {
    content.guide.forEach((section, sectionIndex) => {
      const base = `guide[${sectionIndex}]`;
      if (typeof section.heading !== "string" || section.heading.trim().length === 0) {
        errors.push(formatError("Guide", `${base}.heading`, "must not be empty"));
      }
      if (typeof section.body !== "string" || section.body.trim().length === 0) {
        errors.push(formatError("Guide", `${base}.body`, "must not be empty"));
      }
      if (!Array.isArray(section.imageSuggestions) || section.imageSuggestions.length < 1) {
        errors.push(formatError(
          "Guide",
          `${base}.imageSuggestions`,
          "must contain at least one image suggestion",
        ));
      } else {
        (section.imageSuggestions as readonly ImageSuggestion[]).forEach(
          (suggestion, suggestionIndex) => {
          const length = typeof suggestion.description === "string"
            ? characterLength(suggestion.description)
            : 0;
          if (length < 10 || length > 500) {
            errors.push(formatError(
              "Guide",
              `${base}.imageSuggestions[${suggestionIndex}].description`,
              "must contain 10 to 500 characters",
            ));
          }
        });
      }
    });
  }
  const script = content.videoScript;
  if (script === null || typeof script !== "object") {
    errors.push(formatError(
      "VideoScript",
      "videoScript",
      "must include intro, body, and conclusion",
    ));
  } else {
    for (const part of ["intro", "body", "conclusion"] as const) {
      if (typeof script[part] !== "string" || script[part].trim().length === 0) {
        errors.push(formatError(
          "VideoScript",
          `videoScript.${part}`,
          "must not be empty",
        ));
      }
    }
  }

  if (
    !Array.isArray(content.originLinks) ||
    !content.originLinks.some((link) => link === topic.sourceRef.url)
  ) {
    errors.push(formatError(
      "OriginLinks",
      "originLinks",
      "must include the topic origin link",
    ));
  }
  return Object.freeze(errors);
}

function formatError(
  format: GenerationFailureComponent,
  path: string,
  message: string,
): FormatError {
  return Object.freeze({ format, path, message });
}

function formatPath(format: ContentDraftFormat): string {
  switch (format) {
    case "FacebookPost": return "facebookPost";
    case "Guide": return "guide";
    case "VideoScript": return "videoScript";
  }
}

function failedResult(
  failureKind: FailedContentGenerationResult["failureKind"],
  errors: readonly FormatError[],
  metadata: GenerationReproducibilityMetadata,
  partialContent?: ContentDraft,
): FailedContentGenerationResult {
  const frozenErrors = Object.freeze(errors.map((error) => Object.freeze({ ...error })));
  const failingFormats = Object.freeze([
    ...new Set(frozenErrors.map(({ format }) => format)),
  ]);
  return Object.freeze({
    kind: "Failed",
    failureKind,
    failingFormats,
    errors: frozenErrors,
    ...(partialContent === undefined ? {} : { partialContent }),
    metadata: Object.freeze(metadata),
  });
}

function failureFromAbort(
  signal: Pick<AbortSignal, "aborted" | "reason">,
  metadata: GenerationReproducibilityMetadata,
): FailedContentGenerationResult {
  const deadline = signal.reason instanceof GenerationDeadlineExceededError;
  const message = deadline
    ? signal.reason.message
    : signal.reason instanceof Error
      ? signal.reason.message
      : "Model A generation was cancelled";
  return failedResult(
    deadline ? "DeadlineExceeded" : "Cancelled",
    CONTENT_DRAFT_FORMATS.map((format) => ({
      format,
      path: formatPath(format),
      message,
    })),
    metadata,
  );
}

function generationMetadata(
  modelA: ReproducibilityMetadata,
  researchResultId: string,
  inputHash: string,
  language: string,
  brandVoiceVersion: string | undefined,
  contentHash?: string,
): GenerationReproducibilityMetadata {
  return Object.freeze({
    modelA: Object.freeze({ ...modelA }),
    researchResultId,
    inputHash,
    ...(contentHash === undefined ? {} : { contentHash }),
    language,
    ...(brandVoiceVersion === undefined ? {} : { brandVoiceVersion }),
  });
}
function uniqueFormats(
  formats: readonly ContentDraftFormat[],
): ContentDraftFormat[] {
  const allowed = new Set<ContentDraftFormat>(CONTENT_DRAFT_FORMATS);
  const unique: ContentDraftFormat[] = [];
  for (const format of formats) {
    if (!allowed.has(format)) {
      throw new ContentGenerationInputError(`Unknown content format: ${format}`);
    }
    if (!unique.includes(format)) unique.push(format);
  }
  return unique;
}

function characterLength(value: string): number {
  return Array.from(value).length;
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

export function hashGenerationValue(value: unknown): string {
  return hashCanonical(value);
}

function hashCanonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
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
