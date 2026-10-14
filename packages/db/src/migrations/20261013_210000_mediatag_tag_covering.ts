import type { Database } from "better-sqlite3";

/**
 * `idx_MediaTag_tagId` becomes `("tagId", "userId", "mediaId")`, so the facet statements never
 * read a `MediaTag` row (§20 "Facet values come from the vocabulary").
 *
 * Every facet statement walks a tag's assignments and asks two things of each: whose it is
 * (`userId`, the scope) and which item it is on (`mediaId`, the join). The old index held only
 * `tagId`, so each assignment cost a probe into the table for those two columns -- a random page
 * per assignment, which on the NAS's disks is what a 3.5 s facet count was made of. Covered,
 * the walk stays inside the index.
 *
 * Replaced rather than added beside it: the wider index answers every `tagId` lookup the old
 * one did, and keeping both would be a second B-tree write on every tag applied.
 *
 * Idempotent: `IF EXISTS`/`IF NOT EXISTS` throughout, and the name is kept so nothing that
 * names it changes.
 */
export function up(db: Database): void {
    db.exec(`
        DROP INDEX IF EXISTS "idx_MediaTag_tagId";
        CREATE INDEX IF NOT EXISTS "idx_MediaTag_tagId"
            ON "MediaTag" ("tagId", "userId", "mediaId");
    `);
}

export function down(db: Database): void {
    db.exec(`
        DROP INDEX IF EXISTS "idx_MediaTag_tagId";
        CREATE INDEX IF NOT EXISTS "idx_MediaTag_tagId" ON "MediaTag" ("tagId");
    `);
}
