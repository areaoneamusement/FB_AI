export type SourceType = "GitHub" | "Website" | "Forum";
export type SourceFilterMode = "Best" | "High" | "All";

export interface SourceConfig {
  readonly id: string;
  readonly type: SourceType;
  readonly url: string;
  readonly active: boolean;
  readonly priority: number;
  readonly filterMode: SourceFilterMode;
}

export interface SourceCursor {
  readonly sourceId: string;
  readonly cursor?: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly updatedAt: string;
}

export interface SourcePermission {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly termsVersion: string;
  readonly robotsCapturedAt: string;
}

export interface SourceReference {
  readonly sourceId: string;
  readonly captureId: string;
  readonly url: string;
  readonly capturedAt: string;
  readonly termsVersion: string;
}

export interface RawItem {
  readonly sourceId: string;
  readonly externalId: string;
  readonly canonicalUrl?: string;
  readonly normalizedContentHash: string;
  readonly publishedOrUpdatedAt: string;
  readonly title: string;
  readonly body: string;
  readonly github?: {
    readonly stars: number;
    readonly lastUpdatedAt: string;
    readonly changelog?: string;
  };
}

export interface FetchPage {
  readonly items: readonly RawItem[];
  readonly nextCursor?: SourceCursor;
}
