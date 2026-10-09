import type { Database } from "better-sqlite3";

/**
 * Face decisions that stick, and say how they were made (§5f "Corrections stick").
 *
 * - **A confirmation follows the item's tag.** Undoing a review's batch, withdrawing an OCR rule,
 *   untagging by hand: each takes a library performer off an item, and each used to leave the
 *   item's faces confirmed as them — so the group stayed theirs and the item came straight back.
 *   Every path that removes the assignment deletes the row, so the rule lives on the row: a
 *   trigger, rather than a call each of them must remember. Only the confirmation goes; whether a
 *   removal also means "not them" is the caller's to say.
 * - **How a decision was made**, on the face and on each refusal: `shown` — the face was on
 *   screen when it was decided; `item` — said of the whole item, as an untag is; `inferred` —
 *   carried to a face nobody saw, the same item's other faces in the group. What is measured
 *   (`FACE_DOUBT`, the thresholds that will tag by themselves) is measured on the first two.
 *   Null for what was decided before this was kept.
 *
 * Idempotent; the definitions are written out as `init.ts` writes them.
 */
const hasColumn = (db: Database, table: string, column: string): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE "name" = ?`).get(table, column) !==
    undefined;

export function up(db: Database): void {
    if (!hasColumn(db, "Face", "decidedHow")) {
        db.exec(
            `ALTER TABLE "Face" ADD COLUMN "decidedHow" TEXT
                 CHECK("decidedHow" IN ('shown', 'item', 'inferred'));`
        );
    }

    if (!hasColumn(db, "FaceRefusal", "how")) {
        db.exec(
            `ALTER TABLE "FaceRefusal" ADD COLUMN "how" TEXT CHECK("how" IN ('shown', 'item', 'inferred'));`
        );
    }

    db.exec(
        `CREATE TRIGGER IF NOT EXISTS "MediaTag_face_ad"
            AFTER DELETE ON "MediaTag" WHEN OLD."userId" IS NULL
        BEGIN
            UPDATE "Face"
               SET "tagId" = NULL, "decidedByUserId" = NULL, "decidedAt" = NULL,
                   "decidedHow" = NULL
             WHERE "mediaId" = OLD."mediaId" AND "tagId" = OLD."tagId";
        END;`
    );
}

export function down(db: Database): void {
    db.exec(`DROP TRIGGER IF EXISTS "MediaTag_face_ad";`);

    if (hasColumn(db, "FaceRefusal", "how")) {
        db.exec(`ALTER TABLE "FaceRefusal" DROP COLUMN "how";`);
    }

    if (hasColumn(db, "Face", "decidedHow")) {
        db.exec(`ALTER TABLE "Face" DROP COLUMN "decidedHow";`);
    }
}
