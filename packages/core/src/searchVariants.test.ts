import { describe, expect, it } from "vitest";

import { expandCompounds, searchVariants, squashName } from "./searchVariants.js";

const NO_VOCABULARY = new Map<string, string>();

describe("expandCompounds", () => {
    it("follows a camelCase word with its parts", () => {
        expect(expandCompounds("AuntMargaret Beach")).toBe("AuntMargaret Aunt Margaret Beach");
    });

    it("splits where letters meet digits", () => {
        expect(expandCompounds("Holiday2019")).toBe("Holiday2019 Holiday 2019");
    });

    it("keeps an acronym together before the word it runs into", () => {
        expect(expandCompounds("HTMLParser")).toBe("HTMLParser HTML Parser");
    });

    it("leaves ordinary words alone and drops punctuation", () => {
        expect(expandCompounds("summer rain, again")).toBe("summer rain again");
    });

    it("keeps accented letters inside the word", () => {
        expect(expandCompounds("Chloé")).toBe("Chloé");
    });
});

describe("searchVariants", () => {
    const variants = (phrases: string[]): string =>
        searchVariants({ phrases, messy: [] }, NO_VOCABULARY);

    it("glues each adjacent pair of words", () => {
        expect(variants(["Aunt Margaret Beach"])).toBe("auntmargaret margaretbeach");
    });

    it("glues the parts of a compound word, which rebuilds the word as typed", () => {
        expect(variants(["AuntMargaret"])).toBe("auntmargaret");
    });

    it("never pairs across phrases", () => {
        // Two tags, or a folder and a filename, were never written side by side.
        expect(variants(["Aunt", "Margaret"])).toBe("");
    });

    it("never glues two numbers", () => {
        // `1080p` splits to 1080 and p, and gluing those rebuilds it; 2019 + 1080 is noise.
        expect(variants(["2019 1080p"])).toBe("1080p");
    });

    describe("known names inside glued words", () => {
        const vocabulary = new Map(
            ["aunt margaret", "beach", "anna", "margaret"].map((name) => [squashName(name), name])
        );
        const found = (word: string): string[] =>
            searchVariants({ phrases: [], messy: [word] }, vocabulary)
                .split(" ")
                .filter(Boolean);

        it("finds a multi-word name written glued", () => {
            const names = searchVariants({ phrases: [], messy: ["auntmargaretbeach"] }, vocabulary);

            expect(names).toContain("aunt margaret");
            expect(names).toContain("beach");
        });

        it("finds a long name anywhere in the word", () => {
            expect(found("xxmargaretxx")).toContain("margaret");
        });

        it("takes a short name only at the start or end of the word", () => {
            // `anna` inside `hannah` is a coincidence; at the edge it is far less likely to be.
            expect(found("hannah")).not.toContain("anna");
            expect(found("annabeach")).toContain("anna");
        });

        it("adds nothing for a word that already is a one-word name", () => {
            expect(found("beach")).toEqual([]);
        });

        it("reads only the text it is told is messy", () => {
            // A tag name is curated: somebody chose to write it glued.
            expect(searchVariants({ phrases: ["auntmargaretbeach"], messy: [] }, vocabulary)).toBe(
                ""
            );
        });
    });
});
