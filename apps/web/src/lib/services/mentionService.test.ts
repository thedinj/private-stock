import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../auth/withAuth";

/**
 * "Not them", from "Find untagged" (§5d): who may say it of which tag, and of which items.
 */

const state = vi.hoisted(() => ({ refused: [] as [string, string[]][] }));

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
                library: { id, ownerId: null },
                mine: { id, ownerId: "u1" },
                theirs: { id, ownerId: "u2" },
            })[id],
    },
    mentionRepo: {
        refuse: (tagId: string, mediaIds: string[]) => {
            state.refused.push([tagId, mediaIds]);
            return mediaIds.length;
        },
    },
}));

vi.mock("./mediaService", () => ({
    lookupMedia: (ids: string[]) => ({
        items: ids.filter((id) => id !== "hidden").map((id) => ({ id })),
    }),
}));

const { refuseMentions } = await import("./mentionService");

const viewer = (scopes: AuthContext["scopes"]): AuthContext => ({
    userId: "u1",
    email: "u1@example.test",
    displayName: "U",
    scopes,
    accessibleRootIds: ["r1"],
    tokenEpoch: 0,
});

beforeEach(() => {
    state.refused = [];
});

describe("refusing name matches", () => {
    it("lets an administrator refuse for the library's tags, on items they can see", () => {
        expect(refuseMentions("library", { mediaIds: ["a", "hidden"] }, viewer(["admin"]))).toEqual(
            { refused: 1 }
        );
        expect(state.refused).toEqual([["library", ["a"]]]);
    });

    it("lets an owner refuse for their own tag, and nobody for somebody else's", () => {
        expect(refuseMentions("mine", { mediaIds: ["a"] }, viewer([])).refused).toBe(1);
        expect(() => refuseMentions("library", { mediaIds: ["a"] }, viewer([]))).toThrow(
            /administrator/
        );
        expect(() => refuseMentions("theirs", { mediaIds: ["a"] }, viewer(["admin"]))).toThrow(
            /not found/i
        );
    });
});
