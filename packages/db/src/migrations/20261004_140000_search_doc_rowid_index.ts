import type { Database } from "better-sqlite3";

/**
 * The search index's rowids, mapped to items without reading the documents (§5c, §20).
 *
 * Every text search and every "mentions" filter asked FTS5 for `mediaId`, an UNINDEXED column
 * of an external-content table -- so FTS5 fetched each match's whole `MediaSearchDoc` row (its
 * filename, OCR text, variants) to hand back one UUID. A one-letter search matches most of the
 * library, and on the production replica that was 1,160 pages of documents for one list of
 * ids, re-read by the count, the page and every facet statement. This index holds only the
 * pair, so `searchRepo.matchedIdsSql` reads it instead: ~160 pages for the whole library,
 * fewer for a narrow match, never a document.
 *
 * Neither column changes after insert -- the index stage's upsert keeps the row and its
 * `mediaId` -- so re-indexing an item never writes to it.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_MediaSearchDoc_rowid_mediaId"
            ON "MediaSearchDoc" ("rowid", "mediaId");`
    );
}

export function down(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS "idx_MediaSearchDoc_rowid_mediaId";`);
}
