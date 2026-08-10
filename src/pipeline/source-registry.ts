import type {
  SourceConfig,
  SourceFilterMode,
  SourceType,
} from "../domain/source.js";

export const SUPPORTED_SOURCE_TYPES = ["GitHub", "Website", "Forum"] as const;
export const MAX_SOURCES_PER_TYPE = 500;

const FILTER_MODE_RANK: Readonly<Record<SourceFilterMode, number>> = {
  Best: 0,
  High: 1,
  All: 2,
};

export class SourceRegistry {
  private readonly sources = new Map<string, SourceConfig>();

  public constructor(initialSources: readonly SourceConfig[] = []) {
    for (const source of initialSources) this.add(source);
  }

  public static readonly supportedTypes: readonly SourceType[] =
    SUPPORTED_SOURCE_TYPES;

  public add(source: SourceConfig): void {
    if (this.sources.has(source.id)) {
      throw new Error(`Source id already exists: ${source.id}`);
    }
    if (!SUPPORTED_SOURCE_TYPES.includes(source.type)) {
      throw new Error(`Unsupported source type: ${String(source.type)}`);
    }

    const countForType = [...this.sources.values()].filter(
      (candidate) => candidate.type === source.type,
    ).length;
    if (countForType >= MAX_SOURCES_PER_TYPE) {
      throw new Error(
        `Source type ${source.type} cannot exceed ${MAX_SOURCES_PER_TYPE} sources`,
      );
    }

    this.sources.set(source.id, source);
  }

  public remove(sourceId: string): boolean {
    return this.sources.delete(sourceId);
  }

  public get(sourceId: string): SourceConfig | undefined {
    return this.sources.get(sourceId);
  }

  public list(options: { readonly activeOnly?: boolean } = {}): readonly SourceConfig[] {
    const activeOnly = options.activeOnly ?? false;
    return [...this.sources.values()]
      .filter((source) => !activeOnly || source.active)
      .sort(compareSources);
  }

  public count(type?: SourceType): number {
    if (type === undefined) return this.sources.size;
    return [...this.sources.values()].filter((source) => source.type === type)
      .length;
  }
}

function compareSources(left: SourceConfig, right: SourceConfig): number {
  const filterDifference =
    FILTER_MODE_RANK[left.filterMode] - FILTER_MODE_RANK[right.filterMode];
  if (filterDifference !== 0) return filterDifference;

  const priorityDifference = right.priority - left.priority;
  if (priorityDifference !== 0) return priorityDifference;

  return left.id.localeCompare(right.id);
}
