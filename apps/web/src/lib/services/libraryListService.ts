import {
    REEL_ITEM_LIMIT,
    entryOrder,
    librarySort,
    mediaWindowStart,
    mergeWindow,
    naturalDirection,
    shuffleKey,
    withSortOverride,
    type LibraryClipRun,
    type LibraryCountResponse,
    type LibraryEntry,
    type LibraryListResponse,
    type LibraryQuery,
    type MediaQuery,
    type MergedEntry,
} from "@private-stock/core";
import {
    libraryRepo,
    read,
    runOffThread,
    type ReadPlan,
    type SmallKeyRow,
    type SmallType,
} from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { clipsForLibrary } from "./clipService";
import { capturesForLibrary } from "./frameService";
import { countMediaReads, listMediaReads, listPage } from "./mediaService";
import { playableEntries } from "./reelService";

/**
 * The library's Clips, Stills and All tabs (§14e "What a kind is", §20 "All, merged").
 *
 * Videos and Photos are `/api/media` and are not touched by any of this. These three lists are
 * the viewer's clips and stills, filtered by the library's own query (`libraryRepo`), and -- for
 * All -- merged into the library's walk (`libraryMerge`).
 */

const typesFor = (tab: LibraryQuery["kind"]): SmallType[] =>
    tab === "clip" ? ["clip"] : tab === "capture" ? ["capture"] : ["clip", "capture"];

/**
 * The query as it is run: a sort every kind can answer, relevance only where there are words.
 */
const runnable = (asked: LibraryQuery): LibraryQuery => {
    const sort = asked.sort === "relevance" && !asked.search ? "addedAt" : librarySort(asked.sort);

    return sort === asked.sort ? asked : { ...asked, sort, direction: undefined };
};

/**
 * The library's half of All, or null when the tab or the query leaves the items out: "not in a
 * reel" asks something only a clip can be.
 */
const mediaHalf = (query: LibraryQuery): MediaQuery | null => {
    if (query.kind !== "all" || query.unusedOnly) {
        return null;
    }

    // `orVideo` and `unusedOnly` mean nothing to an item; no kind is videos and photos together.
    const { kind: _kind, orVideo: _orVideo, unusedOnly: _unused, ...rest } = query;

    return withSortOverride({ ...rest, kind: undefined });
};

interface Ordered {
    small: SmallKeyRow[];
    media: MediaQuery | null;
    order: ReturnType<typeof entryOrder>;
}

/** The small set, read whole and sorted by the rule the merge uses. */
const ordered = (asked: LibraryQuery, auth: AuthContext): Ordered => {
    const query = runnable(asked);
    const media = mediaHalf(query);
    // The library's half may have been re-sorted (an untagged list runs by date added), and the
    // two halves must agree on the order to be merged at all.
    const sort = media?.sort ?? query.sort;
    const direction = media?.direction ?? query.direction ?? naturalDirection(sort);
    const order = entryOrder(direction, sort === "title");
    const rows = libraryRepo.smallKeys(
        { ...query, sort },
        { userId: auth.userId, accessibleRootIds: auth.accessibleRootIds },
        sort,
        typesFor(query.kind)
    );
    const keyed =
        sort === "random"
            ? rows.map((row) => ({ ...row, k: shuffleKey(row.id, query.seed ?? 1) }))
            : sort === "relevance"
              ? // A name you gave a clip or a still is the closest match there is: first.
                rows.map((row) => ({ ...row, k: Number.MAX_SAFE_INTEGER }))
              : rows;

    return { small: [...keyed].sort(order), media, order };
};

function* listLibraryReads(
    asked: LibraryQuery,
    auth: AuthContext,
    overlayUserId?: string
): ReadPlan<LibraryListResponse> {
    const { small, media, order } = ordered(asked, auth);
    const { page, limit } = asked;
    const offset = page * limit;

    // Nothing of yours matches: All is the library's own list, kept orders and looks included.
    if (media !== null && small.length === 0) {
        const result = yield* listMediaReads({ ...media, page, limit }, auth, overlayUserId, true);

        return {
            items: result.items.map((item) => ({ type: "media", item })),
            page,
            pageSize: limit,
            hasMore: result.hasMore,
        };
    }

    let merged: MergedEntry<SmallKeyRow>[];

    if (media === null) {
        merged = small.slice(offset, offset + limit + 1).map((row) => ({ from: "small", row }));
    } else {
        const start = mediaWindowStart(offset, small.length);
        const keys = yield* read(
            "pageKeys",
            media,
            auth.userId,
            auth.accessibleRootIds,
            overlayUserId,
            offset + limit + 1 - start,
            start
        );

        merged = mergeWindow(keys, start, small, offset, limit + 1, order);
    }

    const shown = merged.slice(0, limit);
    const mediaIds = shown.flatMap((entry) => (entry.from === "media" ? [entry.id] : []));
    const smallOf = (type: SmallType) =>
        shown.flatMap((entry) =>
            entry.from === "small" && entry.row.type === type ? [entry.row.id] : []
        );

    const rows = mediaIds.length
        ? yield* read("listByIds", mediaIds, auth.userId, auth.accessibleRootIds)
        : [];
    const items = new Map((yield* listPage(rows, auth.userId)).map((item) => [item.id, item]));
    const clips = clipsForLibrary(smallOf("clip"), auth);
    const captures = capturesForLibrary(smallOf("capture"), auth);

    // In the merged order; an entry gone since it was keyed (trashed, deleted) is simply absent.
    const entries = shown.flatMap((entry): LibraryEntry[] => {
        if (entry.from === "media") {
            const item = items.get(entry.id);

            return item ? [{ type: "media", item }] : [];
        }

        if (entry.row.type === "clip") {
            const clip = clips.get(entry.row.id);

            return clip ? [{ type: "clip", clip }] : [];
        }

        const capture = captures.get(entry.row.id);

        return capture ? [{ type: "capture", capture }] : [];
    });

    return { items: entries, page, pageSize: limit, hasMore: merged.length > limit };
}

/** One page of a Clips, Stills or All tab. */
export const listLibraryOffThread = (
    query: LibraryQuery,
    auth: AuthContext,
    overlayUserId?: string
): Promise<LibraryListResponse> => runOffThread(listLibraryReads(query, auth, overlayUserId));

function* countLibraryReads(
    asked: LibraryQuery,
    auth: AuthContext,
    overlayUserId?: string
): ReadPlan<LibraryCountResponse> {
    const { small, media } = ordered(asked, auth);
    const clip = small.filter((row) => row.type === "clip").length;
    const capture = small.length - clip;
    const items =
        media === null ? 0 : (yield* countMediaReads(media, auth, overlayUserId, true)).total;
    const total = items + small.length;

    return {
        total,
        pageCount: Math.max(1, Math.ceil(total / asked.limit)),
        byType: { media: items, clip, capture },
    };
}

/** How many a Clips, Stills or All tab holds, by kind. */
export const countLibraryOffThread = (
    query: LibraryQuery,
    auth: AuthContext,
    overlayUserId?: string
): Promise<LibraryCountResponse> => runOffThread(countLibraryReads(query, auth, overlayUserId));

/**
 * The Clips tab from the top: its first reel's worth of clips in the tab's order, ready for the
 * reel player (§14e "Playing the small kinds").
 */
export const playClipsOffThread = async (
    query: LibraryQuery,
    auth: AuthContext,
    overlayUserId?: string
): Promise<LibraryClipRun> => {
    const page = await runOffThread(
        listLibraryReads(
            { ...query, kind: "clip", page: 0, limit: REEL_ITEM_LIMIT },
            auth,
            overlayUserId
        )
    );
    const clips = page.items.flatMap((entry) => (entry.type === "clip" ? [entry.clip] : []));
    const items = playableEntries(
        clips.map((clip, position) => ({ id: clip.id, position, clip })),
        auth
    );

    return {
        items,
        runningMs: items.reduce((sum, entry) => sum + entry.clip.runMs, 0),
        more: page.hasMore,
    };
};
