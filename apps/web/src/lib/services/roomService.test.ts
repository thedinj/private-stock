import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthorizationError, SETTING_KEYS, ValidationError } from "@private-stock/core";

/**
 * Turning rooms off (§21 "Turning a room off"): what is stored, what is read back, and the one
 * state the household must never reach -- every room off.
 */

const store = new Map<string, unknown>();

vi.mock("@private-stock/db", () => ({
    settingRepo: {
        get: <T>(key: string, fallback: T): T =>
            store.has(key) ? (store.get(key) as T) : fallback,
        set: (key: string, value: unknown): void => {
            store.set(key, value);
        },
    },
}));

const { enabledRooms, switchRoom } = await import("./roomService");

const ADMIN = ["admin"];

beforeEach(() => {
    store.clear();
});

describe("reading", () => {
    it("has every room on when nothing was ever written", () => {
        expect(enabledRooms().enabled).toEqual(["family", "cellar", "games"]);
    });

    it("ignores rooms it does not know, and a value that is not a list", () => {
        store.set(SETTING_KEYS.roomsOff, ["arcade", "games"]);
        expect(enabledRooms().enabled).toEqual(["family", "cellar"]);

        store.set(SETTING_KEYS.roomsOff, "games");
        expect(enabledRooms().enabled).toEqual(["family", "cellar", "games"]);
    });

    it("reads a row naming every room as all of them on", () => {
        store.set(SETTING_KEYS.roomsOff, ["family", "cellar", "games"]);

        expect(enabledRooms().enabled).toEqual(["family", "cellar", "games"]);
    });
});

describe("switching", () => {
    it("turns a room off and on again, keeping the order", () => {
        expect(switchRoom({ room: "cellar", enabled: false }, ADMIN).enabled).toEqual([
            "family",
            "games",
        ]);
        // Stored as what is off, so a room added in code later arrives on.
        expect(store.get(SETTING_KEYS.roomsOff)).toEqual(["cellar"]);

        expect(switchRoom({ room: "cellar", enabled: true }, ADMIN).enabled).toEqual([
            "family",
            "cellar",
            "games",
        ]);
        expect(store.get(SETTING_KEYS.roomsOff)).toEqual([]);
    });

    it("turns the default room off like any other", () => {
        expect(switchRoom({ room: "family", enabled: false }, ADMIN).enabled).toEqual([
            "cellar",
            "games",
        ]);
    });

    it("refuses to turn off the last room that is on", () => {
        switchRoom({ room: "family", enabled: false }, ADMIN);
        switchRoom({ room: "games", enabled: false }, ADMIN);

        expect(() => switchRoom({ room: "cellar", enabled: false }, ADMIN)).toThrow(
            ValidationError
        );
        expect(enabledRooms().enabled).toEqual(["cellar"]);
    });

    it("treats turning on a room that is already on as nothing", () => {
        expect(switchRoom({ room: "games", enabled: true }, ADMIN).enabled).toEqual([
            "family",
            "cellar",
            "games",
        ]);
    });

    it("refuses anyone without the admin scope", () => {
        expect(() => switchRoom({ room: "games", enabled: false }, ["delete"])).toThrow(
            AuthorizationError
        );
        expect(store.size).toBe(0);
    });
});
