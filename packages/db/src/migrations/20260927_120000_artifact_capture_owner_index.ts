import type { Database } from "better-sqlite3";

/**
 * Index a person's captures, for the Captures page (§9 "Your captures, in one place").
 *
 * The page lists `kind = 'capture' AND createdByUserId = :me`, newest first, a page at a time.
 * Nothing indexed `createdByUserId`, and `Artifact` holds every cover, poster, preview, sprite
 * sheet and VTT the pipeline has made — five to ten rows an item, a million or two at the scale
 * this app is built for. Every page and every count would have scanned all of them to find a
 * few hundred stills.
 *
 * Partial on `kind = 'capture'` rather than `source = 'user'`: the latter would also hold each
 * capture's 640px `cover-n` rendering, doubling the index for rows the page never lists. It also
 * means the generator's `auto` output never enters the index, so the pipeline pays nothing for
 * it. `generatedAt DESC` second, because a capture row is written once and never regenerated —
 * its `generatedAt` is when it was taken — so the default sort walks the index in order and
 * `LIMIT … OFFSET` needs no temp B-tree. The other sorts still sort, but only this user's rows.
 */
export function up(db: Database): void {
    db.exec(`
        CREATE INDEX IF NOT EXISTS "idx_Artifact_capture_owner"
            ON "Artifact" ("createdByUserId", "generatedAt" DESC)
            WHERE "kind" = 'capture';
    `);
}

export function down(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS "idx_Artifact_capture_owner";`);
}
