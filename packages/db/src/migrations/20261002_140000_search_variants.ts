import type { Database } from "better-sqlite3";

/**
 * A `variants` column in the search document (§5c "Word boundaries").
 *
 * The other spellings of an item's curated text -- adjacent words glued, known names found
 * inside glued words -- so that "auntmargaret" and "aunt margaret" find each other whichever way
 * round the library and the searcher wrote them.
 *
 * An FTS5 table cannot gain a column, so the index is dropped and recreated with it, along with
 * the three sync triggers that name every column. The document table keeps its rows and gains
 * the column empty; `rebuild` re-reads every row into the new index so nothing becomes
 * unsearchable in the meantime, and the `index` stage's version bump fills the column in
 * through the ordinary job queue.
 */

const DROP_INDEX = `
        DROP TRIGGER IF EXISTS "MediaSearchDoc_ai";
        DROP TRIGGER IF EXISTS "MediaSearchDoc_ad";
        DROP TRIGGER IF EXISTS "MediaSearchDoc_au";
        DROP TABLE IF EXISTS "MediaSearch";
`;

const REBUILD = `INSERT INTO "MediaSearch" ("MediaSearch") VALUES ('rebuild');`;

/** Verbatim from `init.ts`:the drift test compares virtual tables and triggers as text. */
const WITH_VARIANTS = `
        CREATE VIRTUAL TABLE IF NOT EXISTS "MediaSearch" USING fts5(
            "mediaId" UNINDEXED,
            "filename",
            "title",
            "performers",
            "tags",
            "attributes",
            "notes",
            "ocr",
            "variants",
            content = 'MediaSearchDoc',
            content_rowid = 'rowid',
            tokenize = 'porter unicode61 remove_diacritics 2',
            prefix = '2 3'
        );

        CREATE TRIGGER IF NOT EXISTS "MediaSearchDoc_ai"
        AFTER INSERT ON "MediaSearchDoc" BEGIN
            INSERT INTO "MediaSearch" (
                "rowid", "mediaId", "filename", "title", "performers",
                "tags", "attributes", "notes", "ocr", "variants"
            ) VALUES (
                new."rowid", new."mediaId", new."filename", new."title", new."performers",
                new."tags", new."attributes", new."notes",
                new."ocr", new."variants"
            );
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaSearchDoc_ad"
        AFTER DELETE ON "MediaSearchDoc" BEGIN
            INSERT INTO "MediaSearch" (
                "MediaSearch", "rowid", "mediaId", "filename", "title", "performers",
                "tags", "attributes", "notes", "ocr", "variants"
            ) VALUES (
                'delete', old."rowid", old."mediaId", old."filename", old."title",
                old."performers", old."tags",
                old."attributes", old."notes", old."ocr", old."variants"
            );
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaSearchDoc_au"
        AFTER UPDATE ON "MediaSearchDoc" BEGIN
            INSERT INTO "MediaSearch" (
                "MediaSearch", "rowid", "mediaId", "filename", "title", "performers",
                "tags", "attributes", "notes", "ocr", "variants"
            ) VALUES (
                'delete', old."rowid", old."mediaId", old."filename", old."title",
                old."performers", old."tags",
                old."attributes", old."notes", old."ocr", old."variants"
            );
            INSERT INTO "MediaSearch" (
                "rowid", "mediaId", "filename", "title", "performers",
                "tags", "attributes", "notes", "ocr", "variants"
            ) VALUES (
                new."rowid", new."mediaId", new."filename", new."title", new."performers",
                new."tags", new."attributes", new."notes",
                new."ocr", new."variants"
            );
        END;
`;

const WITHOUT_VARIANTS = `
        CREATE VIRTUAL TABLE IF NOT EXISTS "MediaSearch" USING fts5(
            "mediaId" UNINDEXED,
            "filename",
            "title",
            "performers",
            "tags",
            "attributes",
            "notes",
            "ocr",
            content = 'MediaSearchDoc',
            content_rowid = 'rowid',
            tokenize = 'porter unicode61 remove_diacritics 2',
            prefix = '2 3'
        );

        CREATE TRIGGER IF NOT EXISTS "MediaSearchDoc_ai"
        AFTER INSERT ON "MediaSearchDoc" BEGIN
            INSERT INTO "MediaSearch" (
                "rowid", "mediaId", "filename", "title", "performers",
                "tags", "attributes", "notes", "ocr"
            ) VALUES (
                new."rowid", new."mediaId", new."filename", new."title", new."performers",
                new."tags", new."attributes", new."notes",
                new."ocr"
            );
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaSearchDoc_ad"
        AFTER DELETE ON "MediaSearchDoc" BEGIN
            INSERT INTO "MediaSearch" (
                "MediaSearch", "rowid", "mediaId", "filename", "title", "performers",
                "tags", "attributes", "notes", "ocr"
            ) VALUES (
                'delete', old."rowid", old."mediaId", old."filename", old."title",
                old."performers", old."tags",
                old."attributes", old."notes", old."ocr"
            );
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaSearchDoc_au"
        AFTER UPDATE ON "MediaSearchDoc" BEGIN
            INSERT INTO "MediaSearch" (
                "MediaSearch", "rowid", "mediaId", "filename", "title", "performers",
                "tags", "attributes", "notes", "ocr"
            ) VALUES (
                'delete', old."rowid", old."mediaId", old."filename", old."title",
                old."performers", old."tags",
                old."attributes", old."notes", old."ocr"
            );
            INSERT INTO "MediaSearch" (
                "rowid", "mediaId", "filename", "title", "performers",
                "tags", "attributes", "notes", "ocr"
            ) VALUES (
                new."rowid", new."mediaId", new."filename", new."title", new."performers",
                new."tags", new."attributes", new."notes",
                new."ocr"
            );
        END;
`;

/**
 * Whether the document already has the column.
 *
 * A database built from a current `init.ts` and stamped only with the baseline replays every
 * migration on boot (`docker/smoke.sh` builds exactly that), and an unguarded ADD COLUMN would
 * kill the boot on "duplicate column". Present means the schema is already this one.
 */
const hasVariants = (db: Database): boolean =>
    db
        .prepare(`SELECT 1 FROM pragma_table_info('MediaSearchDoc') WHERE "name" = 'variants'`)
        .get() !== undefined;

export function up(db: Database): void {
    if (hasVariants(db)) {
        return;
    }

    db.exec(`ALTER TABLE "MediaSearchDoc" ADD COLUMN "variants" TEXT NOT NULL DEFAULT '';`);
    db.exec(DROP_INDEX);
    db.exec(WITH_VARIANTS);
    db.exec(REBUILD);
}

export function down(db: Database): void {
    if (!hasVariants(db)) {
        return;
    }

    db.exec(DROP_INDEX);
    db.exec(`ALTER TABLE "MediaSearchDoc" DROP COLUMN "variants";`);
    db.exec(WITHOUT_VARIANTS);
    db.exec(REBUILD);
}
