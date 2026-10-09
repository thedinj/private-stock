import { describe, expect, it, vi } from "vitest";

/** What the index job stored, so the document can be read back. */
const stored: { filename: string; performers: string; tags: string; variants: string }[] = [];

/** What the index job wrote as the item's mentions (§5b "One rule for names"). */
const mentionWrites: { mediaId: string; mentions: { tagId: string; field: string }[] }[][] = [];

vi.mock("@private-stock/db", () => ({
    db: {
        prepare: () => ({
            get: () => ({ id: "m1", title: "Untitled", relPath: "Family/AuntMargaret.beach.mp4" }),
            all: () => [],
        }),
        transaction: (fn: () => void) => fn,
    },
    tagRepo: {
        listForMedia: () => [
            { tagId: "t-jane", kind: "performer", name: "Jane Doe" },
            { tagId: "t-beach", kind: "tag", name: "beach" },
        ],
        aliasesByTag: () =>
            new Map([
                ["t-jane", ["Jane Smith"]],
                ["t-beach", ["seaside"]],
            ]),
        publicNameVocabulary: () => new Map([["auntmargaret", "aunt margaret"]]),
    },
    mediaTextRepo: { listForMedia: () => [] },
    searchRepo: {
        upsertDocument: (document: (typeof stored)[number]) => {
            stored.push(document);
        },
    },
    mentionRepo: {
        vocabulary: () => [
            { tagId: "t-aunt", name: "Aunt Margaret" },
            { tagId: "t-jane", name: "Jane Doe" },
        ],
        writeChanged: (entries: (typeof mentionWrites)[number]) => {
            mentionWrites.push(entries);
            return entries.length;
        },
    },
}));

const { filenameSegments, indexMedia } = await import("./searchIndex.js");

const filenameText = (relPath: string | null): string => filenameSegments(relPath).join(" ");

/**
 * A tag's aliases are text about the item, in the same column as its name (§5b "Aliases"):
 * searching a maiden name has to find what was filed under the married one, and rank it as a
 * performer match.
 */
describe("indexMedia", () => {
    it("writes which tags the item's own text names, from the same text as the document", () => {
        mentionWrites.length = 0;
        indexMedia("m1");

        // `Family/AuntMargaret.beach.mp4` names Aunt Margaret; Jane Doe is only a tag on the item,
        // which is not the item's own text naming her.
        expect(mentionWrites).toEqual([
            [{ mediaId: "m1", mentions: [{ tagId: "t-aunt", field: "filename" }] }],
        ]);
    });

    it("puts each tag's aliases beside its name, in that tag's column", () => {
        indexMedia("m1");

        expect(stored.at(-1)).toMatchObject({
            performers: "Jane Doe Jane Smith",
            tags: "beach seaside",
        });
    });

    /**
     * §5c "Word boundaries": a name written glued has to be found by its words, and a name
     * written as words has to be found glued.
     */
    it("indexes a compound word beside its parts, and adjacent words glued", () => {
        indexMedia("m1");

        const document = stored.at(-1)!;

        expect(document.filename).toBe("Family AuntMargaret Aunt Margaret beach");
        expect(document.variants.split(" ")).toEqual(
            expect.arrayContaining(["auntmargaret", "margaretbeach", "janedoe", "janesmith"])
        );
        // Never across a folder boundary, nor across two tags.
        expect(document.variants.split(" ")).not.toContain("familyaunt");
        expect(document.variants.split(" ")).not.toContain("smithbeach");
    });
});

/**
 * Filenames are the densest metadata in a library like this, and almost none of it is
 * spaces-and-words. `Studio.Name.2019.1080p.x264-GROUP.mp4` is one token to any tokenizer
 * that respects word boundaries — which means indexing the raw path makes the single most
 * informative field in the library unsearchable.
 */
describe("filenameSegments", () => {
    it("splits a dotted scene name into words", () => {
        expect(filenameText("Studio.Name.2019.1080p.x264-GROUP.mp4")).toBe(
            "Studio Name 2019 1080p x264 GROUP"
        );
    });

    it("keeps folder names, which often carry the only studio or series recorded", () => {
        expect(filenameText("Aurora Films/Season 2/episode-04.mkv")).toBe(
            "Aurora Films Season 2 episode 04"
        );
    });

    it("handles Windows separators", () => {
        // Paths are stored as they were read, and a Windows-side scan produces backslashes.
        expect(filenameText("Aurora\\episode-04.mkv")).toBe("Aurora episode 04");
    });

    it("drops the extension", () => {
        // Every video in the library matching "mp4" is not a useful result, and making the
        // extension a common term dilutes the ranking of everything else.
        expect(filenameText("holiday.mp4")).toBe("holiday");
        expect(filenameText("holiday.MP4")).toBe("holiday");
    });

    it("splits bracketed and parenthesised groups", () => {
        expect(filenameText("movie [1080p] (director's cut).mkv")).toBe(
            "movie 1080p director's cut"
        );
    });

    it("collapses runs of separators rather than leaving empty tokens", () => {
        expect(filenameText("a...b___c---d.mp4")).toBe("a b c d");
    });

    it("returns empty for a missing path rather than throwing", () => {
        // An item can exist with no active file: the row is there while the file is missing.
        expect(filenameText(null)).toBe("");
    });

    it("leaves a name that is already words alone", () => {
        expect(filenameText("Summer Rain.mp4")).toBe("Summer Rain");
    });

    it("keeps a dotless name intact", () => {
        // path.extname returns "" here, so the slice must not trim anything.
        expect(filenameText("README")).toBe("README");
    });
});
