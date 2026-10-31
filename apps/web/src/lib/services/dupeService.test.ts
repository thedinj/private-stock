import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthorizationError, ValidationError } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * Resolving groups from the triage sheet (§10c).
 *
 * The comparison itself is pure and tested in `@private-stock/core`; trashing one item is
 * tested where it lives. What is left here is what resolving a page of groups adds, and every
 * one of them is a way to lose the wrong file: deleting the copy that was supposed to stay,
 * deleting a copy nobody was shown, stopping at the first refusal, and taking a group out of
 * the queue while it still holds a copy somebody could remove.
 */

interface MemberRow {
    id: string;
    relPath: string;
    writable: number | null;
}

let groups: Record<string, MemberRow[]> = {};
let trashed: string[] = [];
let refuse: Record<string, Error> = {};
let reviewed: string[] = [];
/** Clips per copy, for the identical plan. */
let clips: Record<string, number> = {};

vi.mock("@private-stock/db", () => ({
    db: {
        prepare: () => ({
            all: (groupId: string) =>
                (groups[groupId] ?? []).filter((row) => !trashed.includes(row.id)),
        }),
    },
    dupeRepo: {
        findGroup: (groupId: string) => (groups[groupId] ? { id: groupId } : undefined),
        markReviewed: (groupId: string) => reviewed.push(groupId),
        // Every group here is identical: one hash per group, in group-id order like the query.
        pendingIdenticalCopies: () =>
            Object.keys(groups)
                .sort()
                .filter((groupId) => !reviewed.includes(groupId))
                .flatMap((groupId) =>
                    (groups[groupId] ?? [])
                        .filter((row) => !trashed.includes(row.id))
                        .map((row) => ({
                            groupId,
                            mediaId: row.id,
                            width: 1920,
                            height: 1080,
                            bitrate: 1,
                            sizeBytes: 100,
                            durationMs: 1,
                            addedAt: `2026-01-01T00:00:0${row.id.length % 10}Z`,
                            writable: row.writable,
                            contentHash: `h-${groupId}`,
                            clipCount: clips[row.id] ?? 0,
                        }))
                ),
    },
}));

vi.mock("./artService", () => ({ coverUrl: () => null }));
vi.mock("./keepAdvice", () => ({ costOfKeeping: () => null, keepReason: () => null }));

vi.mock("./trashService", () => ({
    trashMedia: async (mediaId: string) => {
        const error = refuse[mediaId];

        if (error) throw error;

        trashed.push(mediaId);

        return { entryId: `t-${mediaId}`, queued: true, merged: null };
    },
}));

const { resolveGroups, switchIdenticalNightly, trashIdentical } = await import("./dupeService");

const auth = (scopes: AuthContext["scopes"]): AuthContext => ({
    userId: "u1",
    email: "a@b.c",
    displayName: "Admin",
    scopes,
    accessibleRootIds: ["r1"],
    tokenEpoch: 1,
});

const admin = auth(["admin", "delete"]);

const copy = (id: string, writable: number | null = 1): MemberRow => ({
    id,
    relPath: `${id}.mp4`,
    writable,
});

beforeEach(() => {
    groups = {
        g1: [copy("best"), copy("worse"), copy("worst")],
        g2: [copy("keep2"), copy("drop2")],
    };
    trashed = [];
    refuse = {};
    reviewed = [];
    clips = {};
});

describe("resolving a page of duplicate groups", () => {
    it("trashes the named copies of every group and marks each reviewed", async () => {
        const result = await resolveGroups(
            [
                { groupId: "g1", keepId: "best", trashIds: ["worse", "worst"] },
                { groupId: "g2", keepId: "keep2", trashIds: ["drop2"] },
            ],
            admin
        );

        expect(trashed).toEqual(["worse", "worst", "drop2"]);
        expect(result.groups.map((group) => group.trashed)).toEqual([2, 1]);
        expect(reviewed).toEqual(["g1", "g2"]);
    });

    it("keeps the copy the reviewer chose, not the one the app recommended", async () => {
        await resolveGroups(
            [{ groupId: "g1", keepId: "worst", trashIds: ["best", "worse"] }],
            admin
        );

        expect(trashed).toEqual(["best", "worse"]);
    });

    it("never touches a copy that joined the group after the page loaded", async () => {
        // A clustering pass merged "newcomer" in; the reviewer never saw it.
        groups.g2 = [copy("keep2"), copy("drop2"), copy("newcomer")];

        const result = await resolveGroups(
            [{ groupId: "g2", keepId: "keep2", trashIds: ["drop2"] }],
            admin
        );

        expect(trashed).toEqual(["drop2"]);
        // Still a decision to make, so it stays in the queue.
        expect(result.groups[0]?.reviewed).toBe(false);
        expect(reviewed).toEqual([]);
    });

    it("refuses a group whose keeper has gone, and still resolves the others", async () => {
        groups.g1 = [copy("worse"), copy("worst")];

        const result = await resolveGroups(
            [
                { groupId: "g1", keepId: "best", trashIds: ["worse", "worst"] },
                { groupId: "g2", keepId: "keep2", trashIds: ["drop2"] },
            ],
            admin
        );

        expect(trashed).toEqual(["drop2"]);
        expect(result.groups[0]?.refused).toMatch(/no longer one of this group's copies/);
        expect(result.groups[1]?.refused).toBeNull();
    });

    it("refuses a group that no longer exists without failing the request", async () => {
        const result = await resolveGroups(
            [{ groupId: "gone", keepId: "a", trashIds: ["b"] }],
            admin
        );

        expect(result.groups[0]?.refused).toBe("This group no longer exists");
    });

    it("reports a named copy that is no longer in the group rather than dropping it", async () => {
        const result = await resolveGroups(
            [{ groupId: "g1", keepId: "best", trashIds: ["worse", "elsewhere"] }],
            admin
        );

        expect(trashed).toEqual(["worse"]);
        expect(result.groups[0]?.failed).toEqual([
            { mediaId: "elsewhere", reason: "No longer one of this group's copies" },
        ]);
    });

    it("refuses the whole request when a keeper is also listed to trash", async () => {
        // A client bug, and the one that would empty a group. Nothing moves.
        await expect(
            resolveGroups(
                [
                    { groupId: "g2", keepId: "keep2", trashIds: ["drop2"] },
                    { groupId: "g1", keepId: "best", trashIds: ["best", "worse"] },
                ],
                admin
            )
        ).rejects.toThrow(ValidationError);
        expect(trashed).toEqual([]);
    });

    it("needs the delete scope as well as admin, and says so before touching anything", async () => {
        const items = [{ groupId: "g1", keepId: "best", trashIds: ["worse"] }];

        await expect(resolveGroups(items, auth(["admin"]))).rejects.toThrow(AuthorizationError);
        await expect(resolveGroups(items, auth(["delete"]))).rejects.toThrow(AuthorizationError);
        expect(trashed).toEqual([]);
    });

    it("deletes what it can when one copy refuses, and names the one that did not", async () => {
        refuse = { worse: new Error("Not enough free space on the data volume") };

        const result = await resolveGroups(
            [{ groupId: "g1", keepId: "best", trashIds: ["worse", "worst"] }],
            admin
        );

        expect(trashed).toEqual(["worst"]);
        expect(result.groups[0]).toMatchObject({
            trashed: 1,
            reviewed: false,
            failed: [{ mediaId: "worse", reason: "Not enough free space on the data volume" }],
        });
        expect(reviewed).toEqual([]);
    });

    it("marks a group reviewed when all that is left is on a read-only root", async () => {
        // Nothing could ever remove the read-only copy, so no decision is outstanding.
        groups.g1 = [copy("best"), copy("worse"), copy("stuck", null)];

        const result = await resolveGroups(
            [{ groupId: "g1", keepId: "best", trashIds: ["worse"] }],
            admin
        );

        expect(result.groups[0]?.reviewed).toBe(true);
        expect(reviewed).toEqual(["g1"]);
    });

    it("does not leak a thrown non-message as the reason", async () => {
        refuse = { worse: new Error("") };

        const result = await resolveGroups(
            [{ groupId: "g1", keepId: "best", trashIds: ["worse"] }],
            admin
        );

        expect(result.groups[0]?.failed[0]?.reason).toBe("Could not be deleted");
    });
});

describe("trashing every identical copy (§10e)", () => {
    beforeEach(() => {
        // Ids of different lengths so "catalogued first" is decided: the shortest was added first.
        groups = {
            g1: [copy("a1"), copy("a22")],
            g2: [copy("b1"), copy("b22"), copy("b333")],
            g3: [copy("c1"), copy("c22")],
        };
    });

    it("keeps the copy catalogued first in every group and trashes the rest", async () => {
        const result = await trashIdentical({ after: null, limit: 100 }, admin);

        expect(trashed).toEqual(["a22", "b22", "b333", "c22"]);
        expect(result).toMatchObject({ groups: 3, trashed: 4, cursor: null, remaining: 0 });
        expect(reviewed).toEqual(["g1", "g2", "g3"]);
    });

    it("works in batches, each picking up where the last stopped", async () => {
        const first = await trashIdentical({ after: null, limit: 2 }, admin);

        expect(first).toMatchObject({ groups: 2, cursor: "g2", remaining: 1 });
        expect(trashed).toEqual(["a22", "b22", "b333"]);

        const second = await trashIdentical({ after: first.cursor, limit: 2 }, admin);

        expect(second).toMatchObject({ groups: 1, cursor: null, remaining: 0 });
        expect(trashed).toEqual(["a22", "b22", "b333", "c22"]);
    });

    it("keeps a read-only copy, so the writable one can go", async () => {
        groups = { g1: [copy("a1"), copy("a22", null)] };

        await trashIdentical({ after: null, limit: 100 }, admin);

        expect(trashed).toEqual(["a1"]);
    });

    it("leaves a group whose doomed copy has clips for a person", async () => {
        clips = { a22: 1 };

        await trashIdentical({ after: null, limit: 100 }, admin);

        expect(trashed).not.toContain("a22");
        expect(reviewed).not.toContain("g1");
    });

    it("does not retry a group that refused within the same run", async () => {
        refuse = { a22: new Error("Not enough free space") };

        const result = await trashIdentical({ after: null, limit: 1 }, admin);

        expect(result.failed).toEqual([{ mediaId: "a22", reason: "Not enough free space" }]);
        expect(result.cursor).toBe("g1");

        await trashIdentical({ after: result.cursor, limit: 100 }, admin);

        expect(trashed).toEqual(["b22", "b333", "c22"]);
    });

    it("needs the delete scope as well as admin, before touching anything", async () => {
        await expect(
            trashIdentical({ after: null, limit: 100 }, auth(["admin"]))
        ).rejects.toBeInstanceOf(AuthorizationError);
        expect(trashed).toEqual([]);
    });
});

describe('switching on the nightly clear (§10e "Every night")', () => {
    it("needs the delete scope, since the deletions are recorded against whoever switches it", () => {
        expect(() => switchIdenticalNightly({ enabled: true }, auth(["admin"]))).toThrow(
            AuthorizationError
        );
    });
});
