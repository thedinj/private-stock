import { describe, expect, it } from "vitest";

import {
    SEARCH_COLUMN_WEIGHTS,
    buildMatchExpression,
    isTypoOf,
    searchTerms,
    tagNamePatterns,
} from "./search.js";

describe("buildMatchExpression", () => {
    it("quotes ordinary words and joins them with AND", () => {
        expect(buildMatchExpression("jane", { prefixLastTerm: false })).toBe('"jane"');
        expect(buildMatchExpression("jane doe", { prefixLastTerm: false })).toBe(
            '("jane" AND "doe") OR ("janedoe")'
        );
    });

    /**
     * §5c "Word boundaries": the words typed must also find the name written glued, because
     * `auntmargaret.mp4` is one token and no amount of AND reaches it.
     */
    it("also tries each adjacent pair of words glued", () => {
        expect(buildMatchExpression("aunt margaret beach", { prefixLastTerm: false })).toBe(
            '("aunt" AND "margaret" AND "beach") OR ("auntmargaret" AND "beach") OR ' +
                '("aunt" AND "margaretbeach")'
        );
    });

    it("glues punctuated spellings too, since they arrive as separate words", () => {
        expect(buildMatchExpression("aunt.margaret", { prefixLastTerm: false })).toBe(
            '("aunt" AND "margaret") OR ("auntmargaret")'
        );
    });

    it("prefix-matches a glued pair that ends the query", () => {
        // "aunt marg", still being typed, has to reach `auntmargaret`.
        expect(buildMatchExpression("aunt marg")).toBe('("aunt" AND "marg" *) OR ("auntmarg" *)');
    });

    it("never glues a quoted phrase, which asked for exactly those words", () => {
        expect(buildMatchExpression('"aunt margaret" beach', { prefixLastTerm: false })).toBe(
            '"aunt margaret" AND "beach"'
        );
    });

    it("caps the glued alternatives", () => {
        const expression = buildMatchExpression("a b c d e f g h", { prefixLastTerm: false });

        expect(expression?.split(" OR ")).toHaveLength(5);
    });

    it("keeps exclusions outside the alternatives", () => {
        expect(buildMatchExpression("aunt margaret -winter", { prefixLastTerm: false })).toBe(
            '(("aunt" AND "margaret") OR ("auntmargaret")) NOT ("winter")'
        );
    });

    it("prefix-matches the last word so as-you-type search finds something", () => {
        expect(buildMatchExpression("jane do")).toBe('("jane" AND "do" *) OR ("janedo" *)');
    });

    it("does not prefix-match every word", () => {
        // "a* b*" matches an enormous slice of the library and ranks it all alike.
        expect(buildMatchExpression("su mo")).toBe('("su" AND "mo" *) OR ("sumo" *)');
    });

    it("keeps a quoted phrase together", () => {
        expect(buildMatchExpression('"summer rain"')).toBe('"summer rain"');
    });

    it("treats an unclosed quote as running to the end", () => {
        // This is every intermediate state of typing a phrase. Erroring here would make the
        // search box flicker between results and a failure on every keystroke.
        expect(buildMatchExpression('"summer rai')).toBe('"summer rai"');
    });

    it("excludes a -term", () => {
        expect(buildMatchExpression("beach -winter", { prefixLastTerm: false })).toBe(
            '"beach" NOT ("winter")'
        );
    });

    it("returns null when there is nothing positive to match", () => {
        // MATCH '' is a syntax error and MATCH '""' matches nothing, so either would turn a
        // punctuation-only query into an empty library rather than an unfiltered one.
        expect(buildMatchExpression("")).toBeNull();
        expect(buildMatchExpression("   ")).toBeNull();
        expect(buildMatchExpression("!!!")).toBeNull();
        expect(buildMatchExpression("-winter")).toBeNull();
    });

    describe("input that is FTS5 syntax", () => {
        // Each of these is a syntax error or a silent misinterpretation if passed through
        // raw, and every one of them is something a person might reasonably type.
        const hostile: [string, string][] = [
            ["AND", '"AND"'],
            ["OR NOT", '("OR" AND "NOT") OR ("ORNOT")'],
            ["NEAR", '"NEAR"'],
            ['a "', '"a"'],
            ["c:/videos", '("c" AND "videos") OR ("cvideos")'],
            ["(parens)", '"parens"'],
            ["^caret", '"caret"'],
            ["star*", '"star"'],
            ["semi;colon", '("semi" AND "colon") OR ("semicolon")'],
        ];

        it.each(hostile)("neutralises %j", (input, expected) => {
            expect(buildMatchExpression(input, { prefixLastTerm: false })).toBe(expected);
        });
    });

    it("splits a punctuated word into its parts", () => {
        expect(buildMatchExpression("s01e02-final", { prefixLastTerm: false })).toBe(
            '("s01e02" AND "final") OR ("s01e02final")'
        );
    });

    it("keeps letters outside ASCII", () => {
        expect(buildMatchExpression("chloé", { prefixLastTerm: false })).toBe('"chloé"');
    });
});

describe("SEARCH_COLUMN_WEIGHTS", () => {
    it("has one weight per MediaSearch column, with the UNINDEXED one first", () => {
        // bm25() takes a weight per column positionally, so a mismatch here silently shifts
        // every weight onto the wrong column rather than failing.
        expect(SEARCH_COLUMN_WEIGHTS).toHaveLength(9);
        expect(SEARCH_COLUMN_WEIGHTS[0]).toBe(0);
    });

    it("ranks title and filename above scraped attributes", () => {
        const [, filename, title, , , attributes] = SEARCH_COLUMN_WEIGHTS;

        expect(title).toBeGreaterThan(attributes);
        expect(filename).toBeGreaterThan(attributes);
    });

    it("never lets machine-read text outrank what a person curated", () => {
        const [, filename, title, performers, tags, attributes, notes, ocr] = SEARCH_COLUMN_WEIGHTS;

        // Recognition elects a reading and can elect a wrong one. A wrong term with a high
        // weight does not merely fail to help -- it pushes good matches down, which is worse
        // than the column not existing.
        for (const curated of [filename, title, performers, tags]) {
            expect(ocr).toBeLessThan(curated);
        }

        expect(ocr).toBeLessThanOrEqual(notes);
        // Above a scraped blurb, though: a watermark is about the item, and is frequently the
        // only trustworthy metadata a file carries.
        expect(ocr).toBeGreaterThan(attributes);
    });

    /**
     * A hand-applied tag outranks a performer name, which looks backwards (§5b).
     *
     * Both are the same act, so neither is more trustworthy. The difference is what the word
     * does elsewhere: a performer's name appears where it means that performer, while a tag
     * like "funny" turns up across filenames and blurbs constantly — so without the boost the
     * deliberate filing ranks below the incidental mentions it is competing with.
     */
    it("gives a deliberate tag more weight than a name that needs none", () => {
        const [, filename, , performers, tags] = SEARCH_COLUMN_WEIGHTS;

        expect(tags).toBeGreaterThan(performers);
        // Not above the filename, which usually carries the title words too and is therefore
        // the denser evidence even though it is the less deliberate.
        expect(tags).toBeLessThan(filename);
    });
});

describe("SEARCH_COLUMN_WEIGHTS for variants", () => {
    it("ranks another spelling below every column it was derived from", () => {
        const [, filename, title, performers, tags, , notes, ocr, variants] = SEARCH_COLUMN_WEIGHTS;

        // The item written the way the searcher typed it comes first.
        for (const source of [filename, title, performers, tags]) {
            expect(variants).toBeLessThan(source);
        }

        expect(variants).toBeGreaterThan(ocr);
        expect(variants).toBeGreaterThan(notes);
    });
});

describe("tagNamePatterns", () => {
    it("matches a prefix of any word in the name", () => {
        // Against ' ' || nameNorm, so "margaret" finds "aunt margaret".
        expect(tagNamePatterns("Margaret")?.words).toBe("% margaret%");
    });

    it("matches the glued spelling anywhere, however it was punctuated", () => {
        for (const typed of ["auntmargaret", "aunt.margaret", "aunt+margaret", "Aunt Margaret"]) {
            expect(tagNamePatterns(typed)?.squashed).toBe("%auntmargaret%");
        }
    });

    it("matches a short glued spelling only as a prefix", () => {
        // "mar" inside every name would bury the names that start with it.
        expect(tagNamePatterns("mar")?.squashed).toBe("mar%");
    });

    it("returns null for text with nothing to match", () => {
        expect(tagNamePatterns("!!!")).toBeNull();
    });

    it("gives each word typed its FTS expression and its tag patterns, exclusions apart", () => {
        expect(searchTerms('aunt -winter "beach day" margaret')).toEqual({
            included: [
                { fts: '"aunt"', patterns: { words: "% aunt%", squashed: "%aunt%" } },
                { fts: '"beach day"', patterns: { words: "% beach day%", squashed: "%beachday%" } },
                // The last bare word is still being typed: a prefix, as in the full expression.
                { fts: '"margaret" *', patterns: { words: "% margaret%", squashed: "%margaret%" } },
            ],
            excluded: [{ fts: '"winter"', patterns: { words: "% winter%", squashed: "%winter%" } }],
        });
    });
});

describe("isTypoOf", () => {
    it("finds a misspelling of one word of the name", () => {
        expect(isTypoOf("margret", "Aunt Margaret")).toBe(true);
        expect(isTypoOf("magraret", "Aunt Margaret")).toBe(true);
    });

    it("finds a misspelling of the whole name glued", () => {
        expect(isTypoOf("auntmargret", "Aunt Margaret")).toBe(true);
        expect(isTypoOf("aunt margret", "Aunt Margaret")).toBe(true);
    });

    it("allows one slip in a short word and two in a long one", () => {
        expect(isTypoOf("bech", "beach")).toBe(true);
        expect(isTypoOf("bch", "beach")).toBe(false);
        expect(isTypoOf("mrgaret", "margaret")).toBe(true);
        expect(isTypoOf("margarett", "margaret")).toBe(true);
        expect(isTypoOf("mrgrt", "margaret")).toBe(false);
    });

    it("never fuzzes under four letters, where one edit reaches half the vocabulary", () => {
        expect(isTypoOf("bob", "rob")).toBe(false);
    });

    it("counts a transposition as one slip", () => {
        expect(isTypoOf("baech", "beach")).toBe(true);
    });
});
