import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The library-wide rematch of which tags each item's text names (§5b "One rule for names"): it
 * runs when the vocabulary changed, and only then.
 */

const state = vi.hoisted(() => ({
    vocabulary: [{ tagId: "t-aunt", name: "Aunt Margaret" }] as { tagId: string; name: string }[],
    documents: [
        {
            cursor: 1,
            mediaId: "m1",
            texts: { filename: "AuntMargaret beach", title: "", screen: "", metadata: "" },
        },
        {
            cursor: 2,
            mediaId: "m2",
            texts: { filename: "garden", title: "", screen: "", metadata: "" },
        },
    ],
    writes: [] as { mediaId: string; mentions: { tagId: string; field: string }[] }[][],
}));

vi.mock("@private-stock/db", () => ({
    mentionRepo: {
        vocabulary: () => state.vocabulary,
        documentsAfter: (cursor: number) =>
            state.documents.filter((document) => document.cursor > cursor),
        writeChanged: (entries: (typeof state.writes)[number]) => {
            state.writes.push(entries);
            return entries.length;
        },
    },
}));

vi.mock("../eventLoop.js", () => ({ breathe: async (since: number) => since }));

const { runMentionMatch } = await import("./mentionMatch.js");

beforeEach(() => {
    state.writes.length = 0;
});

describe("runMentionMatch", () => {
    it("matches every document, then does nothing until the vocabulary changes", async () => {
        await runMentionMatch();

        expect(state.writes.flat()).toEqual([
            { mediaId: "m1", mentions: [{ tagId: "t-aunt", field: "filename" }] },
            { mediaId: "m2", mentions: [] },
        ]);

        state.writes.length = 0;
        await runMentionMatch();
        expect(state.writes).toEqual([]);

        // A new name: everything is matched again, and now the garden names somebody.
        state.vocabulary = [...state.vocabulary, { tagId: "t-garden", name: "Garden" }];
        await runMentionMatch();

        expect(state.writes.flat()).toContainEqual({
            mediaId: "m2",
            mentions: [{ tagId: "t-garden", field: "filename" }],
        });
    });
});
