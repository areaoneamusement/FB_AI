import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import type {
  ModelAGenerationPort,
  ModelAGenerationRequest,
  ModelAGenerationResponse,
  ModelCallControl,
} from "../src/adapters/ports.js";
import type {
  ContentDraft,
  GuideSection,
  ReproducibilityMetadata,
  ResearchResult,
  Topic,
} from "../src/domain/content.js";
import {
  ContentGenerator,
  ModelFormatGenerationError,
  hashGenerationValue,
  type ContentDraftFormat,
  type ContentGenerationResult,
  type GenerateContentCommand,
  type GenerationFailureComponent,
} from "../src/pipeline/content-generator.js";

const RUNS = 200;
const NOW = new Date("2025-05-01T08:00:00.000Z");

const MODEL: ReproducibilityMetadata = {
  provider: "provider-a",
  model: "model-a",
  promptVersion: "prompt-v9",
  configurationVersion: "config-v2",
};

const ORIGIN_URL = "https://example.test/nguon-goc";

const TOPIC: Topic = {
  id: "topic-42",
  externalId: "external-42",
  title: "Công cụ AI mới nhất 😀",
  createdAt: NOW.toISOString(),
  score: { total: 88.5, breakdown: [], scoringConfigVersion: "score-v1" },
  categories: ["AI Tools"],
  sourceRef: {
    sourceId: "source-42",
    captureId: "capture-42",
    url: ORIGIN_URL,
    capturedAt: NOW.toISOString(),
    termsVersion: "terms-v1",
  },
};

const RESEARCH: ResearchResult = {
  id: "research-42",
  topicId: TOPIC.id,
  items: [
    {
      id: "item-1",
      content: "Thông tin có nguồn về công cụ AI.",
      kind: "Summarized",
      evidenceRefs: [TOPIC.sourceRef],
    },
  ],
  status: "Ok",
  unreachableSources: [],
};

const TOPIC_SNAPSHOT = structuredClone(TOPIC);
const RESEARCH_SNAPSHOT = structuredClone(RESEARCH);

// ---------------------------------------------------------------------------
// Unicode-aware text builders.
//
// Every pool entry is exactly one Unicode code point, so `textOfCodePoints`
// produces a string whose code-point length is exactly `length` while its
// UTF-16 `String.length` may be larger (astral plane) — this is what makes the
// boundary cases below discriminate code points from UTF-16 units.
// ---------------------------------------------------------------------------

const CHAR_KINDS = [
  "ascii",
  "vietnamese",
  "astral",
  "combining",
  "mixed",
] as const;
type CharKind = (typeof CHAR_KINDS)[number];

const POOLS: Record<CharKind, readonly string[]> = {
  ascii: ["A", "b", "c", "d", "1", "-", "."],
  vietnamese: ["ạ", "ắ", "ề", "ữ", "ơ", "Đ", "ệ", "ị"],
  // Outside the BMP: each is a single code point but two UTF-16 units.
  astral: ["😀", "🚀", "🧠", "𝔸", "𠀋"],
  // Base letters interleaved with combining marks.
  combining: ["e", "\u0301", "a", "\u0300", "n", "\u0303"],
  mixed: ["a", "ạ", "😀", "e", "\u0301", "🚀", "Đ"],
};

function textOfCodePoints(kind: CharKind, length: number): string {
  const pool = POOLS[kind];
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += pool[index % pool.length];
  }
  return text;
}

function codePointLength(value: string): number {
  return [...value].length;
}

// ---------------------------------------------------------------------------
// Independent model of Requirement 4.1 / 4.2 / 4.3 structural validity.
// ---------------------------------------------------------------------------

function expectedFailingComponents(
  content: ContentDraft,
  originUrl: string,
): readonly GenerationFailureComponent[] {
  const failing = new Set<GenerationFailureComponent>();

  const postLength = codePointLength(content.facebookPost);
  if (postLength < 50 || postLength > 5_000) failing.add("FacebookPost");

  if (content.guide.length < 3) failing.add("Guide");
  for (const section of content.guide) {
    if (section.heading.trim().length === 0) failing.add("Guide");
    if (section.body.trim().length === 0) failing.add("Guide");
    if (section.imageSuggestions.length < 1) failing.add("Guide");
    for (const suggestion of section.imageSuggestions) {
      const length = codePointLength(suggestion.description);
      if (length < 10 || length > 500) failing.add("Guide");
    }
  }

  const script = content.videoScript;
  for (const part of [script.intro, script.body, script.conclusion]) {
    if (part.trim().length === 0) failing.add("VideoScript");
  }

  if (!content.originLinks.includes(originUrl)) failing.add("OriginLinks");

  return sortedComponents([...failing]);
}

function sortedComponents(
  components: readonly GenerationFailureComponent[],
): readonly GenerationFailureComponent[] {
  return [...new Set(components)].sort((left, right) =>
    left.localeCompare(right),
  );
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Handler = (
  request: ModelAGenerationRequest,
  control: ModelCallControl,
) => ModelAGenerationResponse;

interface Harness {
  readonly generator: ContentGenerator;
  readonly generate: ReturnType<typeof vi.fn>;
  readonly requests: () => readonly ModelAGenerationRequest[];
}

function harness(handler: Handler): Harness {
  const generate = vi.fn(
    async (
      request: ModelAGenerationRequest,
      control: ModelCallControl,
    ): Promise<ModelAGenerationResponse> => handler(request, control),
  );
  const modelA: ModelAGenerationPort = { generate };
  return {
    generator: new ContentGenerator(modelA, {
      now: () => NOW,
      createId: (kind) => (kind === "draft" ? "draft-fixed" : "revision-fixed"),
    }),
    generate,
    requests: () =>
      generate.mock.calls.map(
        (call) => (call as [ModelAGenerationRequest, ModelCallControl])[0],
      ),
  };
}

function command(
  overrides: Partial<GenerateContentCommand> = {},
): GenerateContentCommand {
  return {
    topic: TOPIC,
    research: RESEARCH,
    requestedModel: MODEL,
    ...overrides,
  };
}

async function generateFrom(
  content: ContentDraft,
  overrides: Partial<GenerateContentCommand> = {},
): Promise<{ result: ContentGenerationResult; harness: Harness }> {
  const instance = harness(() => ({ content, provenance: MODEL }));
  const result = await instance.generator.generate(command(overrides));
  return { result, harness: instance };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const charKind = fc.constantFrom(...CHAR_KINDS);

/** Includes the exact Facebook-post boundaries required by the design. */
const POST_LENGTHS = [0, 1, 49, 50, 51, 120, 2_500, 4_999, 5_000, 5_001];
/** Includes the exact image-description boundaries required by the design. */
const DESCRIPTION_LENGTHS = [0, 1, 9, 10, 11, 250, 499, 500, 501];

type PartMode = "filled" | "empty" | "whitespace";
const partMode = fc.constantFrom<PartMode>("filled", "empty", "whitespace");

function videoPart(mode: PartMode, kind: CharKind): string {
  switch (mode) {
    case "filled":
      return textOfCodePoints(kind, 24);
    case "empty":
      return "";
    case "whitespace":
      return " \t\n ";
  }
}

type OriginMode = "origin" | "originAndExtra" | "otherOnly" | "empty";
const originMode = fc.constantFrom<OriginMode>(
  "origin",
  "originAndExtra",
  "otherOnly",
  "empty",
);

function originLinksOf(mode: OriginMode): readonly string[] {
  switch (mode) {
    case "origin":
      return [ORIGIN_URL];
    case "originAndExtra":
      return ["https://other.test/lien-quan", ORIGIN_URL];
    case "otherOnly":
      return ["https://other.test/lien-quan"];
    case "empty":
      return [];
  }
}

function validSection(kind: CharKind, index: number): GuideSection {
  return {
    heading: `Phần ${index + 1} ${textOfCodePoints(kind, 6)}`,
    body: textOfCodePoints(kind, 40),
    imageSuggestions: [{ description: textOfCodePoints(kind, 25) }],
  };
}

interface StructureSpec {
  readonly postKind: CharKind;
  readonly postLength: number;
  readonly sectionCount: number;
  readonly sectionKind: CharKind;
  readonly intro: PartMode;
  readonly body: PartMode;
  readonly conclusion: PartMode;
  readonly origin: OriginMode;
}

const structureSpec: fc.Arbitrary<StructureSpec> = fc.record({
  postKind: charKind,
  postLength: fc.constantFrom(...POST_LENGTHS),
  sectionCount: fc.constantFrom(0, 1, 2, 3, 4),
  sectionKind: charKind,
  intro: partMode,
  body: partMode,
  conclusion: partMode,
  origin: originMode,
});

function contentOfStructure(spec: StructureSpec): ContentDraft {
  return {
    // A deliberately wrong topic id: the generator must bind the command topic.
    topicId: "not-the-command-topic",
    facebookPost: textOfCodePoints(spec.postKind, spec.postLength),
    guide: Array.from({ length: spec.sectionCount }, (_unused, index) =>
      validSection(spec.sectionKind, index),
    ),
    videoScript: {
      intro: videoPart(spec.intro, spec.sectionKind),
      body: videoPart(spec.body, spec.sectionKind),
      conclusion: videoPart(spec.conclusion, spec.sectionKind),
    },
    originLinks: originLinksOf(spec.origin),
    // A non-default language the generator must override with the command value.
    language: "zz-model-choice",
  };
}

function structureExample(
  overrides: Partial<StructureSpec> = {},
): [StructureSpec] {
  return [
    {
      postKind: "vietnamese",
      postLength: 120,
      sectionCount: 3,
      sectionKind: "vietnamese",
      intro: "filled",
      body: "filled",
      conclusion: "filled",
      origin: "origin",
      ...overrides,
    },
  ];
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("Content_Generator properties", () => {
  // Feature: fb-ai, Property 14: Generated drafts satisfy the multi-format structure — Facebook post 50..5000 characters, guide with >=3 sections, video script with non-empty intro/body/conclusion, and >=1 origin link
  // **Validates: Requirements 4.1, 4.3**
  it("Property 14: generated drafts satisfy the multi-format structure", async () => {
    await fc.assert(
      fc.asyncProperty(structureSpec, async (spec) => {
        const content = contentOfStructure(spec);
        const expected = expectedFailingComponents(content, ORIGIN_URL);
        const { result, harness: instance } = await generateFrom(content);

        expect(instance.requests()).toHaveLength(1);

        if (expected.length > 0) {
          expect(result.kind).toBe("Failed");
          if (result.kind !== "Failed") return;
          expect(result.failureKind).toBe("Validation");
          expect(sortedComponents(result.failingFormats)).toEqual(expected);
          // A failed result never yields an advanceable revision.
          expect("revision" in result).toBe(false);
          return;
        }

        expect(result.kind).toBe("Generated");
        if (result.kind !== "Generated") return;
        const draft = result.revision.content;

        const postLength = codePointLength(draft.facebookPost);
        expect(postLength).toBeGreaterThanOrEqual(50);
        expect(postLength).toBeLessThanOrEqual(5_000);

        expect(draft.guide.length).toBeGreaterThanOrEqual(3);
        for (const section of draft.guide) {
          expect(section.heading.trim().length).toBeGreaterThan(0);
          expect(section.body.trim().length).toBeGreaterThan(0);
          expect(section.imageSuggestions.length).toBeGreaterThanOrEqual(1);
        }

        expect(draft.videoScript.intro.trim().length).toBeGreaterThan(0);
        expect(draft.videoScript.body.trim().length).toBeGreaterThan(0);
        expect(draft.videoScript.conclusion.trim().length).toBeGreaterThan(0);

        expect(draft.originLinks.length).toBeGreaterThanOrEqual(1);
        expect(draft.originLinks).toContain(ORIGIN_URL);

        expect(draft.topicId).toBe(TOPIC.id);
        expect(result.revision.revision).toBe(1);
        expect(result.revision.createdBy).toBe("System");
        expect(Object.isFrozen(result.revision)).toBe(true);

        // Determinism: identical inputs produce an identical content hash.
        expect(result.revision.contentHash).toBe(
          hashGenerationValue(result.revision.content),
        );
        expect(result.metadata.contentHash).toBe(result.revision.contentHash);
        const replay = await generateFrom(content);
        expect(replay.result.kind).toBe("Generated");
        if (replay.result.kind !== "Generated") return;
        expect(replay.result.revision.contentHash).toBe(
          result.revision.contentHash,
        );
        expect(replay.result.metadata.inputHash).toBe(
          result.metadata.inputHash,
        );
      }),
      {
        numRuns: RUNS,
        examples: [
          // Exact Facebook-post boundaries, measured in Unicode code points.
          structureExample({ postKind: "astral", postLength: 49 }),
          structureExample({ postKind: "astral", postLength: 50 }),
          structureExample({ postKind: "astral", postLength: 5_000 }),
          structureExample({ postKind: "astral", postLength: 5_001 }),
          structureExample({ postKind: "combining", postLength: 49 }),
          structureExample({ postKind: "combining", postLength: 50 }),
          structureExample({ postKind: "combining", postLength: 5_000 }),
          structureExample({ postKind: "combining", postLength: 5_001 }),
          structureExample({ postKind: "vietnamese", postLength: 49 }),
          structureExample({ postKind: "vietnamese", postLength: 50 }),
          structureExample({ postKind: "vietnamese", postLength: 5_000 }),
          structureExample({ postKind: "vietnamese", postLength: 5_001 }),
          // Structural boundaries for guide, video script, and origin links.
          structureExample({ sectionCount: 2 }),
          structureExample({ sectionCount: 3 }),
          structureExample({ conclusion: "whitespace" }),
          structureExample({ origin: "empty" }),
          structureExample({ origin: "otherOnly" }),
          structureExample({ origin: "originAndExtra" }),
        ],
      },
    );
  });

  // Feature: fb-ai, Property 15: Every guide section has at least one image suggestion with a description of 10..500 characters
  // **Validates: Requirements 4.2**
  it("Property 15: every guide section has a valid image suggestion", async () => {
    interface ImageSpec {
      readonly kind: CharKind;
      readonly length: number;
    }
    const imageSpec: fc.Arbitrary<ImageSpec> = fc.record({
      kind: charKind,
      length: fc.constantFrom(...DESCRIPTION_LENGTHS),
    });
    const sectionsSpec = fc.array(
      fc.array(imageSpec, { minLength: 0, maxLength: 3 }),
      { minLength: 3, maxLength: 4 },
    );

    await fc.assert(
      fc.asyncProperty(sectionsSpec, charKind, async (sections, textKind) => {
        const content: ContentDraft = {
          topicId: "not-the-command-topic",
          facebookPost: textOfCodePoints(textKind, 120),
          guide: sections.map((images, index) => ({
            heading: `Phần ${index + 1} ${textOfCodePoints(textKind, 6)}`,
            body: textOfCodePoints(textKind, 40),
            imageSuggestions: images.map((image) => ({
              description: textOfCodePoints(image.kind, image.length),
            })),
          })),
          videoScript: {
            intro: textOfCodePoints(textKind, 24),
            body: textOfCodePoints(textKind, 32),
            conclusion: textOfCodePoints(textKind, 20),
          },
          originLinks: [ORIGIN_URL],
          language: "zz-model-choice",
        };
        const expected = expectedFailingComponents(content, ORIGIN_URL);
        const { result } = await generateFrom(content);

        if (expected.length > 0) {
          expect(result.kind).toBe("Failed");
          if (result.kind !== "Failed") return;
          expect(result.failureKind).toBe("Validation");
          expect(sortedComponents(result.failingFormats)).toEqual(["Guide"]);
          expect("revision" in result).toBe(false);
          return;
        }

        expect(result.kind).toBe("Generated");
        if (result.kind !== "Generated") return;
        for (const section of result.revision.content.guide) {
          expect(section.imageSuggestions.length).toBeGreaterThanOrEqual(1);
          for (const suggestion of section.imageSuggestions) {
            const length = codePointLength(suggestion.description);
            expect(length).toBeGreaterThanOrEqual(10);
            expect(length).toBeLessThanOrEqual(500);
          }
        }
      }),
      {
        numRuns: RUNS,
        examples: [
          // Exact image-description boundaries in Unicode code points.
          [
            [
              [{ kind: "astral", length: 9 }],
              [{ kind: "astral", length: 10 }],
              [{ kind: "astral", length: 500 }],
            ],
            "vietnamese",
          ],
          [
            [
              [{ kind: "astral", length: 10 }],
              [{ kind: "astral", length: 500 }],
              [{ kind: "astral", length: 501 }],
            ],
            "astral",
          ],
          [
            [
              [{ kind: "combining", length: 9 }],
              [{ kind: "combining", length: 10 }],
              [{ kind: "combining", length: 501 }],
            ],
            "combining",
          ],
          [
            [
              [{ kind: "vietnamese", length: 10 }],
              [{ kind: "vietnamese", length: 500 }],
              [{ kind: "vietnamese", length: 250 }],
            ],
            "vietnamese",
          ],
          // A section with no image suggestion at all.
          [
            [
              [],
              [{ kind: "ascii", length: 10 }],
              [{ kind: "ascii", length: 10 }],
            ],
            "ascii",
          ],
        ],
      },
    );
  });

  // Feature: fb-ai, Property 16: Default language is Vietnamese (`vi`) when no language is configured, and a configured language is honoured exactly
  // **Validates: Requirements 4.5**
  it("Property 16: default language is Vietnamese and configured language is honoured", async () => {
    const languageSpec = fc.constantFrom<string | undefined>(
      undefined,
      "",
      "   ",
      "\t\n",
      "vi",
      "en",
      "ja",
      "vi-VN",
      "fr",
      " de ",
    );

    await fc.assert(
      fc.asyncProperty(languageSpec, charKind, async (language, textKind) => {
        const content: ContentDraft = {
          topicId: "not-the-command-topic",
          facebookPost: textOfCodePoints(textKind, 200),
          guide: [0, 1, 2].map((index) => validSection(textKind, index)),
          videoScript: {
            intro: textOfCodePoints(textKind, 24),
            body: textOfCodePoints(textKind, 32),
            conclusion: textOfCodePoints(textKind, 20),
          },
          originLinks: [ORIGIN_URL],
          language: "zz-model-choice",
        };
        const configured = language?.trim() ?? "";
        const expectedLanguage = configured.length === 0 ? "vi" : configured;

        const { result, harness: instance } = await generateFrom(
          content,
          language === undefined ? {} : { language },
        );

        expect(result.kind).toBe("Generated");
        if (result.kind !== "Generated") return;
        expect(result.revision.content.language).toBe(expectedLanguage);
        expect(result.metadata.language).toBe(expectedLanguage);
        expect(instance.requests()[0]?.language).toBe(expectedLanguage);
        if (configured.length === 0) {
          expect(result.revision.content.language).toBe("vi");
        }
      }),
      {
        numRuns: RUNS,
        examples: [
          [undefined, "vietnamese"],
          ["", "vietnamese"],
          ["   ", "astral"],
          ["vi", "vietnamese"],
          ["en", "ascii"],
          ["vi-VN", "combining"],
          [" de ", "mixed"],
        ],
      },
    );
  });

  // Feature: fb-ai, Property 17: Per-format failure preserves the research-completed state and reports exactly the failing format(s); a failed result never yields an advanceable revision
  // **Validates: Requirements 4.6**
  it("Property 17: per-format failure preserves research state and reports the failing formats", async () => {
    const formats = fc.uniqueArray(
      fc.constantFrom<ContentDraftFormat>(
        "FacebookPost",
        "Guide",
        "VideoScript",
      ),
      { minLength: 1, maxLength: 3 },
    );
    type FailureSpec =
      | {
          readonly mode: "adapterFormats";
          readonly formats: readonly ContentDraftFormat[];
          readonly withPartial: boolean;
        }
      | { readonly mode: "adapterError"; readonly message: string }
      | {
          readonly mode: "validation";
          readonly breakPost: boolean;
          readonly breakGuide: boolean;
          readonly breakVideo: boolean;
          readonly breakOrigin: boolean;
        };

    const failureSpec: fc.Arbitrary<FailureSpec> = fc.oneof(
      fc.record({
        mode: fc.constant("adapterFormats" as const),
        formats,
        withPartial: fc.boolean(),
      }),
      fc.record({
        mode: fc.constant("adapterError" as const),
        message: fc.string({ minLength: 1, maxLength: 40 }),
      }),
      fc
        .record({
          mode: fc.constant("validation" as const),
          breakPost: fc.boolean(),
          breakGuide: fc.boolean(),
          breakVideo: fc.boolean(),
          breakOrigin: fc.boolean(),
        })
        .filter(
          (spec) =>
            spec.breakPost ||
            spec.breakGuide ||
            spec.breakVideo ||
            spec.breakOrigin,
        ),
    );

    const validDraft: ContentDraft = {
      topicId: "not-the-command-topic",
      facebookPost: textOfCodePoints("vietnamese", 200),
      guide: [0, 1, 2].map((index) => validSection("vietnamese", index)),
      videoScript: {
        intro: textOfCodePoints("vietnamese", 24),
        body: textOfCodePoints("vietnamese", 32),
        conclusion: textOfCodePoints("vietnamese", 20),
      },
      originLinks: [ORIGIN_URL],
      language: "zz-model-choice",
    };

    await fc.assert(
      fc.asyncProperty(failureSpec, async (spec) => {
        let expected: readonly GenerationFailureComponent[];
        let instance: Harness;

        if (spec.mode === "adapterFormats") {
          expected = sortedComponents(spec.formats);
          instance = harness(() => {
            throw new ModelFormatGenerationError(
              "định dạng thất bại",
              spec.formats,
              spec.withPartial ? validDraft : undefined,
            );
          });
        } else if (spec.mode === "adapterError") {
          expected = sortedComponents([
            "FacebookPost",
            "Guide",
            "VideoScript",
          ]);
          instance = harness(() => {
            throw new Error(spec.message);
          });
        } else {
          const broken: ContentDraft = {
            ...validDraft,
            ...(spec.breakPost ? { facebookPost: "quá ngắn" } : {}),
            ...(spec.breakGuide
              ? { guide: [validSection("vietnamese", 0)] }
              : {}),
            ...(spec.breakVideo
              ? {
                  videoScript: {
                    ...validDraft.videoScript,
                    conclusion: "   ",
                  },
                }
              : {}),
            ...(spec.breakOrigin ? { originLinks: [] } : {}),
          };
          expected = expectedFailingComponents(broken, ORIGIN_URL);
          instance = harness(() => ({ content: broken, provenance: MODEL }));
        }

        const result = await instance.generator.generate(command());

        expect(result.kind).toBe("Failed");
        if (result.kind !== "Failed") return;

        // Exactly the failing format(s) are reported.
        expect(sortedComponents(result.failingFormats)).toEqual(expected);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(
          sortedComponents(result.errors.map((error) => error.format)),
        ).toEqual(expected);
        expect(result.failureKind).toBe(
          spec.mode === "validation" ? "Validation" : "ModelError",
        );

        // A failed result never yields an advanceable revision.
        expect("revision" in result).toBe(false);
        if (result.partialContent !== undefined) {
          expect(Object.isFrozen(result.partialContent)).toBe(true);
        }

        // The research-completed inputs are preserved untouched, and the failed
        // result still points at the research result it was generated from.
        expect(result.metadata.researchResultId).toBe(RESEARCH.id);
        expect(result.metadata.inputHash).toMatch(/^[a-f0-9]{64}$/);
        expect(TOPIC).toEqual(TOPIC_SNAPSHOT);
        expect(RESEARCH).toEqual(RESEARCH_SNAPSHOT);
        expect(RESEARCH.status).toBe("Ok");
      }),
      {
        numRuns: RUNS,
        examples: [
          [{ mode: "adapterFormats", formats: ["Guide"], withPartial: true }],
          [
            {
              mode: "adapterFormats",
              formats: ["FacebookPost", "VideoScript"],
              withPartial: false,
            },
          ],
          [
            {
              mode: "adapterFormats",
              formats: ["FacebookPost", "Guide", "VideoScript"],
              withPartial: true,
            },
          ],
          [{ mode: "adapterError", message: "Model A không phản hồi" }],
          [
            {
              mode: "validation",
              breakPost: true,
              breakGuide: false,
              breakVideo: false,
              breakOrigin: false,
            },
          ],
          [
            {
              mode: "validation",
              breakPost: false,
              breakGuide: false,
              breakVideo: false,
              breakOrigin: true,
            },
          ],
          [
            {
              mode: "validation",
              breakPost: true,
              breakGuide: true,
              breakVideo: true,
              breakOrigin: true,
            },
          ],
        ],
      },
    );
  });
});

describe("Content_Generator brand voice (Requirement 4.4)", () => {
  const draft: ContentDraft = {
    topicId: "not-the-command-topic",
    facebookPost: textOfCodePoints("vietnamese", 200),
    guide: [0, 1, 2].map((index) => validSection("vietnamese", index)),
    videoScript: {
      intro: textOfCodePoints("vietnamese", 24),
      body: textOfCodePoints("vietnamese", 32),
      conclusion: textOfCodePoints("vietnamese", 20),
    },
    originLinks: [ORIGIN_URL],
    language: "zz-model-choice",
  };

  it("propagates a configured brand voice version into generation and reproducibility metadata", async () => {
    const configured = await generateFrom(draft, {
      brandVoiceVersion: " friendly-v7 ",
    });
    expect(configured.result.kind).toBe("Generated");
    if (configured.result.kind !== "Generated") return;

    expect(configured.harness.requests()[0]?.brandVoiceVersion).toBe(
      "friendly-v7",
    );
    expect(configured.result.revision.content.brandVoiceVersion).toBe(
      "friendly-v7",
    );
    expect(configured.result.metadata.brandVoiceVersion).toBe("friendly-v7");
    expect(configured.result.metadata.modelA).toEqual(MODEL);

    const unstyled = await generateFrom(draft);
    expect(unstyled.result.kind).toBe("Generated");
    if (unstyled.result.kind !== "Generated") return;

    expect(unstyled.harness.requests()[0]?.brandVoiceVersion).toBeUndefined();
    expect(
      unstyled.result.revision.content.brandVoiceVersion,
    ).toBeUndefined();
    expect(unstyled.result.metadata.brandVoiceVersion).toBeUndefined();

    // The brand voice version is part of the reproducible generation input.
    expect(configured.result.metadata.inputHash).not.toBe(
      unstyled.result.metadata.inputHash,
    );
    expect(configured.result.revision.contentHash).not.toBe(
      unstyled.result.revision.contentHash,
    );
  });
});
