import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    AuthorizationError,
    ConflictError,
    NotFoundError,
    ValidationError,
} from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * Saved filters — dynamic playlists (§6).
 *
 * Three things here are easy to get wrong and invisible when they are. A stored query is the
 * only place this app reads back JSON it wrote earlier, so what happens when it no longer
 * parses decides whether a schema change looks like a broken filter or like one that silently
 * vanished. Sharing has to grant reading and never writing, exactly as it does for playlists.
 * And a shared filter can name different items for each viewer, which is the one way it is
 * unlike a shared playlist and the one thing a UI has to be told about.
 */

interface FilterFixture {
    id: string;
    userId: string;
    name: string;
    queryJson: string;
    description: string | null;
    visibility: "private" | "shared";
    resolveAs: "viewer" | "owner";
    pinned: 1 | null;
    position: number;
    createdAt: string;
    updatedAt: string;
}

let filters: FilterFixture[] = [];

const withOwner = (row: FilterFixture) => ({ ...row, ownerName: `Owner of ${row.id}` });

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
    savedFilterRepo: {
        create: (input: {
            userId: string;
            name: string;
            queryJson: string;
            description: string | null;
            pinned: boolean;
            visibility: "private" | "shared";
            resolveAs: "viewer" | "owner";
        }) => {
            const row: FilterFixture = {
                id: `f${filters.length + 1}`,
                userId: input.userId,
                name: input.name,
                queryJson: input.queryJson,
                description: input.description,
                visibility: input.visibility,
                resolveAs: input.resolveAs,
                pinned: input.pinned ? 1 : null,
                position: filters.length,
                createdAt: "2026-01-01",
                updatedAt: "2026-01-01",
            };
            filters.push(row);

            return row.id;
        },
        findById: (id: string, userId: string) =>
            filters.find((row) => row.id === id && row.userId === userId),
        findVisibleTo: (id: string, userId: string) => {
            const row = filters.find(
                (entry) =>
                    entry.id === id && (entry.userId === userId || entry.visibility === "shared")
            );

            return row ? withOwner(row) : undefined;
        },
        findByName: (userId: string, name: string) =>
            filters.find((row) => row.userId === userId && row.name === name),
        listVisibleTo: (userId: string) =>
            filters
                .filter((row) => row.userId === userId || row.visibility === "shared")
                .map(withOwner),
        update: (
            id: string,
            userId: string,
            input: {
                name?: string;
                queryJson?: string;
                pinned?: boolean;
                visibility?: "private" | "shared";
                resolveAs?: "viewer" | "owner";
            }
        ) => {
            const row = filters.find((entry) => entry.id === id && entry.userId === userId);

            if (!row) {
                return false;
            }

            if (input.name !== undefined) {
                row.name = input.name;
            }

            if (input.queryJson !== undefined) {
                row.queryJson = input.queryJson;
            }

            if (input.pinned !== undefined) {
                row.pinned = input.pinned ? 1 : null;
            }

            if (input.visibility !== undefined) {
                row.visibility = input.visibility;
            }

            if (input.resolveAs !== undefined) {
                row.resolveAs = input.resolveAs;
            }

            return true;
        },
        remove: (id: string, userId: string) => {
            const before = filters.length;
            filters = filters.filter((row) => !(row.id === id && row.userId === userId));

            return filters.length < before;
        },
    },
}));

const {
    createSavedFilter,
    deleteSavedFilter,
    listSavedFilters,
    overlayForRequest,
    resolveSavedQuery,
    setSavedFilterPin,
    updateSavedFilter,
} = await import("./savedFilterService");

const asUser = (userId: string, scopes: string[] = []): AuthContext =>
    ({
        userId,
        email: `${userId}@example.com`,
        displayName: userId,
        scopes,
        accessibleRootIds: ["root"],
    }) as AuthContext;

/**
 * `ME` holds `admin`, because sharing is now curation and curation is an administrator's
 * (§14b). This file is mostly about ownership and about how a shared filter resolves ratings,
 * and an owner who cannot share would leave both untestable.
 *
 * `PLAIN` holds nothing, for the tests about who may share at all.
 */
const ME = asUser("me", ["admin"]);
const PLAIN = asUser("plain");
const SOMEONE_ELSE = asUser("them");
const ADMIN = asUser("admin", ["admin"]);

type NewFilter = Parameters<typeof createSavedFilter>[0];

const QUERY = {
    sort: "addedAt",
    direction: "desc",
    limit: 60,
} as unknown as NewFilter["query"];

/** A query that tests the viewer's own ratings, so it means something different per person. */
const MY_RATINGS = {
    ...QUERY,
    minRating: 4,
} as unknown as NewFilter["query"];

const newFilter = (overrides: Partial<NewFilter> = {}, auth = ME) =>
    createSavedFilter(
        {
            name: `Filter ${filters.length + 1}`,
            description: null,
            query: QUERY,
            pinned: false,
            visibility: "private",
            resolveAs: "viewer",
            ...overrides,
        },
        auth
    );

beforeEach(() => {
    pinStore.clear();
    filters = [];
});

describe("ownership", () => {
    it("does not find another account's private filter, whatever is done to it", () => {
        const id = newFilter().id;

        expect(listSavedFilters(SOMEONE_ELSE)).toEqual([]);
        expect(() => updateSavedFilter(id, { name: "Yours" }, SOMEONE_ELSE)).toThrow(NotFoundError);
        expect(() => deleteSavedFilter(id, SOMEONE_ELSE)).toThrow(NotFoundError);
        expect(() => resolveSavedQuery(id, 0, SOMEONE_ELSE)).toThrow(NotFoundError);
    });

    it("allows the same name for two different accounts", () => {
        newFilter({ name: "Favourites" });

        expect(() => newFilter({ name: "Favourites" }, SOMEONE_ELSE)).not.toThrow();
    });

    it("refuses a duplicate name for the same account, rather than overwriting", () => {
        newFilter({ name: "Favourites" });

        expect(() => newFilter({ name: "Favourites" })).toThrow(ConflictError);
        expect(listSavedFilters(ME)).toHaveLength(1);
    });

    it("lets a filter keep its own name while being edited", () => {
        const id = newFilter({ name: "Favourites" }).id;

        expect(() => updateSavedFilter(id, { name: "Favourites", pinned: true }, ME)).not.toThrow();
        expect(listSavedFilters(ME)[0].pinned).toBe(true);
    });
});

describe("sharing", () => {
    it("shows a shared filter to another account, marked not editable", () => {
        const id = newFilter({ visibility: "shared" }).id;

        expect(listSavedFilters(SOMEONE_ELSE).map((row) => row.id)).toEqual([id]);
        expect(listSavedFilters(SOMEONE_ELSE)[0].editable).toBe(false);
        expect(listSavedFilters(ME)[0].editable).toBe(true);
    });

    /**
     * The same rule playlists have, and for the same reason.
     *
     * Sharing grants reading. An administrator manages the library, not other people's ways
     * of looking at it — and the temptation to treat `admin` as universal is exactly why this
     * is pinned down.
     */
    it("refuses every write from anyone but the owner, including an administrator", () => {
        const id = newFilter({ visibility: "shared" }).id;

        expect(() => updateSavedFilter(id, { name: "Mine now" }, SOMEONE_ELSE)).toThrow(
            AuthorizationError
        );
        expect(() => deleteSavedFilter(id, SOMEONE_ELSE)).toThrow(AuthorizationError);
        expect(() => updateSavedFilter(id, { name: "Mine now" }, ADMIN)).toThrow(
            AuthorizationError
        );

        expect(listSavedFilters(ME)[0].name).not.toBe("Mine now");
    });

    it("lets someone else run a shared filter", () => {
        const id = newFilter({ visibility: "shared" }).id;

        expect(() => resolveSavedQuery(id, 0, SOMEONE_ELSE)).not.toThrow();
    });

    it("stops sharing when the owner makes it private again", () => {
        const id = newFilter({ visibility: "shared" }).id;

        updateSavedFilter(id, { visibility: "private" }, ME);

        expect(listSavedFilters(SOMEONE_ELSE)).toEqual([]);
        expect(() => resolveSavedQuery(id, 0, SOMEONE_ELSE)).toThrow(NotFoundError);
    });

    /**
     * The one way a shared filter is unlike a shared playlist.
     *
     * A playlist names the same items for everyone. A filter that asks about ratings names
     * *your* items when you open it — sometimes the point, sometimes a trap, so it is
     * reported rather than forbidden and the UI can say so.
     */
    it("flags a query that resolves against the viewer rather than the library", () => {
        newFilter({ name: "Objective", query: QUERY, visibility: "shared" });
        newFilter({ name: "Mine", query: MY_RATINGS, visibility: "shared" });

        const [objective, mine] = listSavedFilters(SOMEONE_ELSE);

        expect(objective.viewerRelative).toBe(false);
        expect(mine.viewerRelative).toBe(true);
    });
});

describe("whose ratings a shared filter asks about", () => {
    const sharedRatings = (resolveAs: "viewer" | "owner") =>
        newFilter({ query: MY_RATINGS, visibility: "shared", resolveAs }).id;

    it("asks about the viewer's own ratings by default", () => {
        const id = sharedRatings("viewer");

        expect(resolveSavedQuery(id, 0, SOMEONE_ELSE).overlayUserId).toBeUndefined();
        expect(listSavedFilters(SOMEONE_ELSE)[0].showsOwnerRatings).toBe(false);
    });

    it("asks about the owner's ratings when the owner chose that", () => {
        const id = sharedRatings("owner");

        expect(resolveSavedQuery(id, 0, SOMEONE_ELSE).overlayUserId).toBe(ME.userId);
        expect(listSavedFilters(SOMEONE_ELSE)[0].showsOwnerRatings).toBe(true);
    });

    /**
     * The owner opening their own filter is not looking at somebody else's ratings.
     *
     * It has to produce no overlay at all rather than one pointing at themselves, because the
     * repo turns "no overlay" into the query it ran before any of this existed — and this is
     * the hottest query in the app.
     */
    it("produces no overlay when the owner opens it themselves", () => {
        const id = sharedRatings("owner");

        expect(resolveSavedQuery(id, 0, ME).overlayUserId).toBeUndefined();
        expect(listSavedFilters(ME)[0].showsOwnerRatings).toBe(false);
    });

    /**
     * Inert on a query with nothing personal in it.
     *
     * "Every video tagged Jane Doe" means the same thing whoever asks, so an owner-relative
     * setting on it must not cost a join whose columns nothing reads.
     */
    it("produces no overlay when the query never asks about ratings", () => {
        const id = newFilter({ query: QUERY, visibility: "shared", resolveAs: "owner" }).id;

        expect(resolveSavedQuery(id, 0, SOMEONE_ELSE).overlayUserId).toBeUndefined();
        expect(listSavedFilters(SOMEONE_ELSE)[0].showsOwnerRatings).toBe(false);
    });

    it("can be changed after the fact, like any other part of the filter", () => {
        const id = sharedRatings("viewer");

        updateSavedFilter(id, { resolveAs: "owner" }, ME);

        expect(resolveSavedQuery(id, 0, SOMEONE_ELSE).overlayUserId).toBe(ME.userId);
    });
});

/**
 * The same decision for a grid opened from the filter, which sends the filter's id beside its
 * expanded parameters (§6). Without it the grid, its count and its facets all read the
 * viewer's ratings while the same filter on a home shelf read the owner's.
 */
describe("whose ratings a grid opened from a filter asks about", () => {
    const shared = () =>
        newFilter({ query: MY_RATINGS, visibility: "shared", resolveAs: "owner" }).id;

    it("resolves against the owner, as the filter itself does", () => {
        expect(overlayForRequest(shared(), MY_RATINGS, SOMEONE_ELSE)).toBe(ME.userId);
    });

    it("keeps the owner's ratings when the view is only narrowed", () => {
        const narrowed = { ...MY_RATINGS, kind: "video", page: 3 } as typeof MY_RATINGS;

        expect(overlayForRequest(shared(), narrowed, SOMEONE_ELSE)).toBe(ME.userId);
    });

    /**
     * Otherwise an edited view could ask anything of the owner's ratings -- one star, then
     * two -- and read them all, which is more than they chose to share.
     */
    it.each([
        ["a different band", { minRating: 1 }],
        ["favourites added", { favorite: true }],
        ["sorted by rating", { sort: "rating" }],
    ])("falls back to the viewer's own ratings with %s", (_label, change) => {
        const edited = { ...MY_RATINGS, ...change } as typeof MY_RATINGS;

        expect(overlayForRequest(shared(), edited, SOMEONE_ELSE)).toBeUndefined();
    });

    it("is no overlay for no filter, a missing one, or one this viewer cannot see", () => {
        const hidden = newFilter({ query: MY_RATINGS, resolveAs: "owner" }).id;

        expect(overlayForRequest(null, MY_RATINGS, SOMEONE_ELSE)).toBeUndefined();
        expect(overlayForRequest("gone", MY_RATINGS, SOMEONE_ELSE)).toBeUndefined();
        expect(overlayForRequest(hidden, MY_RATINGS, SOMEONE_ELSE)).toBeUndefined();
    });

    it("is no overlay for the owner themselves", () => {
        expect(overlayForRequest(shared(), MY_RATINGS, ME)).toBeUndefined();
    });
});

describe("a query that can no longer be read", () => {
    const corrupt = (id: string, queryJson: string): void => {
        filters.find((row) => row.id === id)!.queryJson = queryJson;
    };

    /**
     * The filter is shown as broken, not hidden.
     *
     * A filter that disappeared from the sidebar because its stored JSON stopped parsing
     * would look exactly like data loss, with nothing to inspect and nothing to delete.
     */
    it("is listed with a null query rather than dropped", () => {
        const id = newFilter().id;
        corrupt(id, `{"sort":"by-vibes"}`);

        const listed = listSavedFilters(ME);

        expect(listed).toHaveLength(1);
        expect(listed[0].query).toBeNull();
    });

    it("survives JSON that is not JSON at all", () => {
        const id = newFilter().id;
        corrupt(id, "not json");

        expect(listSavedFilters(ME)[0].query).toBeNull();
    });

    /** Nothing to judge, so nothing is claimed either way. */
    it("reports viewerRelative as null rather than guessing", () => {
        const id = newFilter().id;
        corrupt(id, "not json");

        expect(listSavedFilters(ME)[0].viewerRelative).toBeNull();
    });

    it("refuses to run, instead of running an empty query over the whole library", () => {
        const id = newFilter().id;
        corrupt(id, "not json");

        expect(() => resolveSavedQuery(id, 0, ME)).toThrow(ValidationError);
    });
});

describe("running a filter", () => {
    it("takes the page from the request and everything else from the filter", () => {
        const id = newFilter({ query: MY_RATINGS }).id;

        const { query } = resolveSavedQuery(id, 3, ME);

        expect(query.page).toBe(3);
        expect(query.minRating).toBe(4);
    });

    /**
     * A filter is a way of looking, not a position.
     *
     * Storing the page would drop someone at page 7 of a library that has since changed
     * underneath them, which is never what saving a filter meant.
     */
    it("does not store a page with the filter", () => {
        const id = newFilter({ query: { ...QUERY, page: 7 } as NewFilter["query"] }).id;

        expect(JSON.parse(filters.find((row) => row.id === id)!.queryJson)).not.toHaveProperty(
            "page"
        );
    });
});

/**
 * Sharing is curation (§14b).
 *
 * The same rule, in the same words, as playlists. They are the same object with different
 * mechanics, and the two test files sit beside each other so a divergence is visible.
 */
describe("who may share", () => {
    /** `newFilter` already exists for this; no reason for a second spelling of it. */
    const madeBy = (who: AuthContext, over: Partial<NewFilter> = {}) => newFilter(over, who);

    it("refuses an ordinary account creating a shared view", () => {
        expect(() => madeBy(PLAIN, { name: "Theirs", visibility: "shared" })).toThrow(
            AuthorizationError
        );
    });

    it("lets an ordinary account keep as many private views as they like", () => {
        expect(() => madeBy(PLAIN)).not.toThrow();
    });

    it("refuses an ordinary account sharing one it already owns", () => {
        const id = madeBy(PLAIN).id;

        expect(() => updateSavedFilter(id, { visibility: "shared" }, PLAIN)).toThrow(
            AuthorizationError
        );
    });

    /** Otherwise a demoted administrator leaves something shared that nobody can withdraw. */
    it("lets any owner withdraw their own shared view", () => {
        const id = madeBy(ME, { name: "Was shared", visibility: "shared" }).id;

        expect(updateSavedFilter(id, { visibility: "private" }, asUser("me")).visibility).toBe(
            "private"
        );
    });

    /** Where a curated view sits, per person — the same rule playlists follow. */
    describe("pinning, per viewer", () => {
        const curated = (): string =>
            madeBy(ME, { name: "Family", visibility: "shared", pinned: true }).id;

        const seenBy = (id: string, who: AuthContext) =>
            listSavedFilters(who).find((row) => row.id === id);

        it("puts a curated view in everybody's sidebar", () => {
            const id = curated();

            expect(seenBy(id, SOMEONE_ELSE)?.pinned).toBe(true);
            expect(seenBy(id, SOMEONE_ELSE)?.curated).toBe(true);
        });

        it("lets somebody take it out of theirs, and leaves everyone else alone", () => {
            const id = curated();

            setSavedFilterPin(id, false, SOMEONE_ELSE);

            expect(seenBy(id, SOMEONE_ELSE)?.pinned).toBe(false);
            expect(seenBy(id, ME)?.pinned).toBe(true);
        });

        it("follows the house again when the decision is cleared", () => {
            const id = curated();

            setSavedFilterPin(id, false, SOMEONE_ELSE);
            setSavedFilterPin(id, null, SOMEONE_ELSE);

            expect(seenBy(id, SOMEONE_ELSE)?.pinned).toBe(true);
        });

        it("refuses a pin on a view the viewer cannot see", () => {
            const id = madeBy(ME, { name: "Private" }).id;

            expect(() => setSavedFilterPin(id, true, SOMEONE_ELSE)).toThrow(NotFoundError);
        });
    });
});
