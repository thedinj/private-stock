import type { Database } from "better-sqlite3";

/**
 * Appearances (§5f "A person in a video"): one person in one item, what Suggestions shows and asks
 * about — rather than every face the stage kept, or a library-wide group.
 *
 * Written whole by the `faceAnchors` job each run, as `FaceMatch` is: the item's faces gathered at
 * `APPEARANCE_NEAR`, the clearest of them, whether it is legible, and the people's centre scored
 * against every reference. Nothing a person decides is filed against an appearance — decisions
 * land on its faces — so a run may make them again with new ids and lose nothing.
 *
 * `Face.appearanceId` is a plain column, so it can be dropped.
 *
 * Idempotent; the definitions are written out as `init.ts` writes them.
 */
const hasColumn = (db: Database, table: string, column: string): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE "name" = ?`).get(table, column) !==
    undefined;

export function up(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS "FaceAppearance" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "faceCount" INTEGER NOT NULL,
            "bestFaceId" TEXT NOT NULL CHECK(length("bestFaceId") <= 64),
            "legible" INTEGER CHECK("legible" IN (1)),
            "matchTagId" TEXT REFERENCES "Tag" ("id") ON DELETE SET NULL,
            "score" REAL,
            "second" REAL
        );

        CREATE INDEX IF NOT EXISTS "idx_FaceAppearance_media" ON "FaceAppearance" ("mediaId");

        CREATE INDEX IF NOT EXISTS "idx_FaceAppearance_match"
            ON "FaceAppearance" ("matchTagId", "score" DESC) WHERE "matchTagId" IS NOT NULL;`);

    if (!hasColumn(db, "Face", "appearanceId")) {
        db.exec(
            `ALTER TABLE "Face" ADD COLUMN "appearanceId" TEXT CHECK(length("appearanceId") <= 64);`
        );
    }

    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_Face_appearance" ON "Face" ("appearanceId") WHERE "appearanceId" IS NOT NULL;`
    );

    // The first appearances are made by the next references run: ask for one now, where there
    // are faces to make them from, as jobRepo.enqueueKind would.
    db.exec(
        `INSERT INTO "Job" ("id", "kind", "priority", "updatedAt")
         SELECT lower(hex(randomblob(16))), 'faceAnchors', 200, CURRENT_TIMESTAMP
          WHERE EXISTS (SELECT 1 FROM "Face")
            AND NOT EXISTS (SELECT 1 FROM "Job"
                             WHERE "kind" = 'faceAnchors' AND "state" IN ('pending', 'claimed'));`
    );
}

export function down(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS "idx_Face_appearance";`);

    if (hasColumn(db, "Face", "appearanceId")) {
        db.exec(`ALTER TABLE "Face" DROP COLUMN "appearanceId";`);
    }

    db.exec(`DROP INDEX IF EXISTS "idx_FaceAppearance_match";
             DROP INDEX IF EXISTS "idx_FaceAppearance_media";
             DROP TABLE IF EXISTS "FaceAppearance";`);
}
