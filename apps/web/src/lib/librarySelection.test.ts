import { beforeEach, describe, expect, it } from "vitest";

import { readSelection, selectionOwner, writeSelection } from "./librarySelection";

/** The unit suite runs in Node, which has no `sessionStorage`. */
const storage = new Map<string, string>();

globalThis.sessionStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
} as Storage;

beforeEach(() => storage.clear());

describe("library selection", () => {
    const here = selectionOwner("u1", "kind=video&page=2");

    it("gives a selection back on the address it was made on", () => {
        writeSelection(here, ["a", "b"]);

        expect(readSelection(here)).toEqual(["a", "b"]);
    });

    it("gives nothing back on any other address", () => {
        writeSelection(here, ["a", "b"]);

        expect(readSelection(selectionOwner("u1", "kind=video&page=3"))).toEqual([]);
    });

    it("gives nothing back to another user on the same address", () => {
        writeSelection(here, ["a", "b"]);

        expect(readSelection(selectionOwner("u2", "kind=video&page=2"))).toEqual([]);
    });

    it("keeps one selection: a new view's replaces the last", () => {
        writeSelection(here, ["a", "b"]);
        writeSelection(selectionOwner("u1", "kind=image"), []);

        expect(readSelection(here)).toEqual([]);
        expect(storage.size).toBe(0);
    });

    it("reads a damaged slot as nothing", () => {
        storage.set("ps:librarySelection", "{not json");

        expect(readSelection(here)).toEqual([]);
    });
});
