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
  /**
   * Set when this page is the last one for this cycle, even though `nextCursor` carries a
   * checkpoint worth saving.
   *
   * Without it a fetcher had only two ways to answer, and neither fits: omit the cursor and
   * lose the high-water mark, or return one and be asked for another page. The GitHub
   * fetcher takes the second, so every source spent an extra request re-reading page one at
   * the end of each cycle, and could trip the cursor-cycle guard doing it.
   */
  readonly exhausted?: boolean;
}
