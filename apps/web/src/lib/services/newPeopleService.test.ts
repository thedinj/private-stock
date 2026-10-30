import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../auth/withAuth";

/**
 * New people (§5f "New people"): a page of gatherings with their cards, and what naming, "not one
 * person" and "later" write.
 */

const state = vi.hoisted(() => ({
    decisions: [] as Record<string, unknown>[],
    calls: [] as unknown[][],
}));

vi.mock("@private-stock/db", () => ({
    db: { transaction: <T>(fn: () => T) => fn },
    faceDecisionRepo: {
        record: (decision: Record<string, unknown>, write: () => unknown) => {
            state.decisions.push(decision);
            return { decisionId: "d1", result: write() };
        },
        nameActive: (tagId: string) => state.calls.push(["named", tagId]),
    },
    appearanceRepo: {
        newPeople: () => ({ rows: [{ newPersonId: "np", items: 5 }], total: 1 }),
        newPersonPeople: () => [
            {
                id: "p1",
                newPersonId: "np",
                mediaId: "m1",
                kind: "video",
                title: "One",
                bestFaceId: "f1",
                moments: 3,
            },
        ],
        appearanceFaces: () => [
            { appearanceId: "p1", id: "f1", mediaId: "m1" },
            { appearanceId: "p1", id: "f2", mediaId: "m1" },
        ],
        facesOnItem: (_mediaId: string, faceIds: string[]) => faceIds,
        confirmPerson: (...args: unknown[]) => state.calls.push(["confirm", ...args]),
        scatterPeople: (...args: unknown[]) => {
            state.calls.push(["scatter", ...args]);
            return 2;
        },
        setAsidePeople: (...args: unknown[]) => {
            state.calls.push(["later", ...args]);
            return 2;
        },
    },
    jobRepo: { enqueueKind: () => undefined },
    searchRepo: { requestReindex: () => undefined },
    tagBatchRepo: {
        applyAssignments: (input: { assignments: unknown[] }) => {
            state.calls.push(["tag", input.assignments]);
            return { batchId: "b1", assigned: input.assignments.length };
        },
    },
    tagRepo: {
        ensureTag: () => "new",
        resolveName: () => undefined,
        findById: (id: string) => ({ id, kind: "performer", name: "New One", ownerId: null }),
    },
}));

vi.mock("./ocrMatchHooks", () => ({ vocabularyChanged: () => undefined }));

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

const { decideNewPeople, newPeople } = await import("./newPeopleService");

const admin: AuthContext = {
    userId: "u1",
    email: "u1@example.test",
    displayName: "U",
    scopes: ["admin"],
    accessibleRootIds: ["r1"],
    tokenEpoch: 0,
};

const people = [{ mediaId: "m1", faceIds: ["f1", "f2"], shownFaceId: "f1" }];

beforeEach(() => {
    state.decisions = [];
    state.calls = [];
});

describe("new people", () => {
    it("shows each gathering with its cards, every face of the person on each", () => {
        const page = newPeople({ page: 0, limit: 6 }, admin);

        expect(page.people).toEqual([
            expect.objectContaining({
                id: "np",
                items: 5,
                cards: [expect.objectContaining({ id: "p1", faceIds: ["f1", "f2"] })],
            }),
        ]);
        expect(() => newPeople({ page: 0, limit: 6 }, { ...admin, scopes: [] })).toThrow(
            /administrator/
        );
    });

    it("names them — tagging the items and confirming the faces — as one decision", () => {
        expect(decideNewPeople({ action: "name", name: "New One", people }, admin)).toEqual({
            changed: 1,
            name: "New One",
        });
        expect(state.decisions).toEqual([expect.objectContaining({ verdict: "is" })]);
        expect(state.calls.map((call) => call[0])).toEqual(["named", "confirm", "tag"]);
    });

    it("takes them out, or puts them off, and says when nothing is left to decide", () => {
        decideNewPeople({ action: "notOnePerson", people }, admin);
        decideNewPeople({ action: "later", people }, admin);

        expect(state.decisions.map((d) => d.verdict)).toEqual(["notOnePerson", "later"]);
        expect(() =>
            decideNewPeople(
                { action: "later", people: [{ ...people[0], mediaId: "hidden" }] },
                admin
            )
        ).toThrow(/any more/);
    });
});
