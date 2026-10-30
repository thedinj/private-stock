import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReadOnlyRootError } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * Acting on a set somebody ticked (§14b).
 *
 * Three claims, each of which fails quietly rather than loudly.
 *
 * Partial success is the normal outcome: a selection spans a writable root and a read-only
 * one, and an action that refuses the whole set because one item could not be deleted is
 * useless on exactly the mixed libraries it is for. So the interesting assertions are about
 * what the *failures* say, not only about the successes.
 *
 * An item the viewer cannot see must be indistinguishable from one that does not exist —
 * otherwise a bulk request is a way to probe which ids are real in a library you were never
 * granted, sixty at a time.
 *
 * And tagging writes to whichever vocabulary the actor owns (§6). Bulk is where getting that
 * wrong is worst: it is the difference between annotating your own library view and
 * rewriting what everybody sees, across hundreds of items, in one click.
 */

interface Row {
    id: string;
    rootId: string;
}

let rows: Row[] = [];
let assignments: { mediaId: string; tagId: string; userId: string | null }[] = [];
let ratings: { userId: string; mediaId: string; rating: number | null }[] = [];
let favorites: { userId: string; mediaId: string; favorite: boolean }[] = [];
let trashed: string[] = [];
let readOnly: Set<string> = new Set();
/** Tag ids the fixture admits exist, for `findById`. */
let known: Set<string> = new Set();
let reindexed: string[] = [];
let logged: string[] = [];
/** Names passed through `ensureTag`, so an untag that coins one is visible. */
let coined: string[] = [];

vi.mock("@private-stock/db", () => ({
    db: { transaction: (fn: () => unknown) => () => fn() },
    mediaRepo: {
        listByIds: (ids: string[]) => rows.filter((row) => ids.includes(row.id)),
    },
    tagRepo: {
        ensureTag: (kind: string, name: string, ownerId: string | null = null) => {
            coined.push(name);

            return `${kind}:${name}:${ownerId ?? "library"}`;
        },
        resolveName: () => undefined,
        /**
         * The ids this fixture makes are `kind:name:owner`, so a lookup can read one back
         * without a second table -- and an id naming a tag nothing ever created resolves to
         * nothing, which is the case the untag branch has to survive.
         */
        findById: (tagId: string) => {
            const [kind, name, owner] = tagId.split(":");

            if (!kind || !name || !owner || !known.has(tagId)) return undefined;

            return { id: tagId, kind, name, ownerId: owner === "library" ? null : owner };
        },
        resolveForUser: () => undefined,
        assign: (input: { mediaId: string; tagId: string; userId?: string | null }) => {
            assignments.push({
                mediaId: input.mediaId,
                tagId: input.tagId,
                userId: input.userId ?? null,
            });
        },
        unassign: (mediaId: string, tagId: string, userId: string | null) => {
            const before = assignments.length;

            assignments = assignments.filter(
                (row) => !(row.mediaId === mediaId && row.tagId === tagId && row.userId === userId)
            );

            return before - assignments.length;
        },
    },
    userMediaRepo: {
        setRating: (userId: string, mediaId: string, rating: number | null) => {
            ratings.push({ userId, mediaId, rating });
        },
        setFavorite: (userId: string, mediaId: string, favorite: boolean) => {
            favorites.push({ userId, mediaId, favorite });
        },
    },
    searchRepo: {
        requestReindex: (ids: string[]) => {
            reindexed.push(...ids);
        },
    },
    changeLogRepo: {
        record: (input: { entityId: string }) => {
            logged.push(input.entityId);
        },
    },
}));

vi.mock("./ocrMatchHooks", () => ({ vocabularyChanged: () => undefined }));

vi.mock("./trashService", () => ({
    trashMedia: (mediaId: string) => {
        if (readOnly.has(mediaId)) {
            return Promise.reject(
                new ReadOnlyRootError("This item is in a read-only root and cannot be deleted")
            );
        }

        trashed.push(mediaId);

        return Promise.resolve({ ok: true });
    },
}));

const { applyBulkAction } = await import("./bulkActionService");

const ADMIN = {
    userId: "admin",
    accessibleRootIds: ["root"],
    scopes: ["admin", "delete"],
} as unknown as AuthContext;

const ANNA = {
    userId: "anna",
    accessibleRootIds: ["root"],
    scopes: ["delete"],
} as unknown as AuthContext;

beforeEach(() => {
    rows = [
        { id: "m1", rootId: "root" },
        { id: "m2", rootId: "root" },
        { id: "m3", rootId: "root" },
    ];
    assignments = [];
    ratings = [];
    favorites = [];
    trashed = [];
    readOnly = new Set();
    reindexed = [];
    logged = [];
    coined = [];
    known = new Set(["genre:Noir:library", "genre:Noir:anna", "tag:Mine:anna"]);
});

describe("what the viewer may touch", () => {
    it("reports an item outside their libraries as missing, and does not act on it", async () => {
        const result = await applyBulkAction(
            { action: "favorite", mediaIds: ["m1", "elsewhere"], favorite: true },
            ANNA
        );

        // Not silently skipped, and not distinguished from an id that does not exist: both
        // answers would confirm that an id is real in a library this account cannot open.
        expect(result.succeeded).toBe(1);
        expect(result.failed).toEqual([{ mediaId: "elsewhere", reason: "Media not found" }]);
        expect(favorites.map((row) => row.mediaId)).toEqual(["m1"]);
    });
});

describe("tagging a selection", () => {
    /**
     * Bulk is where scope matters most: one click is the difference between annotating your
     * own view of the library and rewriting what everybody sees. It used to follow the role,
     * so nobody but an administrator could do the second and an administrator could never do
     * the first. The request decides now, for everyone (§6).
     */
    it("writes whichever system the request names, whoever is asking", async () => {
        await applyBulkAction(
            {
                action: "tag",
                mediaIds: ["m1"],
                kind: "genre",
                names: ["Noir"],
                scope: "public",
            },
            ANNA
        );
        await applyBulkAction(
            {
                action: "tag",
                mediaIds: ["m2"],
                kind: "genre",
                names: ["Noir"],
                scope: "private",
            },
            ADMIN
        );

        expect(assignments).toEqual([
            { mediaId: "m1", tagId: "genre:Noir:library", userId: null },
            { mediaId: "m2", tagId: "genre:Noir:admin", userId: "admin" },
        ]);
    });

    it("tells the search index about the items it touched", async () => {
        await applyBulkAction(
            {
                action: "tag",
                mediaIds: ["m1", "m2"],
                kind: "genre",
                names: ["Noir"],
                scope: "public",
            },
            ADMIN
        );

        expect(reindexed).toEqual(["m1", "m2"]);
        expect(logged).toEqual(["m1", "m2"]);
    });
});

describe("untagging a selection", () => {
    it("never coins a tag", async () => {
        // The bug this shape replaced: names were resolved through `ensureTag` before the
        // mode was consulted, so untagging something the library had never heard of created
        // it and then removed nothing. Taking ids makes that unsayable.
        await applyBulkAction(
            { action: "untag", mediaIds: ["m1"], tagIds: ["genre:Typo:library"] },
            ADMIN
        );

        expect(coined).toEqual([]);
        expect(assignments).toEqual([]);
    });

    it("removes only within the tag's own system", async () => {
        assignments = [
            { mediaId: "m1", tagId: "genre:Noir:library", userId: null },
            { mediaId: "m1", tagId: "genre:Noir:anna", userId: "anna" },
        ];

        await applyBulkAction(
            { action: "untag", mediaIds: ["m1"], tagIds: ["genre:Noir:library"] },
            ADMIN
        );

        // The public tag goes and Anna's private one stays: nobody else can see it, and she
        // would never know to expect to lose it.
        expect(assignments).toEqual([{ mediaId: "m1", tagId: "genre:Noir:anna", userId: "anna" }]);
    });

    it("skips another account's private tag", async () => {
        assignments = [{ mediaId: "m1", tagId: "tag:Mine:anna", userId: "anna" }];

        // An administrator curates the library, which is not the same as reaching into
        // somebody's own vocabulary (§6). It is not in the listing this id could come from,
        // so it is not found rather than refused.
        await applyBulkAction(
            { action: "untag", mediaIds: ["m1"], tagIds: ["tag:Mine:anna"] },
            ADMIN
        );

        expect(assignments).toEqual([{ mediaId: "m1", tagId: "tag:Mine:anna", userId: "anna" }]);
    });

    it("counts items rather than assignments", async () => {
        assignments = [
            { mediaId: "m1", tagId: "genre:Noir:library", userId: null },
            { mediaId: "m1", tagId: "tag:Mine:anna", userId: "anna" },
        ];
        known.add("tag:Mine:anna");

        const result = await applyBulkAction(
            {
                action: "untag",
                mediaIds: ["m1", "m2"],
                tagIds: ["genre:Noir:library", "tag:Mine:anna"],
            },
            ANNA
        );

        // One item lost two tags, and m2 carried neither. "2 items updated" would be a lie
        // told to somebody about to wonder why half the grid looks the same.
        expect(result.succeeded).toBe(1);
        expect(logged).toEqual(["m1"]);
    });

    it("tells the search index about every item it was asked about", async () => {
        assignments = [{ mediaId: "m1", tagId: "genre:Noir:library", userId: null }];

        await applyBulkAction(
            { action: "untag", mediaIds: ["m1", "m2"], tagIds: ["genre:Noir:library"] },
            ADMIN
        );

        expect(reindexed).toEqual(["m1", "m2"]);
    });
});

describe("moving a selection to the bin", () => {
    it("does what it can and names what it could not", async () => {
        readOnly = new Set(["m2"]);

        const result = await applyBulkAction(
            { action: "trash", mediaIds: ["m1", "m2", "m3"] },
            ANNA
        );

        // The interesting case is partial, and it is ordinary rather than exceptional: a
        // selection spans a writable library and a read-only one. Refusing all three would
        // make the feature useless on exactly the libraries it is for, and saying only "some
        // of this failed" leaves the person to find out which by inspection.
        expect(trashed).toEqual(["m1", "m3"]);
        expect(result.succeeded).toBe(2);
        expect(result.failed).toEqual([
            { mediaId: "m2", reason: "This item is in a read-only root and cannot be deleted" },
        ]);
    });

    it("carries on after a failure rather than stopping at it", async () => {
        readOnly = new Set(["m1"]);

        const result = await applyBulkAction(
            { action: "trash", mediaIds: ["m1", "m2", "m3"] },
            ANNA
        );

        // The first item failing must not abandon the rest. A loop that threw would delete
        // nothing and report one problem, which reads as "it refused" rather than "one of
        // these is on a read-only library".
        expect(trashed).toEqual(["m2", "m3"]);
        expect(result.succeeded).toBe(2);
    });
});

describe("rating and favouriting a selection", () => {
    it("clears a rating as well as setting one", async () => {
        await applyBulkAction({ action: "rate", mediaIds: ["m1", "m2"], rating: null }, ANNA);

        // `null` is the only way back to unrated, and a star control can never express it --
        // which is why the bar carries a separate clear.
        expect(ratings).toEqual([
            { userId: "anna", mediaId: "m1", rating: null },
            { userId: "anna", mediaId: "m2", rating: null },
        ]);
    });

    it("never announces one viewer's private state to everybody else", async () => {
        await applyBulkAction({ action: "favorite", mediaIds: ["m1"], favorite: true }, ANNA);

        // No ChangeLog row: broadcasting this would push Anna's favourite into every other
        // account's open grid, which is not merely useless to them but wrong (§13b).
        expect(logged).toEqual([]);
    });
});
