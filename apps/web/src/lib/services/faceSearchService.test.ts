import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../auth/withAuth";

/**
 * Who is this?, named (§5f "Who is this?"): what one save writes — the video asked from always
 * tagged and its person confirmed when the search found them there, the candidates said to be them
 * tagged and confirmed, those said not to be refused — as one decision.
 */

const state = vi.hoisted(() => ({
    decisions: [] as Record<string, unknown>[],
    calls: [] as unknown[][],
    self: { vectorIndex: 0, score: 0.6 } as { vectorIndex: number; score: number } | null,
    performers: [] as { tagId: string; score: number }[],
    ownTag: null as string | null,
}));

const NAMES: Record<string, string> = { jane: "Jane", ann: "Ann", coined: "Jane Doe" };

vi.mock("@private-stock/db", () => ({
    db: { transaction: <T>(fn: () => T) => fn },
    faceDecisionRepo: {
        record: (decision: Record<string, unknown>, write: () => unknown) => {
            state.decisions.push(decision);
            return { decisionId: "d1", result: write() };
        },
        nameActive: (tagId: string) => state.calls.push(["named", tagId]),
    },
    faceSearchRepo: {
        find: (id: string) =>
            id === "s1"
                ? {
                      id: "s1",
                      mediaId: "src",
                      atMs: 1000,
                      state: "done",
                      error: null,
                      resultJson: JSON.stringify([
                          {
                              x: 0.1,
                              y: 0.1,
                              w: 0.2,
                              h: 0.3,
                              self: state.self,
                              performers: state.performers,
                              matches: [],
                          },
                      ]),
                  }
                : undefined,
        requeueIfStranded: () => undefined,
    },
    faceRepo: {
        shownFacesAt: (at: { mediaId: string; vectorIndex: number }[]) =>
            at.map((face) => ({
                ...face,
                id: "own",
                kind: "video",
                appearanceId: "ownPerson",
                tagId: state.ownTag,
            })),
    },
    appearanceRepo: {
        appearanceFaces: () => [
            { appearanceId: "ownPerson", id: "own" },
            { appearanceId: "ownPerson", id: "own2" },
        ],
        facesOnItem: (_mediaId: string, faceIds: string[]) => faceIds,
        confirmPerson: (...args: unknown[]) => state.calls.push(["confirm", ...args]),
        refusePerson: (...args: unknown[]) => state.calls.push(["refuse", ...args]),
    },
    searchRepo: { requestReindex: () => undefined },
    tagBatchRepo: {
        applyAssignments: (input: { assignments: unknown[]; summary: string }) => {
            state.calls.push(["tag", input.assignments, input.summary]);
            return { batchId: "b1", assigned: input.assignments.length };
        },
    },
    tagRepo: {
        ensureTag: () => "coined",
        findById: (id: string) =>
            NAMES[id] ? { id, kind: "performer", name: NAMES[id], ownerId: null } : undefined,
        listForMediaIds: () => [],
    },
}));

vi.mock("./faceService", () => ({
    confirmationsChanged: () => undefined,
    reviewFace: () => [],
}));

vi.mock("./mediaService", () => ({
    lookupMedia: (ids: string[]) => ({
        items: ids.filter((id) => id !== "hidden").map((id) => ({ id, kind: "video", title: id })),
    }),
}));

const { faceSearchMatches, nameFromSearch } = await import("./faceSearchService");

const admin: AuthContext = {
    userId: "u1",
    email: "u1@example.test",
    displayName: "U",
    scopes: ["admin"],
    accessibleRootIds: ["r1"],
    tokenEpoch: 0,
};

const person = (mediaId: string, verdict: "is" | "isNot") => ({
    mediaId,
    faceIds: [`${mediaId}-a`, `${mediaId}-b`],
    shownFaceId: `${mediaId}-a`,
    verdict,
});

beforeEach(() => {
    state.decisions = [];
    state.calls = [];
    state.self = { vectorIndex: 0, score: 0.6 };
    state.performers = [];
    state.ownTag = null;
});

describe("naming the face on the frame", () => {
    it("tags the video asked from and those said to be them as one batch, as one decision", () => {
        const result = nameFromSearch(
            "s1",
            0,
            {
                performer: { by: "id", tagId: "jane" },
                people: [person("m1", "is"), person("m2", "isNot")],
            },
            admin
        );

        expect(state.decisions).toEqual([
            expect.objectContaining({ verdict: "is", tagId: "jane", surface: "search" }),
        ]);
        expect(state.calls.filter((call) => call[0] === "tag")).toEqual([
            [
                "tag",
                [
                    { mediaId: "src", tagId: "jane" },
                    { mediaId: "m1", tagId: "jane" },
                ],
                "Jane on 2 items, from Who is this?",
            ],
        ]);
        expect(result).toMatchObject({ tagId: "jane", name: "Jane", tagged: 2, refused: 1 });
    });

    it("confirms the person on the frame in the video asked from, and those said to be them", () => {
        nameFromSearch(
            "s1",
            0,
            { performer: { by: "id", tagId: "jane" }, people: [person("m1", "is")] },
            admin
        );

        expect(state.calls.filter((call) => call[0] === "confirm")).toEqual([
            ["confirm", ["own", "own2"], "own", "jane", "u1"],
            ["confirm", ["m1-a", "m1-b"], "m1-a", "jane", "u1"],
        ]);
    });

    it("refuses those said not to be them for the performer, and does not tag their items", () => {
        nameFromSearch(
            "s1",
            0,
            { performer: { by: "id", tagId: "jane" }, people: [person("m2", "isNot")] },
            admin
        );

        expect(state.calls.filter((call) => call[0] === "refuse")).toEqual([
            ["refuse", ["m2-a", "m2-b"], "m2-a", "jane", "u1"],
        ]);
        expect(state.calls.find((call) => call[0] === "tag")?.[1]).toEqual([
            { mediaId: "src", tagId: "jane" },
        ]);
    });

    it("tags the video asked from without confirming anyone when its person was not found", () => {
        state.self = null;

        nameFromSearch("s1", 0, { performer: { by: "id", tagId: "jane" }, people: [] }, admin);

        expect(state.calls.some((call) => call[0] === "confirm")).toBe(false);
        expect(state.calls.find((call) => call[0] === "tag")?.[1]).toEqual([
            { mediaId: "src", tagId: "jane" },
        ]);
    });

    it("leaves out candidates the asker cannot see, and the video asked from said again", () => {
        nameFromSearch(
            "s1",
            0,
            {
                performer: { by: "id", tagId: "jane" },
                people: [person("hidden", "is"), person("src", "isNot")],
            },
            admin
        );

        expect(state.calls.filter((call) => call[0] === "refuse")).toEqual([]);
        expect(state.calls.find((call) => call[0] === "tag")?.[1]).toEqual([
            { mediaId: "src", tagId: "jane" },
        ]);
    });

    it("coins a performer from a name typed, and refuses a name with nothing in it", () => {
        nameFromSearch("s1", 0, { performer: { by: "name", name: "Jane Doe" }, people: [] }, admin);

        expect(state.calls).toContainEqual(["named", "coined"]);
        expect(() =>
            nameFromSearch("s1", 0, { performer: { by: "name", name: "!!" }, people: [] }, admin)
        ).toThrow(/letter or digit/);
    });

    it("offers who the face most likely is: confirmed in the video first, then by reference", () => {
        state.performers = [
            { tagId: "ann", score: 0.6 },
            { tagId: "jane", score: 0.5 },
            { tagId: "gone", score: 0.4 },
        ];
        state.ownTag = "jane";

        expect(faceSearchMatches("s1", 0, admin).likely).toEqual([
            { tagId: "jane", name: "Jane", score: 0.5, here: true },
            { tagId: "ann", name: "Ann", score: 0.6, here: false },
        ]);
    });

    it("is for administrators only", () => {
        expect(() =>
            nameFromSearch(
                "s1",
                0,
                { performer: { by: "id", tagId: "jane" }, people: [] },
                { ...admin, scopes: [] }
            )
        ).toThrow(/administrator/);
    });
});
