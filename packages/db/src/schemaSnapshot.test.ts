import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { initializeDatabase } from "./init.js";

/**
 * Renders the schema as readable SQL and snapshots it.
 *
 * The drift test proves `init.ts` and the migrations agree; this one makes any change to
 * either *visible* in review as a diff rather than buried in a schema dump. Accept an
 * intentional change with `pnpm test -u`.
 */

interface SchemaObject {
    type: string;
    name: string;
    sql: string | null;
}

const renderSchema = (database: Database.Database): string => {
    const objects = database
        .prepare(
            `SELECT type, name, sql FROM sqlite_master
             WHERE name NOT LIKE 'sqlite_%' AND name != '_migrations' AND sql IS NOT NULL
             ORDER BY
                 CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,
                 name`
        )
        .all() as SchemaObject[];

    return objects.map((object) => `${(object.sql ?? "").trim()};`).join("\n\n") + "\n";
};

describe("schema snapshot", () => {
    it("matches the committed schema", async () => {
        const database = new Database(":memory:");
        database.pragma("foreign_keys = OFF");
        initializeDatabase(database);

        await expect(renderSchema(database)).toMatchFileSnapshot("./__snapshots__/schema.sql");
    });
});
