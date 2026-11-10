import type { Database } from "better-sqlite3";

/**
 * Which room a tag batch was applied in (§21 "Tag batches belong to a room").
 *
 * The undo list read every batch its owner made, so the Parlour offered "Tagged 40 items
 * performer: …" for something done in the Cellar, and could withdraw it. A batch writes one
 * room's tags, so its room is theirs: set from the first tag when it is written, and filled in
 * here from the rows each batch still has. A batch with none left -- withdrawn, or one that
 * wrote nothing -- has nothing to say which room it was and stays null, which no room lists.
 *
 * Nullable, unchecked beyond its length like `MediaRoot.domain`, and never updated.
 */
const hasColumn = (db: Database): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('TagBatch') WHERE "name" = 'domain'`).get() !==
    undefined;

export function up(db: Database): void {
    if (!hasColumn(db)) {
        db.exec(
            `ALTER TABLE "TagBatch" ADD COLUMN "domain" TEXT CHECK("domain" IS NULL OR length("domain") BETWEEN 1 AND 32);`
        );
    }

    db.exec(`
        UPDATE "TagBatch" SET "domain" = coalesce(
            (SELECT t."domain" FROM "MediaTag" mt JOIN "Tag" t ON t."id" = mt."tagId"
              WHERE mt."batchId" = "TagBatch"."id" LIMIT 1),
            (SELECT t."domain" FROM "ClipTag" ct JOIN "Tag" t ON t."id" = ct."tagId"
              WHERE ct."batchId" = "TagBatch"."id" LIMIT 1))
         WHERE "domain" IS NULL;
    `);
}

export function down(db: Database): void {
    if (hasColumn(db)) {
        db.exec(`ALTER TABLE "TagBatch" DROP COLUMN "domain";`);
    }
}
