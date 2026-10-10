import type { Database } from "better-sqlite3";

/**
 * New people (§5f "New people"): `FaceAppearance.newPersonId`, the gathering of people who match
 * nobody known that an appearance is part of, written with the appearances by each `faceAnchors`
 * run and null where it is part of none worth asking about. Like the appearances, made anew each
 * run; decisions land on faces.
 *
 * Idempotent; the definition is written out as `init.ts` writes it.
 */
const hasColumn = (db: Database): boolean =>
    db
        .prepare(`SELECT 1 FROM pragma_table_info('FaceAppearance') WHERE "name" = 'newPersonId'`)
        .get() !== undefined;

export function up(db: Database): void {
    if (!hasColumn(db)) {
        db.exec(
            `ALTER TABLE "FaceAppearance" ADD COLUMN "newPersonId" TEXT CHECK(length("newPersonId") <= 64);`
        );
    }

    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_FaceAppearance_newPerson"
            ON "FaceAppearance" ("newPersonId") WHERE "newPersonId" IS NOT NULL;`
    );
}

export function down(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS "idx_FaceAppearance_newPerson";`);

    if (hasColumn(db)) {
        db.exec(`ALTER TABLE "FaceAppearance" DROP COLUMN "newPersonId";`);
    }
}
