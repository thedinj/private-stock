import type { Database } from "better-sqlite3";

/**
 * Reviewing what OCR read (§5d "Reviewing what was read").
 *
 * Two things:
 *
 *  - **Review columns on `MediaText`.** A finding can be confirmed, corrected or dismissed, and a
 *    re-run replaces only the findings nobody has reviewed. A dismissed row is kept rather than
 *    deleted: it is what tells the next run that this string was seen and rejected.
 *  - **`MediaTextString`, one row per distinct string**, kept by triggers. The review page
 *    lists strings across the library, and grouping hundreds of thousands of findings on every
 *    scroll is not affordable. It is backfilled here from the findings that already exist, all
 *    of which are unreviewed.
 *
 * Idempotent, like every migration here: a database built by `init.ts` already has all of this
 * and is then stamped by replaying the history. The definitions are written out exactly as
 * `init.ts` writes them, because the drift test compares the stored SQL.
 */

const COLUMNS: [name: string, definition: string][] = [
    [
        "reviewState",
        `"reviewState" TEXT CHECK("reviewState" IS NULL OR "reviewState" IN ('confirmed', 'edited', 'dismissed'))`,
    ],
    [
        "originalText",
        `"originalText" TEXT CHECK("originalText" IS NULL OR length("originalText") BETWEEN 1 AND 500)`,
    ],
    ["reviewedByUserId", `"reviewedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL`],
    ["reviewedAt", `"reviewedAt" DATETIME`],
];

const hasColumn = (db: Database, name: string): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('MediaText') WHERE "name" = ?`).get(name) !==
    undefined;

const hasTable = (db: Database): boolean =>
    db
        .prepare(
            `SELECT 1 FROM sqlite_master WHERE "type" = 'table' AND "name" = 'MediaTextString'`
        )
        .get() !== undefined;

const UPSERT_NEW = `INSERT INTO "MediaTextString" ("textNorm", "text", "rowCount", "unreviewedCount", "confirmedCount", "editedCount", "dismissedCount", "confidenceSum", "stabilitySum")
            VALUES (new."textNorm", new."text", 1, new."reviewState" IS NULL, COALESCE(new."reviewState" = 'confirmed', 0), COALESCE(new."reviewState" = 'edited', 0), COALESCE(new."reviewState" = 'dismissed', 0), new."confidence", new."stability")
            ON CONFLICT ("textNorm") DO UPDATE SET
                "text" = excluded."text",
                "rowCount" = "rowCount" + 1,
                "unreviewedCount" = "unreviewedCount" + excluded."unreviewedCount",
                "confirmedCount" = "confirmedCount" + excluded."confirmedCount",
                "editedCount" = "editedCount" + excluded."editedCount",
                "dismissedCount" = "dismissedCount" + excluded."dismissedCount",
                "confidenceSum" = "confidenceSum" + excluded."confidenceSum",
                "stabilitySum" = "stabilitySum" + excluded."stabilitySum";`;

const SUBTRACT_OLD = `UPDATE "MediaTextString" SET
                "rowCount" = "rowCount" - 1,
                "unreviewedCount" = "unreviewedCount" - (old."reviewState" IS NULL),
                "confirmedCount" = "confirmedCount" - COALESCE(old."reviewState" = 'confirmed', 0),
                "editedCount" = "editedCount" - COALESCE(old."reviewState" = 'edited', 0),
                "dismissedCount" = "dismissedCount" - COALESCE(old."reviewState" = 'dismissed', 0),
                "confidenceSum" = "confidenceSum" - old."confidence",
                "stabilitySum" = "stabilitySum" - old."stability"
            WHERE "textNorm" = old."textNorm";
            DELETE FROM "MediaTextString" WHERE "textNorm" = old."textNorm" AND "rowCount" <= 0;`;

export function up(db: Database): void {
    for (const [name, definition] of COLUMNS) {
        if (!hasColumn(db, name)) {
            db.exec(`ALTER TABLE "MediaText" ADD COLUMN ${definition};`);
        }
    }

    const backfill = !hasTable(db);

    db.exec(`
        CREATE INDEX IF NOT EXISTS "idx_MediaText_textNorm" ON "MediaText" ("textNorm", "mediaId");
        CREATE INDEX IF NOT EXISTS "idx_MediaText_unreviewed"
            ON "MediaText" ("mediaId") WHERE "reviewState" IS NULL;

        CREATE TABLE IF NOT EXISTS "MediaTextString" (
            "textNorm" TEXT NOT NULL PRIMARY KEY,
            "text" TEXT NOT NULL,
            "rowCount" INTEGER NOT NULL,
            "unreviewedCount" INTEGER NOT NULL,
            "confirmedCount" INTEGER NOT NULL,
            "editedCount" INTEGER NOT NULL,
            "dismissedCount" INTEGER NOT NULL,
            "confidenceSum" REAL NOT NULL,
            "stabilitySum" REAL NOT NULL
        );

        CREATE INDEX IF NOT EXISTS "idx_MediaTextString_count"
            ON "MediaTextString" (-"rowCount", "textNorm");
        CREATE INDEX IF NOT EXISTS "idx_MediaTextString_confidence"
            ON "MediaTextString" ("confidenceSum" / "rowCount", "textNorm");
        CREATE INDEX IF NOT EXISTS "idx_MediaTextString_unreviewed_count"
            ON "MediaTextString" (-"rowCount", "textNorm") WHERE "unreviewedCount" > 0;
        CREATE INDEX IF NOT EXISTS "idx_MediaTextString_unreviewed_confidence"
            ON "MediaTextString" ("confidenceSum" / "rowCount", "textNorm") WHERE "unreviewedCount" > 0;
        CREATE INDEX IF NOT EXISTS "idx_MediaTextString_unreviewed_text"
            ON "MediaTextString" ("textNorm") WHERE "unreviewedCount" > 0;
    `);

    // Before the triggers exist, so no row is counted twice. Every existing finding predates
    // review, so all of them are unreviewed.
    if (backfill) {
        db.exec(`
            INSERT INTO "MediaTextString"
                ("textNorm", "text", "rowCount", "unreviewedCount", "confirmedCount",
                 "editedCount", "dismissedCount", "confidenceSum", "stabilitySum")
            SELECT "textNorm", MAX("text"), COUNT(*), COUNT(*), 0, 0, 0,
                   SUM("confidence"), SUM("stability")
              FROM "MediaText"
             GROUP BY "textNorm";
        `);
    }

    db.exec(`
        CREATE TRIGGER IF NOT EXISTS "MediaText_string_ai"
        AFTER INSERT ON "MediaText"
        BEGIN
            ${UPSERT_NEW}
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaText_string_ad"
        AFTER DELETE ON "MediaText"
        BEGIN
            ${SUBTRACT_OLD}
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaText_string_au"
        AFTER UPDATE OF "textNorm", "text", "reviewState", "confidence", "stability" ON "MediaText"
        BEGIN
            ${SUBTRACT_OLD}
            ${UPSERT_NEW}
        END;
    `);
}

/**
 * Development only. The columns go by rebuilding the table, because SQLite will not drop a
 * column that carries a foreign key.
 */
export function down(db: Database): void {
    db.exec(`
        DROP TRIGGER IF EXISTS "MediaText_string_au";
        DROP TRIGGER IF EXISTS "MediaText_string_ad";
        DROP TRIGGER IF EXISTS "MediaText_string_ai";
        DROP TABLE IF EXISTS "MediaTextString";
        DROP INDEX IF EXISTS "idx_MediaText_unreviewed";
        DROP INDEX IF EXISTS "idx_MediaText_textNorm";
    `);

    if (!hasColumn(db, "reviewState")) {
        return;
    }

    db.exec(`
        CREATE TABLE "MediaText_down" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "text" TEXT NOT NULL CHECK(length("text") BETWEEN 1 AND 500),
            "textNorm" TEXT NOT NULL CHECK(length("textNorm") BETWEEN 1 AND 500),
            "firstAtMs" INTEGER,
            "lastAtMs" INTEGER,
            "confidence" REAL NOT NULL CHECK("confidence" BETWEEN 0 AND 1),
            "occurrences" INTEGER NOT NULL CHECK("occurrences" >= 1),
            "stability" REAL NOT NULL CHECK("stability" BETWEEN 0 AND 1),
            "boxX" REAL,
            "boxY" REAL,
            "boxW" REAL,
            "boxH" REAL,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE
        );
        INSERT INTO "MediaText_down"
            SELECT "id", "mediaId", "text", "textNorm", "firstAtMs", "lastAtMs", "confidence",
                   "occurrences", "stability", "boxX", "boxY", "boxW", "boxH", "createdAt"
              FROM "MediaText";
        DROP TABLE "MediaText";
        ALTER TABLE "MediaText_down" RENAME TO "MediaText";
        CREATE INDEX IF NOT EXISTS "idx_MediaText_mediaId" ON "MediaText" ("mediaId");
    `);
}
