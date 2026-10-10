import type { Database } from "better-sqlite3";

/**
 * Unticked faces asked about again (§5f "Unsure, face by face").
 *
 * Before "unsure" existed, a face left unticked in a row that was otherwise taken was refused —
 * the only way to leave it out — and some of those were a "maybe", not a "not them". They cannot
 * be told apart, so every such refusal goes: the faces refused on screen, and the faces nobody
 * saw refused with them, where the same group had faces confirmed for the same performer in the
 * same few seconds. A whole group refused ("Not them"), and anything said from an item's page,
 * stays. The groups then ask about them again.
 *
 * Bounded below by the day refusals began recording how they were made; no newer decision can
 * match, since an unsure face is no longer refused. Nothing to undo: `down` cannot tell which
 * refusals there were.
 */
export function up(db: Database): void {
    // A database built after face groups went has no groups, and nothing of this to restore.
    if (
        db.prepare(`SELECT 1 FROM pragma_table_info('Face') WHERE "name" = 'groupId'`).get() ===
        undefined
    ) {
        return;
    }

    db.exec(
        `DELETE FROM "FaceRefusal"
          WHERE "how" IN ('shown', 'inferred') AND "decidedAt" >= '2026-10-09'
            AND EXISTS (
                SELECT 1 FROM "Face" f JOIN "Face" c ON c."groupId" = f."groupId"
                 WHERE f."id" = "FaceRefusal"."faceId"
                   AND c."tagId" = "FaceRefusal"."tagId" AND c."decidedAt" IS NOT NULL
                   AND abs(julianday(c."decidedAt") - julianday("FaceRefusal"."decidedAt")) * 86400 <= 5
            );`
    );
}

export function down(): void {
    // The refusals are gone; there is nothing to put back.
}
