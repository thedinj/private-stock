import type { Database } from "better-sqlite3";

/**
 * Tagging by itself (§5f "Tagging by itself"): what the rule would tag, and what became of it.
 *
 * `proposed` — the rule says so and nobody has looked; `right` and `wrong` — somebody checked it
 * in the "Would tag" list, which is how the rule is measured before it tags anything; `applied`
 * — tagged by itself; `removed` — tagged by itself and taken back, which is how it is measured
 * after. A row checked or applied stays, so the rule never proposes it again; `proposed` rows are
 * rewritten on every run.
 *
 * Idempotent; the definition is written out as `init.ts` writes it.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE TABLE IF NOT EXISTS "FaceAutoTag" (
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "faceId" TEXT REFERENCES "Face" ("id") ON DELETE SET NULL,
            "score" REAL NOT NULL,
            "strongFaces" INTEGER NOT NULL,
            "named" INTEGER CHECK("named" IN (1)),
            "state" TEXT NOT NULL
                CHECK("state" IN ('proposed', 'right', 'wrong', 'applied', 'removed')),
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY ("mediaId", "tagId")
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS "idx_FaceAutoTag_state" ON "FaceAutoTag" ("state", "tagId");`
    );
}

export function down(db: Database): void {
    db.exec(`DROP TABLE IF EXISTS "FaceAutoTag";`);
}
