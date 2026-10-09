import type { Database } from "better-sqlite3";

/**
 * "Not one person" (§5f "Grab bags"): faces turned away or obscured have vague fingerprints,
 * each weakly like the average of the rest, so they pile into one group of many people.
 *
 * - **`Face.scatteredAt`**: said of a group's undecided faces — they leave the group and are never
 *   grouped again, counted as evidence, or tagged by themselves.
 * - **`FaceGroupDissolved`**: the group itself, for the grouping job to drop from its sums on its
 *   next run; otherwise its averaged-out centre would go on drawing in the next obscured face.
 * - **`FaceGroupStat`**: each group's cohesion — how close its faces are to its centre on average
 *   — written by the grouping job, so a loose group can be marked and asked about last.
 *
 * Idempotent; the definitions are written out as `init.ts` writes them.
 */
const hasColumn = (db: Database, column: string): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('Face') WHERE "name" = ?`).get(column) !==
    undefined;

export function up(db: Database): void {
    if (!hasColumn(db, "scatteredAt")) {
        db.exec(`ALTER TABLE "Face" ADD COLUMN "scatteredAt" DATETIME;`);
    }

    if (!hasColumn(db, "scatteredByUserId")) {
        db.exec(
            `ALTER TABLE "Face" ADD COLUMN "scatteredByUserId" TEXT
                 REFERENCES "User" ("id") ON DELETE SET NULL;`
        );
    }

    db.exec(
        `CREATE TABLE IF NOT EXISTS "FaceGroupDissolved" (
            "groupId" TEXT NOT NULL PRIMARY KEY CHECK(length("groupId") <= 64),
            "dissolvedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) WITHOUT ROWID;

        CREATE TABLE IF NOT EXISTS "FaceGroupStat" (
            "groupId" TEXT NOT NULL PRIMARY KEY CHECK(length("groupId") <= 64),
            "cohesion" REAL NOT NULL
        ) WITHOUT ROWID;`
    );
}

export function down(db: Database): void {
    db.exec(`DROP TABLE IF EXISTS "FaceGroupStat"; DROP TABLE IF EXISTS "FaceGroupDissolved";`);

    if (hasColumn(db, "scatteredByUserId")) {
        db.exec(`ALTER TABLE "Face" DROP COLUMN "scatteredByUserId";`);
    }

    if (hasColumn(db, "scatteredAt")) {
        db.exec(`ALTER TABLE "Face" DROP COLUMN "scatteredAt";`);
    }
}
