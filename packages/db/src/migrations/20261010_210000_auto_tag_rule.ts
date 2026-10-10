import type { Database } from "better-sqlite3";

/**
 * Which rule proposed what faces would tag (§5f "Tagging by itself"): `FaceAutoTag.rule`, 1 for the
 * rule read from single faces, 2 for the one read from a person in an item (an appearance). A rule
 * tags by itself only once enough of its own proposals were checked right, so its tally has to be
 * told from the last one's. What the first rule proposed and nobody checked goes: the next run
 * proposes afresh.
 *
 * Idempotent; the definition is written out as `init.ts` writes it.
 */
const hasColumn = (db: Database): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('FaceAutoTag') WHERE "name" = 'rule'`).get() !==
    undefined;

export function up(db: Database): void {
    if (!hasColumn(db)) {
        db.exec(
            `ALTER TABLE "FaceAutoTag" ADD COLUMN "rule" INTEGER NOT NULL DEFAULT 1 CHECK("rule" IN (1, 2));`
        );
    }

    db.exec(`DELETE FROM "FaceAutoTag" WHERE "state" = 'proposed' AND "rule" = 1;`);
}

export function down(db: Database): void {
    if (hasColumn(db)) {
        db.exec(`ALTER TABLE "FaceAutoTag" DROP COLUMN "rule";`);
    }
}
