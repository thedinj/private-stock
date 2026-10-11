import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../auth/withAuth";

/**
 * People in this item (§5f "People in this item"): what each person is shown as, and what each
 * decision writes.
 */

const state = vi.hoisted(() => ({
    rows: [] as Record<string, unknown>[],
    named: [] as { tagId: string; field: string }[],
    carried: [] as { tagId: string; source: string; private: null }[],
    decisions: [] as Record<string, unknown>[],
    calls: [] as unknown[][],
    notThem: [] as unknown[][],
}));

vi.mock("@private-stock/db", () => ({
    db: { transaction: <T>(fn: () => T) => fn },
    faceDecisionRepo: {
        record: (decision: Record<string, unknown>, write: () => unknown) => {
            state.decisions.push(decision);
            return { decisionId: "d1", result: write() };
        },
        nameActive: () => undefined,
    },
    appearanceRepo: {
        itemPeople: () => state.rows,
        appearanceFaces: () => [
            { appearanceId: "p1", id: "f1", mediaId: "m1" },
            { appearanceId: "p2", id: "g1", mediaId: "m1" },
            { appearanceId: "p3", id: "h1", mediaId: "m1" },
        ],
        facesOnItem: (_mediaId: string, faceIds: string[]) => faceIds,
        confirmPerson: (...args: unknown[]) => state.calls.push(["confirm", ...args]),
        takeBackPerson: (...args: unknown[]) => state.calls.push(["takeBack", ...args]),
    },
    mentionRepo: { untaggedPerformersNamedOn: () => state.named },
    searchRepo: { requestReindex: () => undefined },
    tagBatchRepo: {
        applyAssignments: (input: { assignments: unknown[] }) => {
            state.calls.push(["tag", input.assignments]);
            return { batchId: "b1", assigned: input.assignments.length };
        },
    },
    tagRepo: {
        findById: (id: string) =>
            ({ jane: "Jane", kim: "Kim", new: "New" })[id]
                ? { id, kind: "performer", name: id, ownerId: null }
                : undefined,
        listForMedia: () => state.carried,
        ensureTag: () => "new",
    },
}));

vi.mock("./faceService", () => ({
    confirmationsChanged: () => undefined,
    reviewFace: (face: { id: string; mediaId: string }) => [
        { ...face, crop: { url: "u", rect: {}, frame: {} }, kind: "video", atMs: 0, box: {} },
    ],
}));

vi.mock("./tagPictureService", () => ({ picturesFor: () => new Map() }));
vi.mock("./mediaService", () => ({
    lookupMedia: (ids: string[]) => ({
        items: ids.filter((id) => id !== "hidden").map((id) => ({ id, kind: "video", title: id })),
    }),
}));

vi.mock("./notThem", () => ({ notThem: (...args: unknown[]) => state.notThem.push(args) }));

const { decideItemPeople, itemPeople } = await import("./itemPeopleService");

const admin: AuthContext = {
    userId: "u1",
    email: "u1@example.test",
    displayName: "U",
    scopes: ["admin"],
    accessibleRootIds: ["r1"],
    tokenEpoch: 0,
};

const row = (id: string, bestFaceId: string, extra: Record<string, unknown>) => ({
    id,
    bestFaceId,
    moments: 3,
    legible: 1,
    matchTagId: null,
    score: null,
    second: null,
    confirmedTagId: null,
    refusedMatch: 0,
    ...extra,
});

beforeEach(() => {
    state.rows = [];
    state.named = [];
    state.carried = [];
    state.decisions = [];
    state.calls = [];
    state.notThem = [];
});

describe("who is in it", () => {
    it("says each person is confirmed, suggested at Suggestions' lines, or nobody yet", () => {
        state.rows = [
            row("p1", "f1", { confirmedTagId: "kim" }),
            row("p2", "g1", { matchTagId: "jane", score: 0.7, second: 0.3 }),
            row("p3", "h1", { matchTagId: "jane", score: 0.5, second: 0.3 }),
        ];
        state.carried = [{ tagId: "kim", source: "ai", private: null }];
        state.named = [
            { tagId: "jane", field: "title" },
            { tagId: "new", field: "filename" },
        ];

        const people = itemPeople("m1", admin);

        expect(people.people.map((p) => [p.state, p.performer?.id ?? null, p.byApp])).toEqual([
            ["confirmed", "kim", true],
            ["suggested", "jane", false],
            // At 0.5 only with the name on the item, which it has: jane is named.
            ["suggested", "jane", false],
        ]);
        // Named, and not already one of the people suggested.
        expect(people.named.map((n) => n.tagId)).toEqual(["new"]);
    });

    it("is for administrators, on items they can see", () => {
        expect(() => itemPeople("m1", { ...admin, scopes: [] })).toThrow(/administrator/);
        expect(() => itemPeople("hidden", admin)).toThrow(/not found/);
    });
});

describe("saying who", () => {
    const person = { faceIds: ["g1"], shownFaceId: "g1" };

    it("confirms and tags as one decision; takes back as another; names somebody new", () => {
        decideItemPeople("m1", { action: "is", tagId: "jane", person }, admin);
        decideItemPeople("m1", { action: "isNot", tagId: "jane", person }, admin);
        decideItemPeople("m1", { action: "name", name: "New", person }, admin);

        expect(state.decisions.map((d) => [d.verdict, d.surface])).toEqual([
            ["is", "item"],
            ["isNot", "item"],
            ["is", "item"],
        ]);
        expect(state.calls.map((call) => call[0])).toEqual([
            "confirm",
            "tag",
            "takeBack",
            "confirm",
            "tag",
        ]);
    });

    it("tags a performer the text names, or says not them on the item", () => {
        decideItemPeople("m1", { action: "addNamed", tagId: "kim" }, admin);
        decideItemPeople("m1", { action: "refuseNamed", tagId: "kim" }, admin);

        expect(state.calls).toEqual([["tag", [{ mediaId: "m1", tagId: "kim" }]]]);
        expect(state.notThem).toEqual([[["m1"], "kim", "u1", "item"]]);
    });
});
