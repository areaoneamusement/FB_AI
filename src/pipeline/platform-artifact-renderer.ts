import { createHash } from "node:crypto";

import type {
  DraftRevision,
  ImageSuggestion,
  PlatformArtifact,
  TargetPlatform,
  Topic,
} from "../domain/content.js";

export interface RenderPlatformArtifactsCommand {
  readonly revision: DraftRevision;
  readonly topic: Topic;
  readonly platforms: readonly TargetPlatform[];
}

export interface PlatformArtifactRendererOptions {
  readonly rendererVersion: string;
  readonly now?: () => string;
}

/** Pure, deterministic rendering of the exact bytes checked and approved later. */
export class PlatformArtifactRenderer {
  readonly #rendererVersion: string;
  readonly #now: () => string;

  public constructor(options: PlatformArtifactRendererOptions) {
    if (options.rendererVersion.trim().length === 0) {
      throw new Error("rendererVersion is required");
    }
    this.#rendererVersion = options.rendererVersion;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public render(command: RenderPlatformArtifactsCommand): readonly PlatformArtifact[] {
    if (command.revision.content.topicId !== command.topic.id) {
      throw new Error("Draft revision does not belong to the rendered topic");
    }
    const platforms = [...new Set(command.platforms)];
    if (platforms.length === 0 || platforms.length !== command.platforms.length) {
      throw new Error("At least one unique target platform is required");
    }
    const createdAt = this.#now();
    if (!Number.isFinite(Date.parse(createdAt))) {
      throw new Error("Artifact renderer clock returned an invalid timestamp");
    }
    return Object.freeze(platforms.map((platform) =>
      this.renderOne(command.revision, command.topic, platform, createdAt),
    ));
  }
  private renderOne(
    revision: DraftRevision,
    topic: Topic,
    platform: TargetPlatform,
    createdAt: string,
  ): PlatformArtifact {
    const content = revision.content;
    const attribution = content.originLinks.map((url) => `Nguồn: ${url}`).join("\n");
    const imageSuggestions = freezeSuggestions(
      content.guide.flatMap((section) => section.imageSuggestions),
    );
    const body = platform === "YouTube"
      ? [content.videoScript.intro, content.videoScript.body, content.videoScript.conclusion]
          .join("\n\n")
      : content.facebookPost;
    const metadata: Readonly<Record<string, string>> = platform === "YouTube"
      ? Object.freeze<Record<string, string>>({
          title: topic.title,
          description: `${content.facebookPost}\n\n${attribution}`,
          tags: topic.categories.join(","),
        })
      : Object.freeze<Record<string, string>>({});
    const hashPayload = {
      draftRevisionId: revision.id,
      contentHash: revision.contentHash,
      platform,
      rendererVersion: this.#rendererVersion,
      body,
      metadata,
      attribution,
      imageSuggestions,
    };
    const artifactHash = hashArtifactValue(hashPayload);
    return Object.freeze({
      id: `artifact-${artifactHash}`,
      draftRevisionId: revision.id,
      platform,
      rendererVersion: this.#rendererVersion,
      body,
      metadata,
      attribution,
      imageSuggestions,
      artifactHash,
      createdAt,
    });
  }
}

function freezeSuggestions(
  suggestions: readonly ImageSuggestion[],
): readonly ImageSuggestion[] {
  return Object.freeze(
    suggestions.map((suggestion) => Object.freeze({ ...suggestion })),
  );
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

export function hashArtifactValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}
