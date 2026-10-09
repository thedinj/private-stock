import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthorizationError, NotFoundError } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * Who may do what to a playlist (§6).
 *
 * The repo tests cover ordering; this file covers the only other thing playlists can get
 * wrong, which is authorization. Three claims, each of which fails silently if it is not
 * checked: sharing grants reading and never writing, `admin` is not a master key to other
 * people's collections, and a playlist you cannot see reads as missing rather than forbidden.
 */

interface PlaylistFixture {
    id: string;
    ownerId: string;
    visibility: "private" | "shared";
    /** The owner's pin — their own sidebar when private, the household default when shared. */
    pinned: 1 | null;
    name?: string;
}

let playlists: PlaylistFixture[] = [];
let writes: string[] = [];
/** Ids `listByIds` will admit — everything else is treated as invisible to the viewer. */
let visibleIds: string[] = [];
/** Of those, the ones whose cover art has been generated. */
let coveredIds: string[] = [];
/** How many times the media table was read, so batching is a fact rather than a hope. */
let mediaReads = 0;
/** What the frozen filter matches, already scoped to the viewer by `resolveSavedQuery`. */
let filterMatches: string[] = [];
/** Membership, in stored order. */
let storedIds: string[] = [];
/** Which listing path the repo was asked for, so the seed can be shown to reach it. */
let reads: string[] = [];

const summary = (row: PlaylistFixture) => ({
    ...row,
    // From the row, not hardcoded: both decide where a collection lands for a viewer, and a
    // summary that flattened them would make the per-viewer pin tests meaningless.
    name: row.name ?? "A list",
    pinned: row.pinned,
    description: null,
    sortMode: null,
    itemCount: 0,
    ownerName: "Someone",
    position: 0,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
});

/** Keyed `userId|kind|collectionId`, matching the table's primary key. */
const pinStore = new Map<string, { pinned: 1 | null; position: number | null }>();

vi.mock("@private-stock/db", () => ({
    /**
     * The per-viewer pin store (§14b), modelled rather than stubbed.
     *
     * The three states matter to what is under test here — no row means "follow the house", and
     * a row with a NULL `pinned` means "I took this out" — so a mock that only remembered
     * booleans would pass while the distinction was broken.
     */
    collectionPinRepo: {
        setPin: (userId: string, kind: string, collectionId: string, pinned: boolean | null) => {
            const key = `${userId}|${kind}|${collectionId}`;

            if (pinned === null) {
                pinStore.delete(key);
                return;
            }

            pinStore.set(key, { pinned: pinned ? 1 : null, position: null });
        },
        findPin: (userId: string, kind: string, collectionId: string) =>
            pinStore.get(`${userId}|${kind}|${collectionId}`),
        pinsFor: (userId: string, kind: string) =>
            new Map(
                [...pinStore.entries()]
                    .filter(([key]) => key.startsWith(`${userId}|${kind}|`))
                    .map(([key, value]) => [key.split("|")[2], value])
            ),
        clearPinsFor: (kind: string, collectionId: string) => {
            for (const key of [...pinStore.keys()]) {
                const [, storedKind, storedId] = key.split("|");
                if (storedKind === kind && storedId === collectionId) pinStore.delete(key);
            }
        },
    },
    // Creating with items is one transaction, so the mock needs the handle that opens it.
    db: { transaction: (fn: () => unknown) => () => fn() },
    playlistRepo: {
        create: (input: {
            ownerId: string;
            visibility: "private" | "shared";
            pinned?: boolean;
            name?: string;
        }) => {
            // `pinned` is modelled because on a shared playlist the owner's pin is the
            // household default, so a mock that dropped it would make every curated-baseline
            // test pass for the wrong reason.
            const row = {
                id: `p${playlists.length + 1}`,
                ...input,
                pinned: input.pinned ? (1 as const) : null,
            } as PlaylistFixture;
            playlists.push(row);

            return row.id;
        },
        findSummary: (id: string) => {
            const row = playlists.find((entry) => entry.id === id);

            return row ? summary(row) : undefined;
        },
        listVisibleTo: (userId: string) =>
            playlists
                .filter((row) => row.ownerId === userId || row.visibility === "shared")
                .map(summary),
        update: (id: string, patch: { visibility?: "private" | "shared"; pinned?: boolean }) => {
            writes.push(`update:${id}`);

            const row = playlists.find((entry) => entry.id === id);
            if (!row) return;

            // Applied rather than only recorded, so a test can assert the end state of a share
            // or a pin instead of asserting that a write happened.
            if (patch.visibility !== undefined) row.visibility = patch.visibility;
            if (patch.pinned !== undefined) row.pinned = patch.pinned ? (1 as const) : null;
        },
        remove: (id: string) => {
            writes.push(`remove:${id}`);
            playlists = playlists.filter((entry) => entry.id !== id);
        },
        addItems: (id: string, mediaIds: string[]) => {
            writes.push(`add:${id}:${mediaIds.join(",")}`);

            return mediaIds.length;
        },
        removeItem: (id: string, mediaId: string) => {
            writes.push(`removeItem:${id}:${mediaId}`);

            return true;
        },
        moveItem: (id: string) => {
            writes.push(`move:${id}`);

            return true;
        },
        listItemIds: (_id: string, limit: number, offset: number) =>
            storedIds.slice(offset, offset + limit),
        listItemIdsShuffled: (_id: string, page: number, pageSize: number, seed: number) => {
            reads.push(`shuffled:${page}:${seed}`);

            return { ids: storedIds.slice(page * pageSize, (page + 1) * pageSize), hasMore: false };
        },
        countItems: () => storedIds.length,
        sampleItemIds: (_id: string, count: number) => storedIds.slice(0, count),
    },
    mediaRepo: {
        listByIds: (ids: string[]) => {
            mediaReads += 1;

            return ids
                .filter((id) => visibleIds.includes(id))
                .map((id) => ({
                    id,
                    coverPath: coveredIds.includes(id) ? `${id}.webp` : null,
                    coverGeneratedAt: null,
                }));
        },
        listMediaIds: () => filterMatches,
    },
}));

vi.mock("./savedFilterService", () => ({
    resolveSavedQuery: (id: string) => {
        if (id !== "f1") {
            throw new NotFoundError("Saved filter not found");
        }

        return { sort: "addedAt", direction: "desc", limit: 60, page: 0 };
    },
}));

vi.mock("./mediaService", () => ({ toListPage: (rows: { id: string }[]) => rows }));

const {
    addPlaylistItems,
    createPlaylist,
    deletePlaylist,
    getPlaylist,
    listPlaylistItems,
    listPlaylists,
    setPlaylistPin,
    movePlaylistItem,
    updatePlaylist,
} = await import("./playlistService");

const asUser = (userId: string, scopes: string[] = []): AuthContext =>
    ({
        userId,
        email: `${userId}@example.com`,
        displayName: userId,
        scopes,
        accessibleRootIds: ["root"],
    }) as AuthContext;

/**
 * `OWNER` holds `admin`, because sharing is now curation and curation is an administrator's
 * (§14b). Most of this file is about ownership rather than scopes, and an owner who cannot
 * share would leave the shared-collection half of it untestable.
 *
 * `PLAIN` is the account that holds nothing, for the tests about who may share at all.
 */
const OWNER = asUser("owner", ["admin"]);
const PLAIN = asUser("plain");
const FRIEND = asUser("friend");
const ADMIN = asUser("admin", ["admin"]);

beforeEach(() => {
    pinStore.clear();
    playlists = [];
    writes = [];
    visibleIds = [];
    coveredIds = [];
    mediaReads = 0;
    filterMatches = [];
    storedIds = [];
    reads = [];
});

const shared = (): string =>
    createPlaylist(
        { name: "Shared", description: null, visibility: "shared", pinned: false },
        OWNER
    ).id;

describe("reading", () => {
    it("shows a shared playlist to another account, marked not editable", () => {
        const id = shared();

        expect(getPlaylist(id, FRIEND).editable).toBe(false);
        expect(getPlaylist(id, OWNER).editable).toBe(true);
    });

    /**
     * Missing, not forbidden.
     *
     * A 403 on someone else's private playlist would confirm that a playlist with that id
     * exists and who is worth asking about it. There is nothing to gain from the distinction
     * and a little to lose.
     */
    it("reports another account's private playlist as missing", () => {
        const id = createPlaylist(
            { name: "Private", description: null, visibility: "private", pinned: false },
            OWNER
        ).id;

        expect(() => getPlaylist(id, FRIEND)).toThrow(NotFoundError);
        expect(() => getPlaylist(id, ADMIN)).toThrow(NotFoundError);
    });

    /**
     * Your own first, then the household's.
     *
     * This asserted the opposite until the ordering moved into the service, and it passed
     * because the mock returned insertion order — the repo's own `ORDER BY (ownerId = :userId)
     * DESC` has always put your own first, so the expectation disagreed with the SQL it was
     * standing in for.
     */
    it("lists own playlists before shared ones", () => {
        shared();
        createPlaylist(
            { name: "Mine", description: null, visibility: "private", pinned: false },
            FRIEND
        );

        expect(listPlaylists(FRIEND).map((row) => row.editable)).toEqual([true, false]);
    });
});

describe("writing", () => {
    /**
     * The claim sharing rests on.
     *
     * `visibility: shared` is read-only by design — collaborative editing is not worth the
     * conflict handling (§6) — so every write path has to refuse a non-owner, not just the
     * obvious ones.
     */
    it("refuses every write to a shared playlist from anyone but the owner", () => {
        const id = shared();

        expect(() => updatePlaylist(id, { name: "Renamed" }, FRIEND)).toThrow(AuthorizationError);
        expect(() => deletePlaylist(id, FRIEND)).toThrow(AuthorizationError);
        expect(() => addPlaylistItems(id, { mediaIds: ["a"] }, FRIEND)).toThrow(AuthorizationError);
        expect(() => movePlaylistItem(id, { mediaId: "a", toIndex: 0 }, FRIEND)).toThrow(
            AuthorizationError
        );

        expect(writes).toEqual([]);
    });

    /**
     * `admin` manages the library, not other people's collections.
     *
     * Worth pinning down because the scope is checked in most other services, and the
     * temptation is to treat it as universal.
     */
    it("does not let an administrator edit someone else's shared playlist", () => {
        const id = shared();

        expect(() => updatePlaylist(id, { name: "Renamed" }, ADMIN)).toThrow(AuthorizationError);
        expect(writes).toEqual([]);
    });

    it("lets the owner edit", () => {
        const id = shared();

        updatePlaylist(id, { name: "Renamed" }, OWNER);

        expect(writes).toEqual([`update:${id}`]);
    });
});

describe("freezing a filter into a playlist", () => {
    /**
     * The bridge between a dynamic list and a fixed one.
     *
     * The query runs through `resolveSavedQuery`, so it is evaluated as the person doing the
     * freezing — their libraries, their hidden items, their ratings. A shared filter frozen by
     * two people is therefore allowed to produce two different playlists, which is the honest
     * meaning of copying a way of looking into a list of things.
     */
    it("adds everything the filter matches", () => {
        const id = shared();
        filterMatches = ["a", "b", "c"];

        expect(addPlaylistItems(id, { filterId: "f1", excludeIds: [] }, OWNER)).toEqual({
            added: 3,
            skipped: 0,
        });

        expect(writes).toEqual([`add:${id}:a,b,c`]);
    });

    it("honours exclusions, because the filter only approximates intent", () => {
        const id = shared();
        filterMatches = ["a", "b", "c"];

        addPlaylistItems(id, { filterId: "f1", excludeIds: ["b"] }, OWNER);

        expect(writes).toEqual([`add:${id}:a,c`]);
    });

    it("refuses a filter the freezer cannot read", () => {
        const id = shared();

        expect(() => addPlaylistItems(id, { filterId: "nope", excludeIds: [] }, OWNER)).toThrow(
            NotFoundError
        );
        expect(writes).toEqual([]);
    });

    it("still refuses a non-owner, exactly as the id form does", () => {
        const id = shared();
        filterMatches = ["a"];

        expect(() => addPlaylistItems(id, { filterId: "f1", excludeIds: [] }, FRIEND)).toThrow(
            AuthorizationError
        );
        expect(writes).toEqual([]);
    });
});

describe("adding items", () => {
    /**
     * Ids are filtered before they are written.
     *
     * Without this, an account could add an item from a library it cannot reach and — via a
     * shared playlist — learn that it exists. It would also leave the playlist's own owner
     * holding a row they can neither see nor explain.
     */
    it("silently drops ids the adder cannot see, and reports them as skipped", () => {
        const id = shared();
        visibleIds = ["visible"];

        expect(addPlaylistItems(id, { mediaIds: ["visible", "forbidden"] }, OWNER)).toEqual({
            added: 1,
            skipped: 1,
        });

        expect(writes).toEqual([`add:${id}:visible`]);
    });
});

describe("creating one from a selection", () => {
    /**
     * The items travel with the create (§14b).
     *
     * A create followed by an add is two requests that can half-fail, and what survives is an
     * empty playlist named after something it does not contain — which reads as the feature
     * having worked and then lost everything.
     */
    it("writes the items as part of the create", () => {
        visibleIds = ["a", "b"];

        const playlist = createPlaylist(
            {
                name: "Evening",
                description: null,
                visibility: "private",
                pinned: false,
                mediaIds: ["a", "b"],
            },
            OWNER
        );

        expect(writes).toEqual([`add:${playlist.id}:a,b`]);
    });

    it("writes nothing when no items come with it", () => {
        createPlaylist(
            { name: "Empty", description: null, visibility: "private", pinned: false },
            OWNER
        );

        // The ordinary create, unchanged: an empty `mediaIds` must not reach `addItems` and
        // leave a zero-row write behind for somebody to wonder about.
        expect(writes).toEqual([]);
    });

    /** The same visibility filter adding to an existing playlist applies — one rule, not two. */
    it("drops ids the creator cannot see", () => {
        visibleIds = ["visible"];

        const playlist = createPlaylist(
            {
                name: "Evening",
                description: null,
                visibility: "private",
                pinned: false,
                mediaIds: ["visible", "forbidden"],
            },
            OWNER
        );

        expect(writes).toEqual([`add:${playlist.id}:visible`]);
    });
});

describe("listing items", () => {
    const withItems = (ids: string[]): string => {
        const id = createPlaylist(
            { name: "Mine", description: null, visibility: "private", pinned: false },
            OWNER
        ).id;

        storedIds = ids;
        visibleIds = ids;

        return id;
    };

    it("serves the stored order when no seed is given", () => {
        const playlist = withItems(["a", "b", "c"]);
        const result = listPlaylistItems(playlist, 0, OWNER);

        expect(result.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
        expect(result.seed).toBeNull();
        expect(reads).toEqual([]);
    });

    it("goes through the permutation when one is", () => {
        const playlist = withItems(["a", "b", "c"]);
        const result = listPlaylistItems(playlist, 0, OWNER, 77);

        expect(reads).toEqual(["shuffled:0:77"]);
        // Echoed back, so the response says which of the two orders it is rather than
        // leaving that to be inferred from what was asked for.
        expect(result.seed).toBe(77);
    });

    it("reports the total in both orders", () => {
        const playlist = withItems(["a", "b", "c", "d"]);

        // The library's shuffle declines to count because counting there is a scan of the
        // matching set. A playlist's total is one indexed count, and a shuffled playlist is
        // exactly where knowing how much is left matters (§20).
        expect(listPlaylistItems(playlist, 0, OWNER).total).toBe(4);
        expect(listPlaylistItems(playlist, 0, OWNER, 1).total).toBe(4);
    });

    it("counts entries while listing only what the viewer can see", () => {
        const playlist = withItems(["a", "b", "c"]);
        visibleIds = ["a", "c"];

        const result = listPlaylistItems(playlist, 0, OWNER);

        // A playlist spanning a library this account cannot reach is normal, not an error:
        // the count is of entries, and it must not shrink when a share goes offline (§12b).
        expect(result.items.map((item) => item.id)).toEqual(["a", "c"]);
        expect(result.total).toBe(3);
    });

    it("refuses a playlist this viewer cannot see, shuffled or not", () => {
        const playlist = withItems(["a"]);

        expect(() => listPlaylistItems(playlist, 0, FRIEND)).toThrow(NotFoundError);
        expect(() => listPlaylistItems(playlist, 0, FRIEND, 3)).toThrow(NotFoundError);
    });
});

/**
 * The thumbnails on a playlist card (§14b).
 *
 * A face is a disclosure like any other, so the rule that governs the items governs these
 * too: an entry this viewer could not open contributes nothing, and a shared playlist
 * reaching into a library they cannot reach shows them a blank card rather than a peek at it.
 */
describe("covers for the card", () => {
    const withStored = (ids: string[]): string => {
        const id = createPlaylist(
            { name: "Mine", description: null, visibility: "private", pinned: false },
            OWNER
        ).id;

        storedIds = ids;

        return id;
    };

    it("takes covers from items the viewer can see", () => {
        const playlist = withStored(["a", "b"]);

        visibleIds = ["a", "b"];
        coveredIds = ["a", "b"];

        expect(getPlaylist(playlist, OWNER).covers).toEqual([
            expect.stringContaining("/api/art/a/cover"),
            expect.stringContaining("/api/art/b/cover"),
        ]);
    });

    it("leaves out an item in a library this viewer cannot reach", () => {
        const playlist = withStored(["a", "b"]);

        visibleIds = ["b"];
        coveredIds = ["a", "b"];

        expect(getPlaylist(playlist, OWNER).covers).toEqual([
            expect.stringContaining("/api/art/b/cover"),
        ]);
    });

    it("has none while the artwork is still being generated", () => {
        const playlist = withStored(["a"]);

        visibleIds = ["a"];

        expect(getPlaylist(playlist, OWNER).covers).toEqual([]);
    });

    /** Four is what the mosaic holds; the wider sample exists to fill it, not to overflow it. */
    it("stops at a row's strip of eight however many it sampled", () => {
        const many = Array.from({ length: 11 }, (_, i) => `m${i}`);
        const playlist = withStored(many);

        visibleIds = many;
        coveredIds = many;

        expect(getPlaylist(playlist, OWNER).covers).toHaveLength(8);
    });

    /**
     * One read for the whole list, not one per playlist.
     *
     * Both the sidebar and the playlists page ask for every playlist at once, so a per-row
     * media query would make the cost of the page the number of lists somebody keeps.
     */
    it("reads the media table once however many playlists there are", () => {
        withStored(["a"]);
        withStored(["a"]);
        visibleIds = ["a"];
        mediaReads = 0;

        expect(listPlaylists(OWNER)).toHaveLength(2);
        expect(mediaReads).toBe(1);
    });
});

/**
 * Sharing is curation (§14b).
 *
 * A shared collection is one the house offers, and an administrator's pin on it becomes the
 * default in everybody's sidebar — which is why publishing one is not authority every account
 * holds. Withdrawing is deliberately not privileged the same way.
 */
describe("who may share", () => {
    it("refuses an ordinary account creating a shared playlist", () => {
        expect(() =>
            createPlaylist(
                { name: "Theirs", description: null, visibility: "shared", pinned: false },
                PLAIN
            )
        ).toThrow(AuthorizationError);
    });

    it("lets an ordinary account keep as many private playlists as they like", () => {
        expect(() =>
            createPlaylist(
                { name: "Mine", description: null, visibility: "private", pinned: false },
                PLAIN
            )
        ).not.toThrow();
    });

    it("refuses an ordinary account sharing one it already owns", () => {
        const id = createPlaylist(
            { name: "Mine", description: null, visibility: "private", pinned: false },
            PLAIN
        ).id;

        expect(() => updatePlaylist(id, { visibility: "shared" }, PLAIN)).toThrow(
            AuthorizationError
        );
    });

    it("lets an administrator share", () => {
        const id = createPlaylist(
            { name: "Household", description: null, visibility: "private", pinned: false },
            OWNER
        ).id;

        expect(updatePlaylist(id, { visibility: "shared" }, OWNER).visibility).toBe("shared");
    });

    /**
     * Otherwise an administrator who lost the scope would leave something shared that nobody
     * could withdraw.
     */
    it("lets any owner withdraw their own shared playlist", () => {
        const id = createPlaylist(
            { name: "Was shared", description: null, visibility: "shared", pinned: false },
            OWNER
        ).id;

        // The same account, now without the scope.
        const demoted = asUser("owner");

        expect(updatePlaylist(id, { visibility: "private" }, demoted).visibility).toBe("private");
    });

    it("does not let sharing be a way to edit somebody else's playlist", () => {
        const id = createPlaylist(
            { name: "Theirs", description: null, visibility: "private", pinned: false },
            PLAIN
        ).id;

        expect(() => updatePlaylist(id, { visibility: "shared" }, ADMIN)).toThrow();
    });
});

/**
 * Where a curated playlist sits, per person (§14b).
 *
 * The gap this closes: `pinned` was a column on the owner's row, so somebody a playlist was
 * shared *with* had nowhere to record a pin — they could neither add it to their own sidebar
 * nor take the household's default out of it.
 */
describe("pinning, per viewer", () => {
    const curated = (): string =>
        createPlaylist(
            { name: "Christmas", description: null, visibility: "shared", pinned: true },
            OWNER
        ).id;

    it("puts a curated playlist in everybody's sidebar", () => {
        const id = curated();

        expect(getPlaylist(id, FRIEND).pinned).toBe(true);
        expect(getPlaylist(id, FRIEND).curated).toBe(true);
    });

    it("lets somebody take it out of theirs, and leaves everyone else alone", () => {
        const id = curated();

        setPlaylistPin(id, false, FRIEND);

        expect(getPlaylist(id, FRIEND).pinned).toBe(false);
        expect(getPlaylist(id, OWNER).pinned).toBe(true);
    });

    it("no longer calls it curated once they have decided", () => {
        const id = curated();

        setPlaylistPin(id, false, FRIEND);

        expect(getPlaylist(id, FRIEND).curated).toBe(false);
    });

    /** Clearing the decision is not unpinning: it goes back to whatever the house offers. */
    it("follows the house again when the decision is cleared", () => {
        const id = curated();

        setPlaylistPin(id, false, FRIEND);
        setPlaylistPin(id, null, FRIEND);

        expect(getPlaylist(id, FRIEND).pinned).toBe(true);
    });

    it("lets somebody pin a shared playlist the house did not promote", () => {
        const id = createPlaylist(
            { name: "Quiet", description: null, visibility: "shared", pinned: false },
            OWNER
        ).id;

        setPlaylistPin(id, true, FRIEND);

        expect(getPlaylist(id, FRIEND).pinned).toBe(true);
        expect(getPlaylist(id, OWNER).pinned).toBe(false);
    });

    /** Pinning is not editing, so it needs no ownership — only the right to see the thing. */
    it("refuses a pin on a playlist the viewer cannot see", () => {
        const id = createPlaylist(
            { name: "Private", description: null, visibility: "private", pinned: false },
            OWNER
        ).id;

        expect(() => setPlaylistPin(id, true, FRIEND)).toThrow(NotFoundError);
    });

    it("forgets everybody's pin when the playlist is deleted", () => {
        const id = curated();
        setPlaylistPin(id, true, FRIEND);

        deletePlaylist(id, OWNER);

        // Recreated under the same name; the stale pin must not attach itself to it.
        const fresh = createPlaylist(
            { name: "Christmas", description: null, visibility: "shared", pinned: false },
            OWNER
        ).id;

        expect(getPlaylist(fresh, FRIEND).pinned).toBe(false);
    });
});
