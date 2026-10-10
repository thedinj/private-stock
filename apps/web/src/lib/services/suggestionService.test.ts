import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../auth/withAuth";

/**
 * Suggestions (§5f "Suggestions"): who may ask, how a page is made, and what saying who people
 * are writes — one decision, the items tagged for those that are them.
 */

const state = vi.hoisted(() => ({
    rows: [] as Record<string, unknown>[],
    faces: [] as Record<string, unknown>[],
    confirmed: [] as unknown[][],
    refused: [] as unknown[][],
    batches: [] as { assignments: { mediaId: string; tagId: string }[] }[],
    decisions: [] as Record<string, unknown>[],
}));

vi.mock("@private-stock/db", () => ({
    db: { transaction: <T>(fn: () => T) => fn },
    faceDecisionRepo: {
        record: (decision: Record<string, unknown>, write: () => unknown) => {
            state.decisions.push(decision);
            return { decisionId: "d1", result: write() };
        },
    },
    appearanceRepo: {
        suggestedPerformers: () => [{ tagId: "jane", count: 2 }],
        suggestions: () => state.rows,
        appearanceFaces: () => state.faces,
        facesOnItem: (mediaId: string, faceIds: string[]) =>
            faceIds.filter((id) => id.startsWith(mediaId)),
        confirmPerson: (...args: unknown[]) => state.confirmed.push(args),
        refusePerson: (...args: unknown[]) => state.refused.push(args),
    },
    searchRepo: { requestReindex: () => undefined },
    tagBatchRepo: {
        applyAssignments: (input: { assignments: { mediaId: string; tagId: string }[] }) => {
            state.batches.push(input);
            return { batchId: "b1", assigned: input.assignments.length };
        },
    },
    tagRepo: {
        findById: (id: string) =>
            id === "jane" ? { id, kind: "performer", name: "Jane", ownerId: null } : undefined,
    },
}));

vi.mock("./faceService", () => ({
    confirmationsChanged: () => undefined,
    reviewFace: (face: { id: string; mediaId: string }) => [
        { ...face, crop: { url: "u", rect: {}, frame: {} }, kind: "video", atMs: 0, box: {} },
    ],
}));

vi.mock("./mediaService", () => ({
    lookupMedia: (ids: string[]) => ({
        items: ids.filter((id) => id !== "hidden").map((id) => ({ id })),
    }),
}));

vi.mock("./tagPictureService", () => ({ picturesFor: () => new Map() }));

const { decideSuggestions, suggestionPerformers, suggestions } =
    await import("./suggestionService");

const admin: AuthContext = {
    userId: "u1",
    email: "u1@example.test",
    displayName: "U",
    scopes: ["admin"],
    accessibleRootIds: ["r1"],
    tokenEpoch: 0,
};

beforeEach(() => {
    state.rows = [];
    state.faces = [];
    state.confirmed = [];
    state.refused = [];
    state.batches = [];
    state.decisions = [];
});

describe("a performer's suggestions", () => {
    it("shows each person's clearest face, their others to look closer, and every face of theirs", () => {
        state.rows = [
            {
                id: "p1",
                mediaId: "m1",
                kind: "video",
                title: "One",
                faceCount: 3,
                bestFaceId: "m1-b",
                score: 0.8,
                named: 0,
            },
            {
                id: "p2",
                mediaId: "m2",
                kind: "video",
                title: "Two",
                faceCount: 2,
                bestFaceId: "m2-a",
                score: 0.7,
                named: 1,
            },
        ];
        state.faces = [
            { appearanceId: "p1", id: "m1-a", mediaId: "m1" },
            { appearanceId: "p1", id: "m1-b", mediaId: "m1" },
            { appearanceId: "p1", id: "m1-c", mediaId: "m1" },
            { appearanceId: "p2", id: "m2-a", mediaId: "m2" },
            { appearanceId: "p2", id: "m2-b", mediaId: "m2" },
        ];

        const page = suggestions({ tagId: "jane", limit: 1 }, admin);

        expect(page.suggestions).toHaveLength(1);
        expect(page.suggestions[0]).toMatchObject({
            moments: 3,
            faceIds: ["m1-a", "m1-b", "m1-c"],
            named: false,
        });
        expect(page.suggestions[0].face.id).toBe("m1-b");
        expect(page.suggestions[0].others.map((face) => face.id)).toEqual(["m1-a", "m1-c"]);
        expect(page.next).toBe("0.8|p1");
    });

    it("is for administrators, and for library performers", () => {
        expect(() => suggestions({ tagId: "nobody", limit: 5 }, admin)).toThrow(/not found/);
        expect(() => suggestionPerformers({}, { ...admin, scopes: [] })).toThrow(/administrator/);
    });
});

describe("saying who people are", () => {
    it("tags the items of those that are them, refuses the others, as one decision", () => {
        const result = decideSuggestions(
            {
                tagId: "jane",
                people: [
                    {
                        mediaId: "m1",
                        faceIds: ["m1-a", "m1-b"],
                        shownFaceId: "m1-a",
                        verdict: "is",
                    },
                    { mediaId: "m2", faceIds: ["m2-a"], shownFaceId: "m2-a", verdict: "isNot" },
                    // Not this viewer's to decide, and faces not on the item named.
                    {
                        mediaId: "hidden",
                        faceIds: ["hidden-a"],
                        shownFaceId: "hidden-a",
                        verdict: "is",
                    },
                    { mediaId: "m3", faceIds: ["m9-a"], shownFaceId: "m9-a", verdict: "is" },
                ],
            },
            admin
        );

        expect(result).toEqual({ tagged: 1, refused: 1 });
        expect(state.decisions).toEqual([
            expect.objectContaining({ verdict: "is", tagId: "jane", surface: "review" }),
        ]);
        expect(state.confirmed).toEqual([[["m1-a", "m1-b"], "m1-a", "jane", "u1"]]);
        expect(state.refused).toEqual([[["m2-a"], "m2-a", "jane", "u1"]]);
        expect(state.batches[0].assignments).toEqual([{ mediaId: "m1", tagId: "jane" }]);
    });

    it("is a refusal when nobody was them, and says so when nothing is left to decide", () => {
        decideSuggestions(
            {
                tagId: "jane",
                people: [
                    { mediaId: "m2", faceIds: ["m2-a"], shownFaceId: "m2-a", verdict: "isNot" },
                ],
            },
            admin
        );

        expect(state.decisions[0]).toMatchObject({ verdict: "isNot" });
        expect(state.batches).toEqual([]);
        expect(() =>
            decideSuggestions(
                {
                    tagId: "jane",
                    people: [
                        {
                            mediaId: "hidden",
                            faceIds: ["hidden-a"],
                            shownFaceId: "hidden-a",
                            verdict: "is",
                        },
                    ],
                },
                admin
            )
        ).toThrow(/any more/);
    });
});
