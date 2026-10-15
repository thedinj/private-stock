import {
    homeLayoutSchema,
    type BuiltinShelf,
    type HomeLayout,
    type HomeResponse,
    type MediaListItem,
    type MediaQuery,
    type ResolvedShelf,
    type Shelf,
} from "@private-stock/core";
import {
    db,
    homeLayoutRepo,
    mediaRepo,
    playlistRepo,
    savedFilterRepo,
    tagRepo,
} from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { createTtlCache } from "../ttlCache";
import { listMedia, toListPage } from "./mediaService";
import { queryCacheKey } from "./queryCacheKey";
import { findSavedQuery } from "./savedFilterService";
import { loadAdminSettings } from "./settingsService";

/**
 * The home page: several short rows, each a reference to something that produces items (§6).
 *
 * One request returns every shelf already filled. Four rows meant four round trips would show
 * the page assembling itself, which on a NAS over a slow link reads as broken rather than as
 * loading.
 *
 * Each shelf returns a few dozen rows at most, but what it *reads* to find them is another
 * matter on the NAS, where a statement costs the pages it touches (§20). Ordered shelves walk
 * an index and stop at their limit; a shuffled one cannot stop early, because a fair shuffle
 * has to see the whole matching set. So shuffled shelves draw from a cached sample instead of
 * walking the library on every visit (`sampleFor`), and the whole page is read under one
 * snapshot (`getHome`). Nothing else here caches.
 */

const BUILTIN_TITLES: Record<BuiltinShelf, string> = {
    recentlyViewed: "Recently viewed",
    recentlyAdded: "Recently added",
    topRated: "Top rated",
    favorites: "Favourites",
    random: "Something else",
};

/**
 * The library query behind each builtin shelf.
 *
 * Expressed as `MediaQuery` rather than as bespoke SQL so a shelf and the grid it leads to
 * cannot disagree about what "top rated" means. `recentlyViewed` is the exception and is
 * handled separately — it is a walk of one user's overlay table, not a filter over the
 * library.
 *
 * Videos only, as the grid opens (§14e "Videos unless you ask"): the "see all" each leads to
 * carries no kind, which is the videos, and a shelf of photos above a grid without them would
 * be the disagreement this table exists to prevent. Recently viewed stays mixed -- a photo in it
 * was one somebody opened.
 */
const BUILTIN_QUERIES: Record<Exclude<BuiltinShelf, "recentlyViewed">, Partial<MediaQuery>> = {
    recentlyAdded: { kind: "video", sort: "addedAt", direction: "desc" },
    // `minRating` excludes the unrated, which would otherwise fill a "top rated" row with
    // items nobody has judged.
    topRated: { kind: "video", sort: "rating", direction: "desc", minRating: 1 },
    favorites: { kind: "video", favorite: true, sort: "addedAt", direction: "desc" },
    random: { kind: "video", sort: "random" },
};

/**
 * How long a shuffled shelf keeps drawing from one sample, and how big the sample is.
 *
 * A shuffle reads every item the shelf's query matches -- an index walk the size of the
 * library, ~315 pages for the builtin shelf on the production replica (13k items) and growing
 * with it, where an ordered shelf reads a handful. Taking twenty shelves' worth from one
 * shuffle and drawing a fresh dozen from it on each visit keeps the shelf different every
 * time the page opens while paying for the walk once per ten minutes rather than per visit.
 *
 * What that costs: for up to ten minutes the sample can hold an item that has since stopped
 * matching the shelf's filter -- re-rated, re-tagged -- or miss one that has started. The
 * rules the grid enforces regardless of filter (listable, accessible, not hidden) are applied
 * again on every draw by `listByIds`, so a trashed or hidden item never shows.
 */
const SAMPLE_TTL_MS = 10 * 60_000;
const SAMPLE_SHELVES = 20;
/** Bounds the memory: a sample is a few hundred ids, and the oldest goes first. */
const samples = createTtlCache<string[]>(SAMPLE_TTL_MS, 64);

const sampleFor = (query: MediaQuery, auth: AuthContext, overlayUserId?: string): string[] =>
    samples.get(queryCacheKey(query, auth, overlayUserId), () =>
        mediaRepo.shuffledIds(
            query,
            auth.userId,
            auth.accessibleRootIds,
            query.limit * SAMPLE_SHELVES,
            Math.floor(Math.random() * 1_000_000),
            overlayUserId
        )
    );

/**
 * What a shuffled shelf dealt each visit, by the seed the page sent.
 *
 * The Room refetches while it is open -- on returning to it, and on every live update while the
 * worker is busy -- and a fresh draw on each of those swapped the row for another while somebody
 * was looking at it. A visit keeps one seed for as long as it shows the page (`LibraryRoom`), so
 * a refetch is answered with the same items, re-read for their current state, rather than a new
 * hand. Held apart from the sample because the sample is replaced every ten minutes and a hand
 * drawn from the next one would be a different row.
 *
 * An hour, after which an open page is dealt again; a dozen ids an entry.
 */
const DEALT_TTL_MS = 60 * 60_000;
const dealt = createTtlCache<string[]>(DEALT_TTL_MS, 256);

/** `count` of `ids` in a random order, without disturbing the cached array. */
const draw = (ids: string[], count: number): string[] => {
    const pool = [...ids];

    for (let i = 0; i < Math.min(count, pool.length); i++) {
        const j = i + Math.floor(Math.random() * (pool.length - i));

        [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    return pool.slice(0, count);
};

const runQuery = (
    partial: Partial<MediaQuery>,
    limit: number,
    auth: AuthContext,
    seed: number | undefined,
    overlayUserId?: string
): MediaListItem[] => {
    const query = {
        sort: "addedAt",
        direction: "desc",
        page: 0,
        ...partial,
        limit,
    } as MediaQuery;

    /**
     * A fresh draw per visit for a shuffled shelf.
     *
     * The grid holds its seed in the URL so paging stays stable; a shelf has no pages and is
     * meant to be different each time the page is opened, so it wants a new hand per visit --
     * and the same hand for every refetch within one (`dealt`).
     */
    if (query.sort === "random") {
        const deal = (): string[] => draw(sampleFor(query, auth, overlayUserId), limit);
        const ids =
            seed === undefined
                ? deal()
                : dealt.get(`${queryCacheKey(query, auth, overlayUserId)}:${seed}`, deal);

        return toListPage(
            mediaRepo.listByIds(ids, auth.userId, auth.accessibleRootIds),
            auth.userId
        );
    }

    return listMedia(query, auth, overlayUserId).items;
};

/** An empty shelf that says why it is empty, rather than a blank row with no explanation. */
const unavailable = (key: string, title: string, shelf: Shelf, reason: string): ResolvedShelf => ({
    key,
    title,
    shelf,
    items: [],
    unavailable: reason,
});

const resolveShelf = (
    shelf: Shelf,
    index: number,
    auth: AuthContext,
    seed: number | undefined
): ResolvedShelf => {
    if (shelf.source === "builtin") {
        const key = `${index}:builtin:${shelf.builtin}`;
        const title = shelf.title ?? BUILTIN_TITLES[shelf.builtin];

        const items =
            shelf.builtin === "recentlyViewed"
                ? toListPage(
                      mediaRepo.listRecentlyViewed(
                          auth.userId,
                          auth.accessibleRootIds,
                          shelf.limit
                      ),
                      auth.userId
                  )
                : runQuery(BUILTIN_QUERIES[shelf.builtin], shelf.limit, auth, seed);

        return { key, title, shelf, items, unavailable: null };
    }

    if (shelf.source === "filter") {
        const key = `${index}:filter:${shelf.filterId}`;
        const found = findSavedQuery(shelf.filterId, auth);

        /**
         * A filter that was shared and then made private again is reported exactly as a
         * deleted one, for the same reason a playlist is: from here the two are the same
         * fact, and telling them apart would say more about the owner than this viewer is
         * entitled to know.
         */
        if (!found) {
            return unavailable(
                key,
                shelf.title ?? "Saved filter",
                shelf,
                "This filter is no longer available"
            );
        }

        const title = shelf.title ?? found.row.name;
        /**
         * Validated, as the filter's own page validates it. A bare `JSON.parse` trusted the
         * stored shape, and a filter whose groups the schema now rejects would have reached
         * the SQL builder as whatever it happened to contain.
         */
        if (!found.query) {
            return unavailable(key, title, shelf, "This filter can no longer be read");
        }

        return {
            key,
            title,
            shelf,
            // Whose ratings this asks about is the filter's business, not the shelf's.
            items: runQuery(found.query, shelf.limit, auth, seed, found.overlayUserId),
            unavailable: null,
        };
    }

    if (shelf.source === "playlist") {
        const key = `${index}:playlist:${shelf.playlistId}`;
        const row = playlistRepo.findSummary(shelf.playlistId);

        /**
         * A playlist shared and then made private again leaves a shelf pointing at something
         * the viewer may no longer see. Reported the same way as a deleted one, because from
         * here the two are the same fact and distinguishing them would say more about the
         * owner's choices than this viewer is entitled to know.
         */
        if (!row || (row.ownerId !== auth.userId && row.visibility !== "shared")) {
            return unavailable(
                key,
                shelf.title ?? "Playlist",
                shelf,
                "This playlist is no longer available"
            );
        }

        const ids = playlistRepo.listItemIds(shelf.playlistId, shelf.limit, 0);

        return {
            key,
            title: shelf.title ?? row.name,
            shelf,
            items: toListPage(
                mediaRepo.listByIds(ids, auth.userId, auth.accessibleRootIds),
                auth.userId
            ),
            unavailable: null,
        };
    }

    const key = `${index}:tag:${shelf.tagId}`;
    const tag = tagRepo.findById(shelf.tagId);

    if (!tag) {
        return unavailable(key, shelf.title ?? "Tag", shelf, "This tag was deleted");
    }

    return {
        key,
        title: shelf.title ?? tag.name,
        shelf,
        // The videos, like the builtin shelves and like the grid its "see all" opens.
        items: runQuery(
            { kind: "video", tags: [shelf.tagId], sort: "addedAt", direction: "desc" },
            shelf.limit,
            auth,
            seed
        ),
        unavailable: null,
    };
};

const safeJson = (raw: string): unknown => {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

/**
 * The layout this account is using, and whether it is their own.
 *
 * A user with no row inherits the admin default *by reference*: the absence keeps tracking
 * the default as an admin changes it, where copying the default in at signup would freeze
 * every account on whatever it happened to be that day.
 */
const layoutFor = (auth: AuthContext): { layout: HomeLayout; isDefault: boolean } => {
    const own = homeLayoutRepo.find(auth.userId);

    if (own) {
        const parsed = homeLayoutSchema.safeParse(safeJson(own));

        if (parsed.success) {
            return { layout: parsed.data, isDefault: false };
        }
        // Falls through to the default. A layout that no longer parses is a home page that
        // cannot render at all, and an empty one would leave nothing to click to fix it.
    }

    return { layout: adminDefaultLayout(), isDefault: true };
};

/**
 * The default an admin set, through the one settings surface rather than a private key (§12b).
 *
 * `loadAdminSettings` already falls back to `DEFAULT_HOME_LAYOUT` for a missing or unreadable
 * value, so there is nothing to re-check here.
 */
const adminDefaultLayout = (): HomeLayout => loadAdminSettings().homeLayout;

/**
 * The most shelves a home page may carry, layout and pinned filters together.
 *
 * `homeLayoutSchema` already caps a stored layout at 20. Appending to it could exceed that,
 * and a home page of forty rows is a scroll rather than a front door — so the same limit
 * applies to the result, not only to the part of it somebody typed.
 */
const MAX_SHELVES = 20;

/**
 * Pinned saved filters, as shelves (§14b).
 *
 * Pinning is one gesture with one meaning: this is a way of looking at the library that I
 * reach for. The sidebar honours it by listing the filter, and the front door honours it by
 * showing what is in it. Requiring a second, separate act to put a filter on Home would make
 * "pinned" mean two different things depending on which surface you asked.
 *
 * Appended rather than merged into the stored layout, and skipped where the layout already
 * names the filter. An explicit entry is somebody's arrangement -- their title, their limit,
 * their position -- and it must win over one generated from a flag.
 *
 * Only the viewer's own pinned filters. `pinned` lives on the filter rather than per viewer,
 * so a filter shared by someone else carries *their* pin, and inheriting it would rearrange
 * your front door because somebody else tidied theirs.
 */
const pinnedFilterShelves = (layout: HomeLayout, auth: AuthContext): Shelf[] => {
    const alreadyPlaced = new Set(
        layout.filter((shelf) => shelf.source === "filter").map((shelf) => shelf.filterId)
    );

    return savedFilterRepo
        .listVisibleTo(auth.userId)
        .filter(
            (row) => row.pinned === 1 && row.userId === auth.userId && !alreadyPlaced.has(row.id)
        )
        .sort((left, right) => left.position - right.position)
        .map((row): Shelf => ({ source: "filter", filterId: row.id, limit: 12 }));
};

/**
 * Every shelf, read inside one deferred transaction (§20).
 *
 * Not for consistency — for the page cache. In WAL mode SQLite discards a connection's whole
 * cache at the start of any read transaction that finds the database changed since its last
 * one, and outside a transaction every statement is its own. With the worker committing
 * several times a second, each shelf began from an empty cache and re-read from disk the index
 * levels, overlay rows and tile joins the shelf before it had just read; under one snapshot
 * they are read once. Deferred, never the web process's default `IMMEDIATE` (db.ts): a read
 * must not take the write lock. Holding the snapshot only delays a checkpoint past this point,
 * for as long as the page takes to build.
 */
export const getHome = (auth: AuthContext, seed?: number): HomeResponse =>
    db
        .transaction((): HomeResponse => {
            const { layout, isDefault } = layoutFor(auth);
            const shelves = [...layout, ...pinnedFilterShelves(layout, auth)].slice(0, MAX_SHELVES);

            return {
                shelves: shelves.map((shelf, index) => resolveShelf(shelf, index, auth, seed)),
                isDefault,
            };
        })
        .deferred();

export const saveHomeLayout = (layout: HomeLayout, auth: AuthContext): void => {
    homeLayoutRepo.save(auth.userId, JSON.stringify(layout));
};

/** Going back to the inherited default, which is deleting the row rather than copying it in. */
export const resetHomeLayout = (auth: AuthContext): void => {
    homeLayoutRepo.clear(auth.userId);
};
