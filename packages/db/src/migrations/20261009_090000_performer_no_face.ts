import type { Database } from "better-sqlite3";

/**
 * "No single face" (§5f "Performers with no single face"): a library performer whose face never
 * shows, or a name that is not one person — said once, by an administrator, and every part of
 * face matching then leaves them out: no reference, no evidence from their tags, nothing proposed
 * or tagged by a face. What was confirmed for them stays, ignored, so taking it back restores it.
 *
 * Idempotent; the definition is written out as `init.ts` writes it.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE TABLE IF NOT EXISTS "PerformerNoFace" (
            "tagId" TEXT NOT NULL PRIMARY KEY REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) WITHOUT ROWID;`
    );
}

export function down(db: Database): void {
    db.exec(`DROP TABLE IF EXISTS "PerformerNoFace";`);
}
