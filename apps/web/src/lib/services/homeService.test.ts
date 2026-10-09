import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_HOME_LAYOUT, type HomeLayout, type MediaQuery } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * The home page (§6).
 *
 * A shelf points at something that can disappear — a saved filter, a playlist, a tag — and
 * every one of those references can go stale while the layout stays exactly as it was. So the
 * claims worth testing are all about what happens when a reference no longer resolves: the
 * page must still render, and the row must say why it is empty rather than silently being one
 * row shorter than the user arranged.
 */

let storedLayout: string | undefined;
let filters: {
    id: string;
    userId: string;
    name: string;
    queryJson: string;
    visibility: "private" | "shared";
    /** 1 or absent, matching the column: booleans are stored as 1 or NULL, never 0. */
    pinned?: 1 | null;
    position?: number;
}[] = [];
let playlists: { id: string; ownerId: string; name: string; visibility: string }[] = [];
let tags: { id: string; name: string }[] = [];
/** Every query `listMedia` was asked to run, so a shelf's intent can be asserted. */
let queries: MediaQuery[] = [];
let recentlyViewedCalls: number[] = [];
/** Every shuffle a shuffled shelf drew its sample from, as [count, seed]. */
let shuffles: [number, number][] = [];
/** Every set of ids hydrated by id, in the order asked for. */
let hydrated: string[][] = [];

vi.mock("@private-stock/db", () => ({
    // A transaction that just runs its body, in whichever variant is asked for.
    db: {
        transaction: <T>(fn: () => T) => Object.assign(fn, { deferred: fn, immediate: fn }),
    },
    homeLayoutRepo: {
        find: () => storedLayout,
        save: (_userId: string, rowsJson: string) => {
            storedLayout = rowsJson;
        },
        clear: () => {
            storedLayout = undefined;
        },
    },
    savedFilterRepo: {
        listVisibleTo: (userId: string) =>
            filters
                .filter((entry) => entry.userId === userId || entry.visibility === "shared")
                .map((entry) => ({
                    ...entry,
                    pinned: entry.pinned ?? null,
                    position: entry.position ?? 0,
                    ownerName: "Someone",
                })),
        findVisibleTo: (id: string, userId: string) => {
            const row = filters.find(
                (entry) =>
                    entry.id === id && (entry.userId === userId || entry.visibility === "shared")
            );

            return row ? { ...row, ownerName: "Someone" } : undefined;
        },
    },
    playlistRepo: {
        findSummary: (id: string) => playlists.find((row) => row.id === id),
        listItemIds: () => ["m1"],
    },
    tagRepo: {
        findById: (id: string) => tags.find((row) => row.id === id),
    },
    mediaRepo: {
        listByIds: (ids: string[]) => {
            hydrated.push(ids);

            return ids.map((id) => ({ id }));
        },
        shuffledIds: (
            _query: MediaQuery,
            _userId: string,
            _rootIds: string[],
            count: number,
            seed: number
        ) => {
            shuffles.push([count, seed]);

            return Array.from({ length: count }, (_, i) => `s${i}`);
        },
        listRecentlyViewed: (_userId: string, _rootIds: string[], limit: number) => {
            recentlyViewedCalls.push(limit);

            return [{ id: "resumable" }];
        },
    },
}));

vi.mock("./mediaService", () => ({
    toListPage: (rows: { id: string }[]) => rows,
    listMedia: (query: MediaQuery) => {
        queries.push(query);

        return { items: [{ id: "queried" }] };
    },
}));

let adminLayout: HomeLayout = DEFAULT_HOME_LAYOUT;

vi.mock("./settingsService", () => ({
    loadAdminSettings: () => ({ homeLayout: adminLayout }),
}));

const { getHome, resetHomeLayout, saveHomeLayout } = await import("./homeService");

const AUTH = {
    userId: "me",
    email: "me@example.com",
    displayName: "Me",
    scopes: [],
    accessibleRootIds: ["root"],
} as unknown as AuthContext;

beforeEach(() => {
    storedLayout = undefined;
    filters = [];
    playlists = [];
    tags = [];
    queries = [];
    recentlyViewedCalls = [];
    shuffles = [];
    hydrated = [];
    adminLayout = DEFAULT_HOME_LAYOUT;
});

const withLayout = (layout: HomeLayout) => {
    storedLayout = JSON.stringify(layout);
};

describe("which layout is used", () => {
    it("inherits the admin default when the account has arranged nothing", () => {
        adminLayout = [{ source: "builtin", builtin: "topRated", limit: 5 }];

        const home = getHome(AUTH);

        expect(home.isDefault).toBe(true);
        expect(home.shelves.map((shelf) => shelf.title)).toEqual(["Top rated"]);
    });

    /**
     * Inherited by reference, not by copy.
     *
     * An account that has never touched its home page tracks the admin default as it changes.
     * Copying the default in at signup would freeze every account on whatever it happened to
     * be that day, and nobody would ever find out why changing it had no effect.
     */
    it("follows the admin default as it changes", () => {
        adminLayout = [{ source: "builtin", builtin: "topRated", limit: 5 }];
        expect(getHome(AUTH).shelves[0].title).toBe("Top rated");

        adminLayout = [{ source: "builtin", builtin: "favorites", limit: 5 }];
        expect(getHome(AUTH).shelves[0].title).toBe("Favourites");
    });

    it("uses the account's own layout once it has one, and forgets it on reset", () => {
        saveHomeLayout([{ source: "builtin", builtin: "favorites", limit: 4 }], AUTH);
        expect(getHome(AUTH).isDefault).toBe(false);

        resetHomeLayout(AUTH);
        expect(getHome(AUTH).isDefault).toBe(true);
    });

    /**
     * A layout that cannot be parsed is a home page with nothing on it.
     *
     * Falling back to the default leaves something to look at and something to click; an
     * empty page would leave the user no way back.
     */
    it("falls back to the default when the stored layout cannot be read", () => {
        storedLayout = "not json";

        expect(getHome(AUTH).shelves.length).toBe(DEFAULT_HOME_LAYOUT.length);
        expect(getHome(AUTH).isDefault).toBe(true);
    });
});

describe("a reference that no longer resolves", () => {
    it("explains a deleted saved filter instead of dropping the row", () => {
        withLayout([{ source: "filter", filterId: "gone", limit: 6 }]);

        const [shelf] = getHome(AUTH).shelves;

        expect(shelf.items).toEqual([]);
        expect(shelf.unavailable).toMatch(/no longer available/i);
        // The descriptor comes back, so the row can be removed from the layout as it stands.
        expect(shelf.shelf).toEqual({ source: "filter", filterId: "gone", limit: 6 });
    });

    it("explains a deleted tag", () => {
        withLayout([{ source: "tag", tagId: "gone", limit: 6 }]);

        expect(getHome(AUTH).shelves[0].unavailable).toMatch(/deleted/i);
    });

    /**
     * A playlist that was shared and then made private again.
     *
     * Reported exactly as a deleted one is. Distinguishing the two would tell this viewer
     * something about the owner's choices that they are not entitled to know, and there is
     * nothing they could do differently with the distinction.
     */
    it("does not distinguish an unshared playlist from a deleted one", () => {
        playlists = [{ id: "p1", ownerId: "someone-else", name: "Theirs", visibility: "private" }];
        withLayout([{ source: "playlist", playlistId: "p1", limit: 6 }]);

        const unshared = getHome(AUTH).shelves[0].unavailable;

        playlists = [];
        const deleted = getHome(AUTH).shelves[0].unavailable;

        expect(unshared).toBe(deleted);
    });

    it("still shows a shared filter belonging to someone else", () => {
        filters = [
            {
                id: "f1",
                userId: "someone-else",
                name: "Theirs",
                queryJson: JSON.stringify({ sort: "addedAt", direction: "desc", limit: 60 }),
                visibility: "shared",
            },
        ];
        withLayout([{ source: "filter", filterId: "f1", limit: 6 }]);

        const [shelf] = getHome(AUTH).shelves;

        expect(shelf.title).toBe("Theirs");
        expect(shelf.unavailable).toBeNull();
        expect(shelf.items).toEqual([{ id: "queried" }]);
    });

    it("still shows a shared playlist belonging to someone else", () => {
        playlists = [{ id: "p1", ownerId: "someone-else", name: "Theirs", visibility: "shared" }];
        withLayout([{ source: "playlist", playlistId: "p1", limit: 6 }]);

        const [shelf] = getHome(AUTH).shelves;

        expect(shelf.title).toBe("Theirs");
        expect(shelf.unavailable).toBeNull();
        expect(shelf.items).toEqual([{ id: "m1" }]);
    });

    it("renders the rest of the page around a broken row", () => {
        withLayout([
            { source: "filter", filterId: "gone", limit: 6 },
            { source: "builtin", builtin: "recentlyAdded", limit: 6 },
        ]);

        const home = getHome(AUTH);

        expect(home.shelves).toHaveLength(2);
        expect(home.shelves[1].items).toEqual([{ id: "queried" }]);
    });
});

describe("what each shelf asks for", () => {
    it("reads continue watching from the overlay table, not the library query", () => {
        withLayout([{ source: "builtin", builtin: "recentlyViewed", limit: 8 }]);

        expect(getHome(AUTH).shelves[0].items).toEqual([{ id: "resumable" }]);
        expect(recentlyViewedCalls).toEqual([8]);
        expect(queries).toEqual([]);
    });

    it("excludes unrated items from the top rated shelf", () => {
        withLayout([{ source: "builtin", builtin: "topRated", limit: 6 }]);
        getHome(AUTH);

        expect(queries[0].minRating).toBe(1);
        expect(queries[0].sort).toBe("rating");
    });

    /**
     * The shuffled shelf is meant to differ each time.
     *
     * The grid does the opposite — its seed lives in the URL so paging stays stable — so this
     * is the one place a fresh seed per request is the correct behaviour rather than a bug.
     */
    it("reshuffles the random shelf on every request", () => {
        withLayout([{ source: "builtin", builtin: "random", limit: 6 }]);

        getHome(AUTH);
        getHome(AUTH);

        expect(hydrated).toHaveLength(2);
        expect(hydrated[0]).toHaveLength(6);
        expect(hydrated[0]).not.toEqual(hydrated[1]);
    });

    /**
     * A shuffle reads the whole matching set, so it is drawn from rather than repeated (§20).
     * The limit differs from every other test's, which keeps this sample its own: samples are
     * cached per query for the life of the process.
     */
    it("draws a shuffled shelf from one sample rather than shuffling the library each time", () => {
        withLayout([{ source: "builtin", builtin: "random", limit: 7 }]);

        getHome(AUTH);
        getHome(AUTH);
        getHome(AUTH);

        expect(shuffles).toHaveLength(1);
        expect(shuffles[0][0]).toBe(7 * 20);
        expect(queries).toEqual([]);
    });

    it("caps every shelf at the limit the layout asked for", () => {
        withLayout([{ source: "tag", tagId: "t1", limit: 3 }]);
        tags = [{ id: "t1", name: "Sunsets" }];

        getHome(AUTH);

        expect(queries[0].limit).toBe(3);
        expect(queries[0].tags).toEqual(["t1"]);
    });

    it("prefers a title the user chose over the one the source would supply", () => {
        tags = [{ id: "t1", name: "Sunsets" }];
        withLayout([{ source: "tag", tagId: "t1", title: "Golden hour", limit: 3 }]);

        expect(getHome(AUTH).shelves[0].title).toBe("Golden hour");
    });
});

describe("pinned saved filters as shelves", () => {
    const pinnedFilter = (id: string, name: string, over: Record<string, unknown> = {}) => ({
        id,
        userId: AUTH.userId,
        name,
        queryJson: JSON.stringify({ sort: "addedAt", direction: "desc", limit: 60 }),
        visibility: "private" as const,
        pinned: 1 as const,
        position: 0,
        ...over,
    });

    it("adds a shelf for a pinned filter without anyone arranging one", () => {
        filters = [pinnedFilter("f1", "Unrated 4K")];
        withLayout([{ source: "builtin", builtin: "recentlyAdded", limit: 6 }]);

        const titles = getHome(AUTH).shelves.map((shelf) => shelf.title);

        // Pinning is one gesture with one meaning: the sidebar lists it, and the front door
        // shows what is in it.
        expect(titles).toEqual(["Recently added", "Unrated 4K"]);
    });

    it("leaves an unpinned filter off the front door", () => {
        filters = [pinnedFilter("f1", "Not pinned", { pinned: null })];
        withLayout([{ source: "builtin", builtin: "recentlyAdded", limit: 6 }]);

        expect(getHome(AUTH).shelves.map((shelf) => shelf.title)).toEqual(["Recently added"]);
    });

    it("does not add a second row for a filter the layout already places", () => {
        filters = [pinnedFilter("f1", "Unrated 4K")];
        // Somebody's own arrangement: their title, their limit, their position.
        withLayout([{ source: "filter", filterId: "f1", title: "Mine", limit: 3 }]);

        const shelves = getHome(AUTH).shelves;

        expect(shelves).toHaveLength(1);
        // The explicit entry wins over one generated from a flag.
        expect(shelves[0].title).toBe("Mine");
    });

    it("appends in the order the filters were arranged in", () => {
        filters = [
            pinnedFilter("f1", "Second", { position: 2 }),
            pinnedFilter("f2", "First", { position: 1 }),
        ];
        withLayout([]);

        expect(getHome(AUTH).shelves.map((shelf) => shelf.title)).toEqual(["First", "Second"]);
    });

    it("ignores a pin on a filter shared by somebody else", () => {
        // `pinned` lives on the filter rather than per viewer, so inheriting it would
        // rearrange your front door because somebody else tidied theirs.
        filters = [pinnedFilter("f1", "Theirs", { userId: "someone-else", visibility: "shared" })];
        withLayout([]);

        expect(getHome(AUTH).shelves).toEqual([]);
    });

    it("never grows past the cap a stored layout is held to", () => {
        filters = Array.from({ length: 25 }, (_, index) =>
            pinnedFilter(`f${index}`, `Filter ${index}`, { position: index })
        );
        withLayout([{ source: "builtin", builtin: "recentlyAdded", limit: 6 }]);

        expect(getHome(AUTH).shelves).toHaveLength(20);
    });
});
