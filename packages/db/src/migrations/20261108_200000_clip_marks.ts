import type { Database } from "better-sqlite3";

/**
 * A clip's own rating and favourite (§14d "Clips in the library").
 *
 * On the row rather than in a per-user table like `UserMedia`: a clip has one owner and is
 * nobody else's to judge, so a second table keyed by (user, clip) could only ever hold the
 * owner's row. Booleans as 1 or NULL, never 0, as everywhere else in the schema.
 *
 * Idempotent: each column is added only while it is missing.
 */
const hasColumn = (db: Database, column: string): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('Clip') WHERE "name" = ?`).get(column) !==
    undefined;

export function up(db: Database): void {
    if (!hasColumn(db, "rating")) {
        db.exec(
            `ALTER TABLE "Clip" ADD COLUMN "rating" INTEGER CHECK("rating" IS NULL OR "rating" BETWEEN 1 AND 5);`
        );
    }

    if (!hasColumn(db, "favorite")) {
        db.exec(
            `ALTER TABLE "Clip" ADD COLUMN "favorite" INTEGER CHECK("favorite" IS NULL OR "favorite" = 1);`
        );
    }
}

export function down(db: Database): void {
    for (const column of ["favorite", "rating"]) {
        if (hasColumn(db, column)) {
            db.exec(`ALTER TABLE "Clip" DROP COLUMN "${column}";`);
        }
    }
}
