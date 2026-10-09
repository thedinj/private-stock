import Database from "better-sqlite3";

import { initializeDatabase } from "./init.js";

/**
 * Renders the baseline migration from `init.ts`.
 *
 * Pre-release this is how the migration chain is maintained: one file, rewritten
 * whenever the schema changes. The generation is pure — build the schema in an
 * in-memory database, read it back out of `sqlite_master`, and format it — so the
 * test can call it to check the committed file is current without touching disk.
 */

export const BASELINE_PATH = "src/migrations/00000000_000000_baseline.ts";

interface SchemaObject {
    type: string;
    name: string;
    sql: string | null;
}

/**
 * Names of the shadow tables a virtual table keeps for itself.
 *
 * FTS5 backs each virtual table with several real ones -- `MediaSearch_data`,
 * `_idx`, `_content`, `_docsize`, `_config` -- and they appear in `sqlite_master`
 * like any other table. They must never be emitted: `CREATE VIRTUAL TABLE` builds
 * them, and replaying a literal `CREATE TABLE "MediaSearch_config"` fails outright
 * with "object name reserved for internal use".
 *
 * Derived from the virtual tables actually present rather than from a hardcoded
 * suffix list, so a future virtual table with a different shadow layout is covered
 * without anyone remembering to update this.
 */
const shadowTablePrefixes = (db: Database.Database): string[] =>
    (
        db
            .prepare(
                `SELECT name FROM sqlite_master
                  WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'`
            )
            .all() as { name: string }[]
    ).map((row) => `${row.name}_`);

const schemaObjects = (db: Database.Database): SchemaObject[] => {
    const prefixes = shadowTablePrefixes(db);

    const objects = db
        .prepare(
            `SELECT type, name, sql FROM sqlite_master
             WHERE name NOT LIKE 'sqlite_%' AND name != '_migrations' AND sql IS NOT NULL
             ORDER BY
                 CASE type
                     WHEN 'table' THEN 0
                     WHEN 'index' THEN 1
                     WHEN 'trigger' THEN 2
                     ELSE 3
                 END,
                 name`
        )
        .all() as SchemaObject[];

    return objects.filter((object) => !prefixes.some((prefix) => object.name.startsWith(prefix)));
};

/** The schema as executable SQL, tables first so index creation always resolves. */
export const renderSchemaSql = (db: Database.Database): string =>
    schemaObjects(db)
        .map((object) => `${(object.sql ?? "").trim()};`)
        .join("\n\n");

export const generateBaseline = (): string => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = OFF");
    initializeDatabase(db);

    const objects = schemaObjects(db);
    const sql = renderSchemaSql(db);
    const tables = objects
        .filter((object) => object.type === "table")
        .map((object) => object.name)
        .reverse();

    db.close();

    const indented = sql
        .split("\n")
        .map((line) => (line.length ? `        ${line}` : ""))
        .join("\n");

    return `import type { Database } from "better-sqlite3";

/**
 * The anchor of the migration chain.
 *
 * ── GENERATED FILE — do not edit by hand. Run \`pnpm db:baseline\`. ──
 *
 * While \`HAS_RELEASED\` is false (see \`released.ts\`) this file is regenerated from
 * \`init.ts\` on every schema change, and \`migrationDrift.test.ts\` fails if it is
 * stale. Once the switch is flipped it becomes frozen history: the generator
 * refuses to run, and schema changes become new timestamped migrations instead.
 *
 * The SQL is inlined rather than calling \`initializeDatabase()\`. That matters
 * after release: if it delegated, \`init.ts\` and the migration chain would always
 * move together and the drift test could never fail — the protection it exists to
 * provide would be silently inert.
 */
export function up(db: Database): void {
    db.exec(\`
${indented}
    \`);
}

export function down(db: Database): void {
    // Foreign keys are disabled during migrations, but listed child-first anyway so
    // this still reads correctly if that ever changes.
    const tables = [
${tables.map((table) => `        "${table}",`).join("\n")}
    ];

    for (const table of tables) {
        db.exec(\`DROP TABLE IF EXISTS "\${table}"\`);
    }
}
`;
};
