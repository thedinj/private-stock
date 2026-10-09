import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Db } from "./db.js";

/**
 * Compiled statements are reused (`reuseStatements` in db.ts, §20).
 *
 * The point is memory -- a statement compiled per call is native memory that waits for V8 to
 * collect a small object -- but what has to be tested is that sharing one statement between
 * callers changes nothing any caller can see: a mode one caller set is not the next caller's
 * mode, a statement mid-`iterate` is not handed out again, and the cache does not grow for ever.
 */

let database: Db;

beforeEach(() => {
    database = openDatabase({ path: ":memory:" });
    database.exec(`CREATE TABLE "T" ("id" INTEGER PRIMARY KEY, "name" TEXT)`);
    database
        .prepare(`INSERT INTO "T" ("id", "name") VALUES (1, 'one'), (2, 'two'), (3, 'three')`)
        .run();
});

afterEach(() => {
    database.close();
});

/**
 * Whether two handles share one compiled statement. Each `prepare` returns its own handle (so a
 * mode set on one is not seen by the other), but `busy` is the compiled statement's own: start an
 * iteration through one and the other reports it.
 */
const sameCompiled = (
    a: ReturnType<Db["prepare"]>,
    b: ReturnType<Db["prepare"]>,
    ...params: unknown[]
): boolean => {
    const rows = a.iterate(...params);

    rows.next();

    const shared = b.busy;

    rows.return?.();

    return shared;
};

describe("statement reuse", () => {
    it("compiles a statement once and shares it between callers", () => {
        const sql = `SELECT "name" FROM "T" WHERE "id" = ?`;

        expect(sameCompiled(database.prepare(sql), database.prepare(sql), 2)).toBe(true);
        expect(database.prepare(sql).get(2)).toEqual({ name: "two" });
    });

    /**
     * The case a reset on hand-out cannot cover: a statement kept in a variable while another
     * caller plucks the same SQL. Each handle must keep the mode it asked for.
     */
    it("keeps a held statement's mode when another caller plucks the same SQL", () => {
        const sql = `SELECT "id", "name" FROM "T" ORDER BY "id"`;
        const held = database.prepare(sql);

        expect(database.prepare(sql).pluck().all()).toEqual([1, 2, 3]);
        expect(held.get()).toEqual({ id: 1, name: "one" });

        const plucked = database.prepare(sql).pluck();

        expect(database.prepare(sql).get()).toEqual({ id: 1, name: "one" });
        expect(plucked.all()).toEqual([1, 2, 3]);
    });

    it("does not pass one caller's pluck or raw on to the next", () => {
        const sql = `SELECT "id", "name" FROM "T" ORDER BY "id"`;

        expect(database.prepare(sql).pluck().all()).toEqual([1, 2, 3]);
        expect(database.prepare(sql).all()[0]).toEqual({ id: 1, name: "one" });
        expect(database.prepare(sql).raw().get()).toEqual([1, "one"]);
        expect(database.prepare(sql).get()).toEqual({ id: 1, name: "one" });
        expect(database.prepare(sql).expand().get()).toEqual({ T: { id: 1, name: "one" } });
        expect(database.prepare(sql).get()).toEqual({ id: 1, name: "one" });
    });

    it("leaves statements that return nothing alone", () => {
        const sql = `UPDATE "T" SET "name" = ? WHERE "id" = ?`;

        database.prepare(sql).run("uno", 1);
        database.prepare(sql).run("dos", 2);

        expect(database.prepare(`SELECT "name" FROM "T" ORDER BY "id"`).pluck().all()).toEqual([
            "uno",
            "dos",
            "three",
        ]);
    });

    it("gives a fresh statement while the cached one is iterating", () => {
        const sql = `SELECT "id" FROM "T" ORDER BY "id"`;
        const seen: number[] = [];

        for (const row of database.prepare(sql).iterate() as Iterable<{ id: number }>) {
            // The same SQL again, inside the loop: the cached statement is busy.
            seen.push(row.id, (database.prepare(sql).all() as { id: number }[]).length);
        }

        expect(seen).toEqual([1, 3, 2, 3, 3, 3]);
        // And once the loop is over, the cached one is usable again.
        expect(database.prepare(sql).all()).toHaveLength(3);
    });

    it("keeps a bounded number, dropping the least recently used", () => {
        const first = `SELECT 0 AS "n"`;
        const kept = database.prepare(first);

        for (let i = 1; i <= 2_000; i += 1) {
            database.prepare(`SELECT ${i} AS "n"`).get();
        }

        const again = database.prepare(first);

        expect(again).not.toBe(kept);
        expect(again.get()).toEqual({ n: 0 });
    });

    it("keeps one that is used, however many others pass through", () => {
        const hot = `SELECT count(*) AS "n" FROM "T"`;
        const kept = database.prepare(hot);

        for (let i = 1; i <= 2_000; i += 1) {
            database.prepare(`SELECT ${i} AS "n"`).get();
            database.prepare(hot).get();
        }

        expect(sameCompiled(database.prepare(hot), kept)).toBe(true);
    });
});
