/**
 * Opening an item at the moment it matched a look (§5e "Three ways in, one way out").
 *
 * One definition for the tile, the viewer stepping through a look's set and the tasting, which
 * all open a match the same way.
 */

/** A second before the match, so it is seen arriving rather than already under way. */
export const MOMENT_LEAD_MS = 1_000;

/** The item page's address, opening at a match when there is one. */
export const itemHref = (mediaId: string, matchedAtMs: number | null): string =>
    matchedAtMs === null
        ? `/media/${mediaId}`
        : `/media/${mediaId}?at=${Math.max(0, matchedAtMs - MOMENT_LEAD_MS)}`;
