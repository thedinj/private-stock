import type { Database } from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The migration runner, ported from basket-bot.
 *
 * One deviation: every function takes a `Database` rather than closing over a module-level
 * singleton, because two processes and the drift test all need to run migrations against
 * different databases.
 */

export interface Migration {
    filename: string;
    up: (db: Database) => void;
    down: (db: Database) => void;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(here, "migrations");

/**
 * The one migration that reconstructs the original schema rather than changing it. It is
 * only meaningful against an empty database; see `applicationTablesExist`.
 */
export const BASELINE_MIGRATION = "00000000_000000_baseline.ts";

/** True when the database already holds application tables rather than being empty. */
function applicationTablesExist(db: Database): boolean {
    const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'User'`)
        .get();

    return !!row;
}

function getMigrationFiles(): string[] {
    if (!fs.existsSync(MIGRATIONS_DIR)) {
        return [];
    }

    return fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((file) => file.endsWith(".ts") || file.endsWith(".js"))
        .filter((file) => !file.endsWith(".d.ts"))
        .sort(); // Timestamp prefix ensures correct ordering
}

function initMigrationsTable(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS "_migrations" (
            "id" INTEGER PRIMARY KEY AUTOINCREMENT,
            "filename" TEXT NOT NULL UNIQUE,
            "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

/**
 * A migration's identity, independent of what ran it.
 *
 * The same migration is `...baseline.ts` under tsx and `...baseline.js` in the container,
 * because one reads `src/migrations` and the other reads `dist/migrations`. Recording the
 * filename as-is therefore gave one migration two identities: a database stamped by
 * `pnpm db:init` on a dev box arrived in the container as one unapplied migration, which the
 * runner dutifully replayed onto a schema that already had every table -- and the container
 * exited on `table "Artifact" already exists` before it ever served a page.
 *
 * A fresh volume never sees it, since nothing is recorded and the container's own `.js` names
 * match on every later boot. Copying a catalogued library up to the NAS is what breaks, which
 * is a thing somebody would obviously want to do and the worst moment to discover this.
 *
 * Rows already written with an extension still match, because the comparison is on the stem
 * either way. Nothing has to be rewritten.
 */
const migrationKey = (filename: string): string => filename.replace(/\.(ts|js)$/, "");

function getAppliedMigrations(db: Database): string[] {
    const rows = db.prepare(`SELECT filename FROM "_migrations" ORDER BY id ASC`).all() as {
        filename: string;
    }[];

    return rows.map((row) => migrationKey(row.filename));
}

function recordMigration(db: Database, filename: string): void {
    db.prepare(`INSERT INTO "_migrations" (filename) VALUES (?)`).run(migrationKey(filename));
}

function unrecordMigration(db: Database, filename: string): void {
    // Both spellings, so a rollback works against a database stamped before this change.
    const key = migrationKey(filename);

    db.prepare(`DELETE FROM "_migrations" WHERE filename IN (?, ?, ?)`).run(
        key,
        `${key}.ts`,
        `${key}.js`
    );
}

/**
 * Record every known migration as applied without running any of them.
 *
 * `initializeDatabase()` builds the *current* schema directly, so a freshly initialised
 * database already reflects every migration ever written. Stamping them here is what stops
 * a subsequent `db:migrate` from trying to re-apply them.
 */
export function markAllMigrationsApplied(db: Database): void {
    initMigrationsTable(db);

    const applied = new Set(getAppliedMigrations(db));
    const pending = getMigrationFiles().filter((file) => !applied.has(migrationKey(file)));

    if (pending.length === 0) {
        return;
    }

    db.transaction(() => {
        for (const filename of pending) {
            recordMigration(db, filename);
        }
    })();

    console.log(`Marked ${pending.length} migration(s) as applied for the new schema`);
}

export async function loadMigration(filename: string): Promise<Migration> {
    const migrationPath = path.join(MIGRATIONS_DIR, filename);

    return (await import(pathToFileURL(migrationPath).href)) as Migration;
}

/** Apply every pending migration, each in its own transaction. */
export async function runMigrations(db: Database): Promise<void> {
    console.log("Running database migrations...");

    initMigrationsTable(db);

    const allMigrations = getMigrationFiles();
    const appliedMigrations = getAppliedMigrations(db);
    const pendingMigrations = allMigrations.filter(
        (file) => !appliedMigrations.includes(migrationKey(file))
    );

    if (pendingMigrations.length === 0) {
        console.log("✓ No pending migrations");
        return;
    }

    console.log(`Found ${pendingMigrations.length} pending migration(s)`);

    for (const filename of pendingMigrations) {
        // The baseline reconstructs the original schema, so running it against a database
        // that already has tables would be wrong — `CREATE TABLE IF NOT EXISTS` would
        // silently resurrect anything a later migration drops on purpose. Record and move on.
        //
        // Compared on the *key*, not the filename. `BASELINE_MIGRATION` is spelled `.ts`,
        // and the container reads `dist/migrations`, so the raw comparison was false on
        // every boot there and this guard existed only on the dev box. Reproduced in a
        // built image: a database holding tables but no stamp exits the container on
        // `table "Artifact" already exists` — the same symptom `migrationKey` was written
        // to cure, arriving through the one comparison that had not been converted.
        if (
            migrationKey(filename) === migrationKey(BASELINE_MIGRATION) &&
            applicationTablesExist(db)
        ) {
            recordMigration(db, filename);
            console.log(`  - Skipped (database already exists): ${filename}`);
            continue;
        }

        console.log(`  Applying: ${filename}...`);

        const migration = await loadMigration(filename);

        if (!migration.up) {
            throw new Error(`Migration ${filename} does not export an 'up' function`);
        }

        try {
            // Migrations that recreate tables to change constraints trip foreign keys
            // mid-flight. Safe because the transaction rolls back on any error.
            db.pragma("foreign_keys = OFF");

            db.transaction(() => {
                migration.up(db);
                recordMigration(db, filename);
            })();

            db.pragma("foreign_keys = ON");

            console.log(`  ✓ Applied: ${filename}`);
        } catch (error) {
            db.pragma("foreign_keys = ON");
            console.error(`  ✗ Failed to apply migration ${filename}:`, error);
            throw error;
        }
    }

    console.log("✓ All migrations completed successfully");
}

/** Roll back the most recently applied migration. Development only. */
export async function rollbackLastMigration(db: Database): Promise<void> {
    console.log("Rolling back last migration...");

    initMigrationsTable(db);

    const appliedMigrations = getAppliedMigrations(db);

    if (appliedMigrations.length === 0) {
        console.log("No migrations to rollback");
        return;
    }

    // The applied list holds extension-free keys, so the file it names has to be found on
    // disk -- it is `.ts` here and `.js` in the container, and only one of them exists.
    const lastMigration = appliedMigrations[appliedMigrations.length - 1];
    const migrationFile = getMigrationFiles().find((file) => migrationKey(file) === lastMigration);

    if (!migrationFile) {
        throw new Error(
            `Migration ${lastMigration} is recorded as applied but no file for it exists in ${MIGRATIONS_DIR}`
        );
    }

    console.log(`  Rolling back: ${lastMigration}...`);

    const migration = await loadMigration(migrationFile);

    if (!migration.down) {
        throw new Error(`Migration ${lastMigration} does not export a 'down' function`);
    }

    try {
        db.pragma("foreign_keys = OFF");

        db.transaction(() => {
            migration.down(db);
            unrecordMigration(db, lastMigration);
        })();

        db.pragma("foreign_keys = ON");

        console.log(`  ✓ Rolled back: ${lastMigration}`);
    } catch (error) {
        db.pragma("foreign_keys = ON");
        console.error(`  ✗ Failed to rollback migration ${lastMigration}:`, error);
        throw error;
    }
}

export { getMigrationFiles };
