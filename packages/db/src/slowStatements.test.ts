import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type Db } from "./db.js";

/**
 * The slow-statement log (§20).
 *
 * It works by proxying every prepared statement, which is the part worth testing: `Statement`
 * carries `pluck`, `raw`, `expand`, `bind`, `columns`, `iterate` and a `reader` getter, several of
 * which return the statement itself for chaining. A proxy that forwarded them wrongly would break
 * every query in the app — and only when someone set an environment variable, which is the worst
 * possible time to find out.
 *
 * So the assertions are mostly "everything still behaves", and one that it actually logs.
 */

const seed = (database: Db): void => {
    database.exec(`CREATE TABLE "T" ("id" INTEGER PRIMARY KEY, "name" TEXT)`);
    database
        .prepare(`INSERT INTO "T" ("id", "name") VALUES (1, 'one'), (2, 'two'), (3, 'three')`)
        .run();
};

/** Everything below the threshold, so the log fires for each statement. */
const withLogging = (): Db => {
    process.env.PRIVATE_STOCK_SQL_SLOW_MS = "0.0000001";

    return openDatabase({ path: ":memory:" });
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
    warn.mockRestore();
    delete process.env.PRIVATE_STOCK_SQL_SLOW_MS;
});

const sqlLines = (): string[] =>
    warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("[sql]"));

describe("statement timing", () => {
    it("is not installed at all without the variable", () => {
        const database = openDatabase({ path: ":memory:" });

        seed(database);
        expect(database.prepare(`SELECT count(*) AS n FROM "T"`).get()).toEqual({ n: 3 });
        expect(sqlLines()).toHaveLength(0);

        database.close();
    });

    it("logs the statement, the method and the row count", () => {
        const database = withLogging();

        seed(database);
        database.prepare(`SELECT * FROM "T"`).all();

        const line = sqlLines().find((entry) => entry.includes("SELECT * FROM"));

        expect(line).toBeDefined();
        expect(line).toContain("all");
        expect(line).toContain("rows=3");

        database.close();
    });

    it("leaves what each method returns exactly as it was", () => {
        const database = withLogging();

        seed(database);

        expect(database.prepare(`SELECT "name" FROM "T" WHERE "id" = ?`).get(2)).toEqual({
            name: "two",
        });
        expect(database.prepare(`SELECT "id" FROM "T" ORDER BY "id"`).all()).toEqual([
            { id: 1 },
            { id: 2 },
            { id: 3 },
        ]);

        const result = database.prepare(`DELETE FROM "T" WHERE "id" = ?`).run(3);

        expect(result.changes).toBe(1);

        database.close();
    });

    /** The chaining methods, which return the statement and would be lost by a naive proxy. */
    it("keeps pluck, raw and expand chainable", () => {
        const database = withLogging();

        seed(database);

        expect(database.prepare(`SELECT "name" FROM "T" ORDER BY "id"`).pluck().all()).toEqual([
            "one",
            "two",
            "three",
        ]);
        expect(database.prepare(`SELECT "id", "name" FROM "T" WHERE "id" = 1`).raw().get()).toEqual(
            [1, "one"]
        );

        database.close();
    });

    it("still reports a statement's columns and whether it reads", () => {
        const database = withLogging();

        seed(database);

        const statement = database.prepare(`SELECT "id", "name" FROM "T"`);

        expect(statement.reader).toBe(true);
        expect(statement.columns().map((column) => column.name)).toEqual(["id", "name"]);

        database.close();
    });

    /** Deliberately untimed: its cost belongs to the consumer's loop, not to the call. */
    it("iterates without logging", () => {
        const database = withLogging();

        seed(database);
        warn.mockClear();

        expect([...database.prepare(`SELECT "id" FROM "T"`).iterate()]).toHaveLength(3);
        expect(sqlLines()).toHaveLength(0);

        database.close();
    });

    it("works inside a transaction, which prepares and runs through the same proxy", () => {
        const database = withLogging();

        seed(database);

        const insert = database.prepare(`INSERT INTO "T" ("id", "name") VALUES (?, ?)`);
        const many = database.transaction((rows: [number, string][]) => {
            for (const [id, name] of rows) insert.run(id, name);
        });

        many([
            [4, "four"],
            [5, "five"],
        ]);

        expect(database.prepare(`SELECT count(*) AS n FROM "T"`).pluck().get()).toBe(5);

        database.close();
    });
});
