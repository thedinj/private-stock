import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../auth/withAuth";

/**
 * A performer's Faces tab (§5f "Their faces"): how its sections are made, and what taking back,
 * picking and restoring write.
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
    },
    faceRepo: { noSingleFace: () => undefined },
    appearanceRepo: {
        confirmedPeople: () => ({
            rows: [{ mediaId: "m1", kind: "video", title: "One", bestFaceId: "f2", moments: 3 }],
            total: 1,
        }),
        refusedPeople: () => ({ rows: [], total: 0 }),
        performerFacesOn: () => [
            { id: "f1", mediaId: "m1" },
            { id: "f2", mediaId: "m1" },
            { id: "f3", mediaId: "m1" },
        ],
        unconfirmedItems: () => ({ mediaIds: ["m2"], total: 1 }),
        peopleOn: () => [
            { id: "p1", mediaId: "m2", kind: "video", title: "Two", bestFaceId: "g1", moments: 2 },
            { id: "p2", mediaId: "m2", kind: "video", title: "Two", bestFaceId: "h1", moments: 2 },
        ],
        appearanceFaces: () => [
            { appearanceId: "p1", id: "g1", mediaId: "m2" },
            { appearanceId: "p1", id: "g2", mediaId: "m2" },
            { appearanceId: "p2", id: "h1", mediaId: "m2" },
            { appearanceId: "p2", id: "h2", mediaId: "m2" },
        ],
        facesOnItem: (_mediaId: string, faceIds: string[]) => faceIds,
        confirmPerson: (...args: unknown[]) => state.calls.push(["confirm", ...args]),
        takeBackPerson: (...args: unknown[]) => state.calls.push(["takeBack", ...args]),
        restorePerson: (...args: unknown[]) => state.calls.push(["restore", ...args]),
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
    lookupMedia: (ids: string[]) => ({ items: ids.map((id) => ({ id })) }),
}));

const { decidePerformerPeople, performerPeople } = await import("./performerFacesService");

const admin: AuthContext = {
    userId: "u1",
    email: "u1@example.test",
    displayName: "U",
    scopes: ["admin"],
    accessibleRootIds: ["r1"],
    tokenEpoch: 0,
};

beforeEach(() => {
    state.decisions = [];
    state.calls = [];
});

describe("the sections", () => {
    it("shows a confirmed person by their clearest face, with every face of theirs on the item", () => {
        const page = performerPeople(
            "jane",
            { section: "confirmed", all: false, page: 0, limit: 24 },
            admin
        );
        const [card] = page.groups[0].people;

        expect(card.face.id).toBe("f2");
        expect(card.faceIds).toEqual(["f1", "f2", "f3"]);
        expect(card.others.map((face) => face.id)).toEqual(["f1", "f3"]);
    });

    it("shows each of their items with its people, to pick the one who is them", () => {
        const page = performerPeople(
            "jane",
            { section: "items", all: false, page: 0, limit: 24 },
            admin
        );

        expect(page.groups).toEqual([
            expect.objectContaining({
                mediaId: "m2",
                people: [
                    expect.objectContaining({ id: "p1", faceIds: ["g1", "g2"] }),
                    expect.objectContaining({ id: "p2", faceIds: ["h1", "h2"] }),
                ],
            }),
        ]);
    });
});

describe("saying it", () => {
    const people = [{ mediaId: "m1", faceIds: ["f1", "f2"], shownFaceId: "f2" }];

    it("takes back and picks as one decision each, and restores without one", () => {
        decidePerformerPeople("jane", { action: "takeBack", people }, admin);
        decidePerformerPeople("jane", { action: "pick", people }, admin);
        decidePerformerPeople("jane", { action: "restore", people }, admin);

        expect(state.decisions.map((d) => d.verdict)).toEqual(["isNot", "is"]);
        expect(state.calls.map((call) => call[0])).toEqual(["takeBack", "confirm", "restore"]);
    });

    it("is for administrators, and library performers", () => {
        expect(() =>
            decidePerformerPeople("jane", { action: "pick", people }, { ...admin, scopes: [] })
        ).toThrow(/administrator/);
        expect(() => decidePerformerPeople("nobody", { action: "pick", people }, admin)).toThrow(
            /not found/
        );
    });
});
