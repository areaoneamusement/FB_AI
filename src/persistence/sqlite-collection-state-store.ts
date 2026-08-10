import type Database from "better-sqlite3";

import type { SourceCursor } from "../domain/source.js";
import type {
  CollectedSourceItem,
  CollectionStateStore,
} from "../pipeline/source-collector.js";

interface CursorRow { readonly payload: string }

/** SQLite-backed durable cursors and collection deduplication for SourceCollector. */
export class SqliteCollectionStateStore implements CollectionStateStore {
  public constructor(private readonly database: Database.Database) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS collection_cursors (
        source_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collected_source_items (
        source_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        canonical_url TEXT,
        normalized_content_hash TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        PRIMARY KEY (source_id, external_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS collected_source_items_canonical_url
        ON collected_source_items(canonical_url) WHERE canonical_url IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS collected_source_items_content_hash
        ON collected_source_items(normalized_content_hash)
        WHERE normalized_content_hash <> '';
    `);
  }

  public async getCursor(sourceId: string): Promise<SourceCursor | undefined> {
    const row = this.database
      .prepare("SELECT payload FROM collection_cursors WHERE source_id = ?")
      .get(sourceId) as CursorRow | undefined;
    return row === undefined ? undefined : JSON.parse(row.payload) as SourceCursor;
  }

  public async saveCursor(cursor: SourceCursor): Promise<void> {
    this.database.prepare(`
      INSERT INTO collection_cursors (source_id, payload) VALUES (?, ?)
      ON CONFLICT(source_id) DO UPDATE SET payload = excluded.payload
    `).run(cursor.sourceId, JSON.stringify(cursor));
  }

  public async acceptIfNew(item: CollectedSourceItem): Promise<boolean> {
    const existing = this.database.prepare(`
      SELECT 1 FROM collected_source_items
      WHERE (source_id = ? AND external_id = ?)
         OR (? IS NOT NULL AND canonical_url = ?)
         OR (? <> '' AND normalized_content_hash = ?)
      LIMIT 1
    `).get(
      item.sourceId,
      item.externalId,
      item.canonicalUrl ?? null,
      item.canonicalUrl ?? null,
      item.normalizedContentHash,
      item.normalizedContentHash,
    );
    if (existing !== undefined) return false;
    try {
      this.database.prepare(`
        INSERT INTO collected_source_items
          (source_id, external_id, canonical_url, normalized_content_hash, collected_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        item.sourceId,
        item.externalId,
        item.canonicalUrl ?? null,
        item.normalizedContentHash,
        item.collectedAt,
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        return false;
      }
      throw error;
    }
  }
}
