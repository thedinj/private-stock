import type { MediaQuery } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";
import { createTtlCache } from "../ttlCache";
import { STRIP_COUNT, coverCandidates, coverMosaics } from "./coverMosaic";
import { listMediaIdsPage } from "./mediaService";
import { queryCacheKey } from "./queryCacheKey";
import { findSavedQuery } from "./savedFilterService";

/**
 * A saved view's face: a few covers from the first of what it answers (§14c).
 *
 * The same work a home shelf already does for every pinned view on every visit -- the view's
 * own query, first page, ids only, never counted -- two dozen ids, enough for a row's strip of
 * eight (§14c); the card takes four of them. An ordered query
 * walks an index and stops at its limit, so a face costs a handful of pages, and the client
 * asks only for the cards on screen (`ViewCard`).
 *
 * The ids are kept for ten minutes, as the home page keeps its shuffled samples, so browsing
 * back and forth across the collections page costs nothing after the first look. They are
 * hydrated again on every request through `listByIds`, which applies the rules the grid does --
 * listable, accessible, not hidden -- so a cached face never shows something trashed or hidden
 * since; it can only be a few minutes behind on what *newly* matches.
 */

const FACE_TTL_MS = 10 * 60_000;
/** Two dozen ids each; the bound is on how many views are remembered, oldest first. */
const faces = createTtlCache<string[]>(FACE_TTL_MS, 256);

/**
 * The query a face is drawn from.
 *
 * A shuffled view takes its newest items instead. Its face would otherwise change on every
 * look, and the point of a face is to be recognised -- and a shuffle cannot stop early, so it
 * would be the one view whose face read the whole matching set.
 */
const faceQuery = (query: Omit<MediaQuery, "page">): MediaQuery => ({
    ...query,
    ...(query.sort === "random" ? { sort: "addedAt", direction: "desc", seed: undefined } : {}),
    page: 0,
    limit: coverCandidates(STRIP_COUNT),
});

/**
 * Cover URLs for one saved view, or none.
 *
 * None rather than an error for a view this viewer cannot read or whose query no longer
 * parses: the card has a face to fall back on -- its terms -- and the view's own page is where
 * a broken one is reported.
 */
export const savedFilterCovers = (id: string, auth: AuthContext): string[] => {
    const found = findSavedQuery(id, auth);

    if (!found?.query) {
        return [];
    }

    const query = faceQuery(found.query);
    const ids = faces.get(
        queryCacheKey(query, auth, found.overlayUserId),
        () => listMediaIdsPage(query, auth, found.overlayUserId).ids
    );

    return coverMosaics([[id, ids]], auth, STRIP_COUNT).get(id) ?? [];
};
