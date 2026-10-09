import { describe, expect, it } from "vitest";

import { matchesCollectionSearch } from "./collectionSearch";

const row = { name: "Sunny beach days", description: "Holiday 2024, the good ones" };

describe("matchesCollectionSearch", () => {
    it("matches everything when nothing is typed", () => {
        expect(matchesCollectionSearch(row, "")).toBe(true);
        expect(matchesCollectionSearch(row, "   ")).toBe(true);
    });

    it("needs every word, in any order and any case", () => {
        expect(matchesCollectionSearch(row, "BEACH sun")).toBe(true);
        expect(matchesCollectionSearch(row, "beach snow")).toBe(false);
    });

    it("looks in the description as well as the name", () => {
        expect(matchesCollectionSearch(row, "holiday beach")).toBe(true);
        expect(matchesCollectionSearch({ ...row, description: null }, "holiday")).toBe(false);
    });
});
