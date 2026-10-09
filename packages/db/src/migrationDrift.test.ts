import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { generateBaseline } from "./baseline.js";
import { BASELINE_MIGRATION } from "./migrate.js";
import { initializeDatabase } from "./init.js";
import { HAS_RELEASED } from "./released.js";

/**
 * Proves the two definitions of the schema agree.
 *
 * A fresh install runs `initializeDatabase()` and never replays migrations, while an
 * existing install only ever sees the migrations. Nothing but discipline keeps the two in
 * step, and it is easy to change one and forget the other.
 *
 * So: build one database from `init.ts`, build another by replaying every migration onto an
 * empty database, and require the resulting schemas to be identical.
 *
 * **What this catches depends on `HAS_RELEASED`** (see `released.ts`):
 *
 * - Pre-release, the baseline is generated from `init.ts`, so the two agreeing proves
 *   little on its own. The failure that actually happens is a *stale* baseline — someone
 *   edited `init.ts` and did not run `pnpm db:baseline` — so that is what is asserted, plus
 *   the chain still being a single file.
 * - Post-release, the baseline is frozen and migrations accumulate, so the replay is a real
 *   independent check and the stale-baseline test no longer applies.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, "migrations");

interface SchemaObject {
    type: string;
    name: string;
    sql: string | null;
}

/**
 * Split a `CREATE TABLE` body on its top-level commas, ignoring those nested inside
 * `CHECK(...)` or `FOREIGN KEY (...)`.
 */
const splitDefinitions = (body: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let current = "";

    for (const char of body) {
        if (char === "(") depth++;
        if (char === ")") depth--;
        if (char === "," && depth === 0) {
            parts.push(current.trim());
            current = "";
            continue;
        }
        current += char;
    }
    if (current.trim()) parts.push(current.trim());

    return parts;
};

/**
 * A comparable form of one schema object.
 *
 * Column *order* is deliberately normalised away by sorting the definitions inside a
 * `CREATE TABLE`. A migrated database gets newer columns appended by `ALTER TABLE ADD
 * COLUMN` while `init.ts` declares them wherever they read best, so the two can never agree
 * on order and that difference carries no meaning. Everything that does — the column set,
 * types, defaults, CHECK constraints, foreign keys, uniqueness — survives the sort and is
 * compared verbatim.
 */
const normalize = (object: SchemaObject): string => {
    const sql = (object.sql ?? "").replace(/\s+/g, " ").trim();
    const match = /^CREATE TABLE\s+"?\w+"?\s*\((.*)\)$/i.exec(sql);
    if (!match) {
        return `${object.type} ${object.name}\n${sql}`;
    }

    return `${object.type} ${object.name}\n${splitDefinitions(match[1]).sort().join(",\n  ")}`;
};

/**
 * The schema as a comparable, column-order-insensitive list.
 *
 * FTS5 shadow tables are excluded: an `fts5` virtual table creates `<name>_data`,
 * `<name>_idx` and friends whose definitions are engine-internal. The filter is here ahead
 * of the search index arriving in phase 4 so that adding it does not look like drift.
 */
const describeSchema = (database: Database.Database): string[] =>
    (
        database
            .prepare(
                `SELECT type, name, sql FROM sqlite_master
                 WHERE name NOT LIKE 'sqlite_%'
                   AND name != '_migrations'
                   AND name NOT LIKE '%\\_data' ESCAPE '\\'
                   AND name NOT LIKE '%\\_idx' ESCAPE '\\'
                   AND name NOT LIKE '%\\_content' ESCAPE '\\'
                   AND name NOT LIKE '%\\_docsize' ESCAPE '\\'
                   AND name NOT LIKE '%\\_config' ESCAPE '\\'
                 ORDER BY type, name`
            )
            .all() as SchemaObject[]
    ).map(normalize);

/** Replay every migration, in filename order, onto an empty database. */
const buildFromMigrations = async (): Promise<Database.Database> => {
    const replayed = new Database(":memory:");
    // Migrations recreate tables to change constraints, which trips foreign keys mid-flight.
    // The real runner does the same.
    replayed.pragma("foreign_keys = OFF");

    const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((file) => file.endsWith(".ts"))
        .sort();

    for (const file of files) {
        const migration = (await import(pathToFileURL(path.join(MIGRATIONS_DIR, file)).href)) as {
            up: (db: Database.Database) => void;
        };

        try {
            migration.up(replayed);
        } catch (error) {
            throw new Error(
                `Migration ${file} failed while replaying onto an empty database: ${
                    (error as Error).message
                }`
            );
        }
    }

    return replayed;
};

const buildFromInit = (): Database.Database => {
    const fresh = new Database(":memory:");
    fresh.pragma("foreign_keys = OFF");
    initializeDatabase(fresh);

    return fresh;
};

let fromMigrations: Database.Database;
let fromInit: Database.Database;

beforeAll(async () => {
    fromMigrations = await buildFromMigrations();
    fromInit = buildFromInit();
});

describe("init.ts vs the migration history", () => {
    it("replays every migration onto an empty database", () => {
        // If the chain ever loses its anchor, this is the assertion that says so.
        const tables = fromMigrations
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
            .all() as { name: string }[];

        expect(tables.length).toBeGreaterThan(5);
    });

    it("produces exactly the same schema as a fresh install", () => {
        const fresh = describeSchema(fromInit);
        const replayed = describeSchema(fromMigrations);

        const freshSet = new Set(fresh);
        const replayedSet = new Set(replayed);

        // Reported as two lists rather than one diff so the failure says which side is
        // behind: something only in `init.ts` means a migration was never written;
        // something only in the replay means `init.ts` was never updated.
        expect({
            missingFromMigrations: fresh.filter((o) => !replayedSet.has(o)),
            missingFromInit: replayed.filter((o) => !freshSet.has(o)),
        }).toEqual({ missingFromMigrations: [], missingFromInit: [] });
    });

    it.runIf(!HAS_RELEASED)("has a baseline regenerated from the current init.ts", () => {
        // The pre-release failure mode: init.ts was edited and `pnpm db:baseline` was
        // not run, leaving a baseline that cannot rebuild the current schema. The
        // comparison ignores formatting, since Prettier rewrites the generated file.
        const committed = fs.readFileSync(path.join(MIGRATIONS_DIR, BASELINE_MIGRATION), "utf8");
        const expected = generateBaseline();

        const comparable = (source: string) => source.replace(/\s+/g, " ").trim();

        expect(
            comparable(committed) === comparable(expected)
                ? "baseline is current"
                : "baseline is stale — run `pnpm db:baseline`"
        ).toBe("baseline is current");
    });

    it.runIf(!HAS_RELEASED)("keeps the chain to a single baseline before release", () => {
        // Adding a migration pre-release is either a mistake or a sign the release switch
        // should be flipped first. Either way it deserves to fail loudly.
        const files = fs
            .readdirSync(MIGRATIONS_DIR)
            .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));

        expect(files).toEqual([BASELINE_MIGRATION]);
    });

    it("agrees on the set of tables", () => {
        const names = (database: Database.Database) =>
            (
                database
                    .prepare(
                        `SELECT name FROM sqlite_master
                         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                           AND name != '_migrations'
                         ORDER BY name`
                    )
                    .all() as { name: string }[]
            ).map((r) => r.name);

        expect(names(fromMigrations)).toEqual(names(fromInit));
    });
});
