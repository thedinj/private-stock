import { describe, expect, it } from "vitest";

import { orderTagMatches } from "./tagNameOrder.js";

/** The vocabulary as the server sends it: most used first. */
const byCount = ["beachfront", "Offshore", "selfie", "fall-guys", "Fiona", "crown"];
const none = new Map<string, string[]>();

describe("ordering a tag box's matches", () => {
    it("puts names starting with what was typed before those merely containing it", () => {
        expect(orderTagMatches(byCount, none, "f")).toEqual([
            "fall-guys",
            "Fiona",
            "beachfront",
            "Offshore",
            "selfie",
        ]);
    });

    it("keeps the most used first among names that match the same way", () => {
        const names = ["fiona", "fall-guys", "frost"];

        expect(orderTagMatches(names, none, "f")).toEqual(["fiona", "fall-guys", "frost"]);
    });

    it("puts the whole name first, however rarely it is used", () => {
        expect(orderTagMatches(["beachfront", "beach"], none, "beach")).toEqual([
            "beach",
            "beachfront",
        ]);
    });

    /** People remember "Doe" as often as "Jane". */
    it("ranks the start of a later word above a match inside a word", () => {
        const names = ["Moe Sizlak", "Jane Doe", "Doe-eyed"];

        expect(orderTagMatches(names, none, "doe")).toEqual(["Doe-eyed", "Jane Doe"]);
        expect(orderTagMatches(["Undoer", "Jane Doe"], none, "doe")).toEqual([
            "Jane Doe",
            "Undoer",
        ]);
    });

    it("finds a word start past an earlier match inside a word", () => {
        expect(orderTagMatches(["undo do", "undone"], none, "do")).toEqual(["undo do", "undone"]);
    });

    it("ranks an alias just below a name that matches the same way", () => {
        const aliases = new Map([["Jane Doe", ["Jane Smith"]]]);

        expect(orderTagMatches(["Jane Doe", "Smithers"], aliases, "smith")).toEqual([
            "Smithers",
            "Jane Doe",
        ]);
        // ...but above a name matching worse: her maiden name in full beats a substring.
        expect(orderTagMatches(["Blacksmith", "Jane Doe"], aliases, "jane smith")).toEqual([
            "Jane Doe",
        ]);
        expect(orderTagMatches(["Blacksmith", "Jane Doe"], aliases, "smith")).toEqual([
            "Jane Doe",
            "Blacksmith",
        ]);
    });

    it("ignores case and surrounding space, and matches nothing on nothing", () => {
        expect(orderTagMatches(byCount, none, "  FI ")).toEqual(["Fiona", "selfie"]);
        expect(orderTagMatches(byCount, none, "   ")).toEqual([]);
    });
});

/** §5c "Word boundaries": one name typed three ways is still one name. */
describe("glued and punctuated spellings", () => {
    const names = ["beach", "Aunt Margaret"];

    it("matches a name typed glued or punctuated as if typed in full", () => {
        for (const typed of ["auntmargaret", "aunt.margaret", "aunt+margaret"]) {
            expect(orderTagMatches(names, none, typed), typed).toEqual(["Aunt Margaret"]);
        }
    });

    it("matches the start of a glued name while it is typed", () => {
        expect(orderTagMatches(names, none, "auntmarg")).toEqual(["Aunt Margaret"]);
    });

    it("matches a glued spelling of an alias", () => {
        const aliases = new Map([["Aunt Margaret", ["Maggie May"]]]);

        expect(orderTagMatches(names, aliases, "maggiemay")).toEqual(["Aunt Margaret"]);
    });
});

/** §5b "One rule for names": accents and every separator fold, as the server's search does. */
describe("one rule for names", () => {
    it("orders an accented name typed without accents as a whole-name match", () => {
        expect(orderTagMatches(["Zoëy", "Zoë"], none, "zoe")).toEqual(["Zoë", "Zoëy"]);
    });

    it("treats a hyphen as a word break, so the second word is a word start", () => {
        expect(orderTagMatches(["Kateland", "Mary-Kate"], none, "kate")).toEqual([
            "Kateland",
            "Mary-Kate",
        ]);
        expect(orderTagMatches(["Mary-Kate"], none, "mary_kate")).toEqual(["Mary-Kate"]);
    });
});
