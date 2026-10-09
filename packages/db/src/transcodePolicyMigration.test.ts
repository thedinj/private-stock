import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { initializeDatabase } from "./init.js";
import { down, up } from "./migrations/20261002_150000_transcode_in_stage_policy.js";

/**
 * Transcoding's switch moving from the transcode setting into the stage policy (§7b, §8).
 *
 * The data is the whole migration, so it runs against a real database: what matters is that an
 * enabled library stays enabled, a library that never touched it gains nothing, and the
 * encoder settings beside the flag survive the move both ways.
 */

let db: Database.Database;

const get = (key: string): unknown => {
    const row = db.prepare(`SELECT "value" FROM "Setting" WHERE "key" = ?`).get(key) as
        { value: string } | undefined;

    return row ? JSON.parse(row.value) : undefined;
};

const set = (key: string, value: unknown): void => {
    db.prepare(
        `INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES (?, ?, CURRENT_TIMESTAMP)`
    ).run(key, JSON.stringify(value));
};

beforeEach(() => {
    db = new Database(":memory:");
    initializeDatabase(db);
});

describe("transcode switch into the stage policy", () => {
    it("moves an enabled switch into the policy, keeping both records' other values", () => {
        set("transcode", { enabled: true, crf: 23 });
        set("stages.policy", { ocr: true });

        up(db);

        expect(get("transcode")).toEqual({ crf: 23 });
        expect(get("stages.policy")).toEqual({ ocr: true, transcode: true });
    });

    it("writes nothing to the policy for a switch that was off", () => {
        set("transcode", { enabled: false, crf: 23 });

        up(db);

        expect(get("transcode")).toEqual({ crf: 23 });
        expect(get("stages.policy")).toBeUndefined();
    });

    it("leaves a library that never saved transcode settings alone", () => {
        up(db);

        expect(get("transcode")).toBeUndefined();
        expect(get("stages.policy")).toBeUndefined();
    });

    it("puts the switch back on the way down", () => {
        set("transcode", { enabled: true, crf: 23 });
        set("stages.policy", { ocr: true });

        up(db);
        down(db);

        expect(get("transcode")).toEqual({ crf: 23, enabled: true });
        expect(get("stages.policy")).toEqual({ ocr: true });
    });
});
