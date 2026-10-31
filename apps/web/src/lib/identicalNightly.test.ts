import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    AuthenticationError,
    type IdenticalNightlyRun,
    type IdenticalNightlySetting,
    type IdenticalTrashRequest,
} from "@private-stock/core";

/**
 * The nightly clear of identical copies (§10e "Every night").
 *
 * The rule it applies is the button's and is tested there; what is left is everything that
 * decides whether files are deleted at all with nobody watching: only while switched on, only
 * inside the night, once a night, as the person who switched it on, and not after they lose the
 * right to.
 */

let setting: IdenticalNightlySetting;
let recorded: IdenticalNightlyRun[] = [];
let batches: { request: IdenticalTrashRequest; userId: string }[] = [];
/** Cursors the batches hand back in turn; the last is null. */
let cursors: (string | null)[] = [];
let onBatch: () => void = () => {};
let accountGone = false;

vi.mock("./services/dupeService", () => ({
    loadIdenticalNightly: () => setting,
    nightlyWindow: () => ({ startHour: 2, endHour: 8, timeZone: "UTC" }),
    recordNightlyRun: (run: IdenticalNightlyRun) => {
        recorded.push(run);
        setting = { ...setting, lastRun: run };
    },
    trashIdentical: async (request: IdenticalTrashRequest, auth: { userId: string }) => {
        batches.push({ request, userId: auth.userId });
        onBatch();

        return { groups: 1, trashed: 2, failed: [], cursor: cursors.shift() ?? null, remaining: 0 };
    },
}));

vi.mock("./auth/withAuth", () => ({
    contextFor: (userId: string) => {
        if (accountGone) throw new AuthenticationError("Sign in to continue");

        return { userId, scopes: ["admin", "delete"] };
    },
}));

const { runIfDue } = await import("./identicalNightly");

const night = new Date("2026-10-31T03:00:00Z");
const afternoon = new Date("2026-10-31T15:00:00Z");

beforeEach(() => {
    setting = { enabled: true, byUserId: "admin1", since: "2026-10-01T00:00:00Z", lastRun: null };
    recorded = [];
    batches = [];
    cursors = [];
    onBatch = () => {};
    accountGone = false;
});

describe("the nightly clear of identical copies", () => {
    it("deletes nothing while switched off", async () => {
        setting = { ...setting, enabled: false };

        expect(await runIfDue(night)).toBe(false);
        expect(batches).toEqual([]);
    });

    it("deletes nothing outside the night", async () => {
        expect(await runIfDue(afternoon)).toBe(false);
        expect(batches).toEqual([]);
    });

    it("runs every batch to the end, as whoever switched it on, and records it", async () => {
        cursors = ["g1", "g2", null];

        expect(await runIfDue(night)).toBe(true);
        expect(batches.map((batch) => batch.request.after)).toEqual([null, "g1", "g2"]);
        expect(batches.every((batch) => batch.userId === "admin1")).toBe(true);
        expect(recorded).toEqual([{ at: night.toISOString(), deleted: 6, failed: 0, error: null }]);
    });

    it("runs once a night, not every time it looks at the clock", async () => {
        await runIfDue(night);

        expect(await runIfDue(new Date("2026-10-31T05:00:00Z"))).toBe(false);
        expect(await runIfDue(new Date("2026-11-01T02:10:00Z"))).toBe(true);
        expect(batches).toHaveLength(2);
    });

    it("stops between batches once switched off", async () => {
        cursors = ["g1", "g2", null];
        onBatch = () => {
            setting = { ...setting, enabled: false };
        };

        await runIfDue(night);

        expect(batches).toHaveLength(1);
    });

    it("deletes nothing once the account is gone, and says why", async () => {
        accountGone = true;

        await runIfDue(night);

        expect(batches).toEqual([]);
        expect(recorded[0]?.error).toBe("Sign in to continue");
    });
});
