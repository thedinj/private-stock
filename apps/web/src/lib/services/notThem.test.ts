import { beforeEach, describe, expect, it, vi } from "vitest";

/** Taking a library performer off items on purpose refuses them there (§5f "Corrections stick"). */

const state = vi.hoisted(() => ({
    faces: [] as unknown[][],
    names: [] as unknown[][],
    removed: [] as unknown[][],
}));

vi.mock("@private-stock/db", () => ({
    // A press runs its writes, as one decision (§5f "Decisions you can take back").
    faceDecisionRepo: {
        record: (_decision: unknown, write: () => unknown) => ({
            decisionId: "d1",
            result: write(),
        }),
        nameActive: () => undefined,
    },
    tagRepo: {
        findById: (id: string) =>
            ({
                jane: { id, kind: "performer", ownerId: null },
                mine: { id, kind: "performer", ownerId: "u1" },
                beach: { id, kind: "keyword", ownerId: null },
            })[id],
    },
    faceRepo: { refuseOnItems: (...args: unknown[]) => state.faces.push(args) },
    mentionRepo: { refuseItems: (...args: unknown[]) => state.names.push(args) },
    jobRepo: { enqueueKind: () => undefined },
    faceAutoTagRepo: { markRemoved: (...args: unknown[]) => state.removed.push(args) },
}));

const { notThem } = await import("./notThem");

beforeEach(() => {
    state.faces = [];
    state.names = [];
    state.removed = [];
});

describe("not them", () => {
    it("refuses a library performer's faces and name match on the items", () => {
        notThem(["a", "b"], "jane", "u1");

        expect(state.faces).toEqual([[["a", "b"], "jane", "u1"]]);
        expect(state.names).toEqual([["jane", ["a", "b"], "u1"]]);
        // A tag faces made by themselves, taken back: counted against them.
        expect(state.removed).toEqual([[["a", "b"], "jane", "u1"]]);
    });

    it("leaves other kinds, private tags and nothing at all alone", () => {
        notThem(["a"], "beach", "u1");
        notThem(["a"], "mine", "u1");
        notThem([], "jane", "u1");
        notThem(["a"], "gone", "u1");

        expect(state.faces).toEqual([]);
        expect(state.names).toEqual([]);
    });
});
