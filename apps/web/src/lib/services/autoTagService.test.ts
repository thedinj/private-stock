import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../auth/withAuth";

/**
 * "Would tag" (§5f "Tagging by itself"): a random order a visit keeps, and what Right and Wrong
 * write.
 */

const state = vi.hoisted(() => ({
    rows: [] as {
        mediaId: string;
        tagId: string;
        faceId: string | null;
        score: number;
        strongFaces: number;
        named: 1 | null;
        state: string;
    }[],
    decided: [] as string[][],
    refused: [] as unknown[][],
    confirmed: [] as unknown[][],
    assigned: [] as { mediaId: string; tagId: string }[],
    setting: {} as Record<string, unknown>,
    unassigned: [] as unknown[][],
    notThem: [] as unknown[][],
}));

vi.mock("@private-stock/db", () => ({
    db: { transaction: <T>(fn: () => T) => fn },
    faceAutoTagRepo: {
        inState: () => state.rows,
        counts: () => ({ proposed: state.rows.length, right: 3, wrong: 1, applied: 0, removed: 0 }),
        find: (mediaId: string, tagId: string) =>
            state.rows.find((row) => row.mediaId === mediaId && row.tagId === tagId),
        decide: (mediaId: string, tagId: string, verdict: string) =>
            state.decided.push([mediaId, tagId, verdict]),
    },
    faceRepo: {
        shownFaces: () => [],
        refuseMatchedOnItem: (...args: unknown[]) => state.refused.push(args),
        confirmFace: (...args: unknown[]) => state.confirmed.push(args),
    },
    jobRepo: { enqueueKind: () => undefined },
    settingRepo: {
        get: () => state.setting,
        set: (_key: string, value: Record<string, unknown>) => {
            state.setting = value;
        },
    },
    searchRepo: { requestReindex: () => undefined },
    tagRepo: {
        findById: (id: string) => ({ id, name: "Jane" }),
        unassign: (...args: unknown[]) => {
            state.unassigned.push(args);
            return 1;
        },
    },
    tagBatchRepo: {
        applyAssignments: (input: { assignments: { mediaId: string; tagId: string }[] }) => {
            state.assigned.push(...input.assignments);
            return { batchId: "b", assigned: input.assignments.length };
        },
    },
}));

vi.mock("./mediaService", () => ({
    lookupMedia: (ids: string[]) => ({ items: ids.map((id) => ({ id, title: id })) }),
}));

vi.mock("./faceService", () => ({ faceCrop: () => null }));

vi.mock("./notThem", () => ({
    notThem: (...args: unknown[]) => state.notThem.push(args),
}));

const { autoTagList, decideAutoTag, switchAutoTag } = await import("./autoTagService");

const admin: AuthContext = {
    userId: "u1",
    email: "u1@example.test",
    displayName: "U",
    scopes: ["admin"],
    accessibleRootIds: ["r1"],
    tokenEpoch: 0,
};

const row = (mediaId: string) => ({
    mediaId,
    tagId: "jane",
    faceId: `${mediaId}-f`,
    score: 0.7,
    strongFaces: 2,
    named: null,
    state: "proposed",
});

beforeEach(() => {
    state.rows = Array.from({ length: 30 }, (_, i) => row(`m${i}`));
    state.decided = [];
    state.refused = [];
    state.confirmed = [];
    state.assigned = [];
    state.setting = {};
    state.unassigned = [];
    state.notThem = [];
});

describe("would tag", () => {
    it("shuffles by the visit's seed, the same each page, and says the tally", () => {
        const query = { state: "proposed" as const, page: 0, limit: 10 };
        const order = (seed: number) =>
            [0, 1, 2].flatMap((page) =>
                autoTagList({ ...query, seed, page }, admin).rows.map((r) => r.item.id)
            );

        expect(order(7)).toEqual(order(7));
        expect(new Set(order(7)).size).toBe(30);
        expect(order(7)).not.toEqual(order(8));
        expect(autoTagList({ ...query, seed: 7 }, admin).counts).toMatchObject({
            right: 3,
            wrong: 1,
        });
    });

    it("tags and confirms the face on Right; refuses on Wrong; only for administrators", () => {
        expect(decideAutoTag({ mediaId: "m1", tagId: "jane", verdict: "right" }, admin)).toEqual({
            tagged: 1,
        });
        expect(state.assigned).toEqual([{ mediaId: "m1", tagId: "jane" }]);
        expect(state.confirmed).toEqual([["m1-f", "jane", "u1"]]);

        decideAutoTag({ mediaId: "m2", tagId: "jane", verdict: "wrong" }, admin);

        expect(state.refused).toEqual([["m2", "jane", "m2-f", "u1"]]);
        expect(state.decided.map((d) => d[2])).toEqual(["right", "wrong"]);
        expect(() =>
            decideAutoTag(
                { mediaId: "m3", tagId: "jane", verdict: "right" },
                { ...admin, scopes: [] }
            )
        ).toThrow(/administrator/);
        expect(() =>
            decideAutoTag({ mediaId: "gone", tagId: "jane", verdict: "right" }, admin)
        ).toThrow(/no longer there/);
    });

    it("is switched on by an administrator, who is remembered", () => {
        switchAutoTag({ enabled: true }, admin);

        expect(state.setting).toMatchObject({ enabled: true, byUserId: "u1" });
        expect(autoTagList({ state: "proposed", seed: 1, page: 0, limit: 5 }, admin)).toMatchObject(
            {
                enabled: true,
                braked: false,
            }
        );
        expect(() => switchAutoTag({ enabled: false }, { ...admin, scopes: [] })).toThrow(
            /administrator/
        );
    });

    it("takes back a tag faces made, as an untag by hand would", () => {
        state.rows = [{ ...row("m1"), state: "applied" }];

        decideAutoTag({ mediaId: "m1", tagId: "jane", verdict: "wrong" }, admin);

        expect(state.unassigned).toEqual([["m1", "jane", null]]);
        expect(state.notThem).toEqual([[["m1"], "jane", "u1"]]);
        expect(state.assigned).toEqual([]);
    });
});
