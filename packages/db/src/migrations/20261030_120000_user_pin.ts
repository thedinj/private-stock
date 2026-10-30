import type { Database } from "better-sqlite3";

/**
 * The screen lock's PIN (§12c "The screen lock"): one per account, hashed, NULL when none is
 * set. Whether a device actually locks is the device's own choice and is not stored here.
 */
const hasColumn = (db: Database): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('User') WHERE "name" = 'pinHash'`).get() !==
    undefined;

export function up(db: Database): void {
    if (!hasColumn(db)) {
        db.exec(
            `ALTER TABLE "User" ADD COLUMN "pinHash" TEXT CHECK("pinHash" IS NULL OR length("pinHash") <= 255);`
        );
    }
}

export function down(db: Database): void {
    if (hasColumn(db)) {
        db.exec(`ALTER TABLE "User" DROP COLUMN "pinHash";`);
    }
}
