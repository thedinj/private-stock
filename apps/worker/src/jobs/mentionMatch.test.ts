import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The library-wide rematch of which tags each item's text names (§5b "One rule for names"): it
 * runs when the vocabulary changed, and only then — and matches each item against its own room's
 * names alone (§21).
 */

const state = vi.hoisted(() => ({
    vocabularies: {
        cellar: [{ tagId: "t-aunt", name: "Aunt Margaret" }],
        family: [] as { tagId: string; name: string }[],
        games: [] as { tagId: string; name: string }[],
    } as Record<string, { tagId: string; name: string }[]>,
    documents: [
        {
            cursor: 1,
            mediaId: "m1",
            domain: "cellar" as string | null,
            texts: { filename: "AuntMargaret beach", title: "", screen: "", metadata: "" },
        },
        {
            cursor: 2,
            mediaId: "m2",
            domain: "cellar" as string | null,
            texts: { filename: "garden", title: "", screen: "", metadata: "" },
        },
        {
            cursor: 3,
            mediaId: "h1",
            domain: "family" as string | null,
            texts: { filename: "Aunt Margaret garden", title: "", screen: "", metadata: "" },
        },
        {
            cursor: 4,
            mediaId: "x1",
            domain: null as string | null,
            texts: { filename: "Aunt Margaret", title: "", screen: "", metadata: "" },
        },
    ],
    writes: [] as { mediaId: string; mentions: { tagId: string; field: string }[] }[][],
}));

vi.mock("@private-stock/db", () => ({
    mentionRepo: {
        vocabulary: (domain: string) => state.vocabularies[domain] ?? [],
        documentsAfter: (cursor: number) =>
            state.documents.filter((document) => document.cursor > cursor),
        writeChanged: (entries: (typeof state.writes)[number]) => {
            state.writes.push(entries);
            return entries.length;
        },
    },
}));

vi.mock("../eventLoop.js", () => ({ breathe: async (since: number) => since }));

const { mentionsForItem, runMentionMatch } = await import("./mentionMatch.js");

beforeEach(() => {
    state.writes.length = 0;
});

describe("runMentionMatch", () => {
    it("matches every document, then does nothing until the vocabulary changes", async () => {
        await runMentionMatch();

        expect(state.writes.flat()).toEqual([
            { mediaId: "m1", mentions: [{ tagId: "t-aunt", field: "filename" }] },
            { mediaId: "m2", mentions: [] },
            // The Parlour's video names nobody the Cellar knows, and an item in no room nobody.
            { mediaId: "h1", mentions: [] },
            { mediaId: "x1", mentions: [] },
        ]);

        state.writes.length = 0;
        await runMentionMatch();
        expect(state.writes).toEqual([]);

        // A new name in the Parlour: everything is matched again, and only its garden names it.
        state.vocabularies.family = [{ tagId: "t-garden", name: "Garden" }];
        await runMentionMatch();

        const written = state.writes.flat();

        expect(written).toContainEqual({
            mediaId: "h1",
            mentions: [{ tagId: "t-garden", field: "filename" }],
        });
        expect(written).toContainEqual({ mediaId: "m2", mentions: [] });
    });

    it("matches one item against its own room's names when it is indexed", () => {
        const texts = { filename: "Aunt Margaret", title: "", screen: "", metadata: "" };

        expect(mentionsForItem(texts, "cellar")).toEqual([{ tagId: "t-aunt", field: "filename" }]);
        expect(mentionsForItem(texts, "family")).toEqual([]);
        expect(mentionsForItem(texts, null)).toEqual([]);
    });
});
