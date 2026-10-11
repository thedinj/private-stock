import { describe, expect, it } from "vitest";

import {
    buildTagMatcher,
    correctedText,
    matchTagNames,
    mentionsIn,
    type TagNameEntry,
} from "./ocrTagMatch.js";

const VOCABULARY: TagNameEntry[] = [
    { tagId: "jane", name: "Jane Doe" },
    { tagId: "jane", name: "Jane Smith" },
    { tagId: "janeOnly", name: "Jane" },
    { tagId: "site", name: "Example Site" },
    { tagId: "anna", name: "Anna" },
    { tagId: "valentina", name: "Valentina" },
    { tagId: "brunette", name: "Brunette Studio" },
];

const matcher = buildTagMatcher(VOCABULARY);

const found = (text: string): Array<[string, string, string]> =>
    matchTagNames(text, matcher).map((match) => [match.tagId, match.kind, match.matchedText]);

describe("matchTagNames", () => {
    it("matches a string that is exactly a name", () => {
        expect(found("JANE DOE")).toEqual([["jane", "exact", "JANE DOE"]]);
    });

    it("matches a name as a phrase inside longer text", () => {
        expect(found("starring Jane Doe tonight")).toEqual([["jane", "contains", "Jane Doe"]]);
    });

    it("matches a name glued into one word", () => {
        expect(found("janedoe")).toEqual([["jane", "contains", "janedoe"]]);
    });

    it("matches a camel-cased name through its parts", () => {
        expect(found("JaneDoe")).toEqual([["jane", "exact", "JaneDoe"]]);
    });

    it("matches a source glued into a domain", () => {
        expect(found("www.examplesite.com")).toEqual([["site", "contains", "examplesite"]]);
    });

    it("answers an alias with its tag", () => {
        expect(found("Jane Smith")).toEqual([["jane", "exact", "Jane Smith"]]);
    });

    it("finds a performer and a source in one watermark", () => {
        expect(found("JaneDoe @ examplesite.com")).toEqual([
            ["jane", "contains", "JaneDoe"],
            ["site", "contains", "examplesite"],
        ]);
    });

    it("reads a misreading of confusable glyphs as near", () => {
        expect(found("JANE D0E")).toEqual([["jane", "near", "JANE D0E"]]);
    });

    it("reads a long name one edit away as near", () => {
        expect(found("VALENTlNA")).toEqual([["valentina", "near", "VALENTlNA"]]);
        expect(found("VALENTXNA")).toEqual([["valentina", "near", "VALENTXNA"]]);
    });

    it("does not take a long name two edits away", () => {
        expect(found("VALEXTXNA")).toEqual([]);
    });

    it("never takes a short name one edit away", () => {
        expect(found("ANNE")).toEqual([]);
    });

    it("takes a short glued name only at the edge of a word", () => {
        expect(found("annabelle")).toEqual([["anna", "contains", "anna"]]);
        expect(found("savannah")).toEqual([]);
    });

    it("keeps the longer of two overlapping names", () => {
        expect(found("Jane Doe")).toEqual([["jane", "exact", "Jane Doe"]]);
        expect(found("Jane Doe").map(([tagId]) => tagId)).not.toContain("janeOnly");
    });

    it("still finds the shorter name where it stands alone", () => {
        expect(found("Jane")).toEqual([["janeOnly", "exact", "Jane"]]);
    });

    it("finds nothing in text that names nobody", () => {
        expect(found("1080p HD")).toEqual([]);
    });
});

/** One rule for names (§5b): accents fold, every separator splits, apostrophes join. */
describe("matchTagNames, across spellings", () => {
    const names = buildTagMatcher([
        { tagId: "zoe", name: "Zoë Laine" },
        { tagId: "mk", name: "Mary-Kate" },
        { tagId: "ob", name: "O'Brien" },
        { tagId: "anna", name: "Anna" },
        { tagId: "annaSmith", name: "Anna Smith" },
    ]);
    const tagsIn = (text: string, near = true): string[] =>
        matchTagNames(text, names, { near }).map((match) => match.tagId);

    it("finds an accented name written without accents, and the reverse", () => {
        expect(tagsIn("zoe laine beach")).toEqual(["zoe"]);
        expect(tagsIn("ZOË LAINE")).toEqual(["zoe"]);
        expect(tagsIn("zoelaine_clip")).toEqual(["zoe"]);
    });

    it("finds a hyphenated name however it is separated or glued", () => {
        for (const text of [
            "Mary Kate",
            "mary_kate",
            "Mary+Kate",
            "mary.kate",
            "marykate",
            "MaryKate",
        ]) {
            expect(tagsIn(text)).toEqual(["mk"]);
        }
    });

    it("finds a name with an apostrophe written with or without it", () => {
        expect(tagsIn("o'brien interview")).toEqual(["ob"]);
        expect(tagsIn("OBrien")).toEqual(["ob"]);
    });

    it("reports positions in the text as read, accents and all", () => {
        const [match] = matchTagNames("» Zoë Laine «", names);

        expect(match.matchedText).toBe("Zoë Laine");
        expect(match.start).toBe(2);
    });

    it("does not find a short name inside a longer one it is part of", () => {
        expect(tagsIn("anna smith at the beach")).toEqual(["annaSmith"]);
        expect(tagsIn("anna at the beach")).toEqual(["anna"]);
    });

    it("leaves misreadings out when asked to", () => {
        expect(tagsIn("ZOË LA1NE", true)).toEqual(["zoe"]);
        expect(tagsIn("ZOË LA1NE", false)).toEqual([]);
    });
});

describe("correctedText", () => {
    it("replaces the misread span with the name", () => {
        expect(correctedText("STARRING JANE D0E", { matchedText: "JANE D0E" }, "Jane Doe")).toBe(
            "STARRING Jane Doe"
        );
    });

    it("leaves text alone when the span is not in it", () => {
        expect(correctedText("JANE DOE", { matchedText: "x" }, "Jane Doe")).toBe("JANE DOE");
    });
});

describe("mentionsIn", () => {
    const names = buildTagMatcher([
        { tagId: "aunt", name: "Aunt Margaret" },
        { tagId: "beach", name: "Beach" },
        { tagId: "site", name: "examplesite.com" },
    ]);

    it("reports each tag once per field it is found in", () => {
        expect(
            mentionsIn(
                {
                    filename: "Holidays AuntMargaret Aunt Margaret beach 2019",
                    title: "Beach Day",
                    screen: "EXAMPLESITE.COM auntmargaret",
                    metadata: "Posted by @AuntMargaret on examplesite.com",
                },
                names
            )
        ).toEqual([
            { tagId: "aunt", field: "filename" },
            { tagId: "beach", field: "filename" },
            { tagId: "beach", field: "title" },
            { tagId: "site", field: "screen" },
            { tagId: "aunt", field: "screen" },
            { tagId: "aunt", field: "metadata" },
            { tagId: "site", field: "metadata" },
        ]);
    });

    it("finds nothing in empty text, and no misreadings even on screen", () => {
        expect(
            mentionsIn({ filename: "", title: "", screen: "AUNT MARGARE7", metadata: "" }, names)
        ).toEqual([]);
    });
});
