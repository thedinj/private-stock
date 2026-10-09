import { PAGE_SIZE } from "./libraryQuery";

/**
 * Where an item sits in the set the viewer arrived from, and what is either side of it (§14b).
 *
 * The item page used to be a dead end: one way in, one way out. Moving through the library
 * meant going back to the grid between every item, which on a phone is two taps to undo one.
 *
 * The set is the filtered, sorted library the grid was showing — not the whole library, and
 * not the page you happened to be on. That address is already recorded for the back link, so
 * the query that produced the set is known; this works out the arithmetic on top of it.
 *
 * Pure, so the awkward parts — the edges of a page, the ends of the library, an item that is
 * no longer in the set at all — can be tested without a browser.
 */

export interface Neighbours {
    /** The item before this one, or null at the very start of the set. */
    previousId: string | null;
    /** The item after this one, or null at the very end. */
    nextId: string | null;
    /**
     * One-based position across the whole set, or null when it cannot be known.
     *
     * Null rather than a guess. "23 of 312" is a claim about the whole filtered library, and
     * an item that is not on the page it was supposed to be on cannot support it.
     */
    position: number | null;
}

export interface SequenceInput {
    /** Ids on the page the viewer came from, in the order the grid showed them. */
    pageIds: string[];
    /** Zero-based index of that page within the set. */
    page: number;
    /** Ids of the page before, if it has been fetched. Empty when there is none or it is unknown. */
    previousPageIds?: string[];
    /** Ids of the page after, likewise. */
    nextPageIds?: string[];
    /** The item being viewed. */
    currentId: string;
    /**
     * Items per page in this set. The grid's sixty unless said otherwise — the showcase pages
     * in two hundreds, and positions counted in sixties there are simply wrong (§14f).
     */
    pageSize?: number;
}

/**
 * The neighbours of `currentId` within the set.
 *
 * Crossing a page boundary is the whole reason this is not `array[index ± 1]`. The grid pages
 * at sixty, and the last item of page 3 has its successor on page 4 — a viewer stepping
 * through a library must not stop every sixtieth item.
 *
 * An unknown adjacent page yields `null` rather than an optimistic guess, so the control is
 * simply absent until the page it would lead to has arrived. A next button that does nothing
 * is worse than one that is not there yet.
 */
export const neighbours = ({
    pageIds,
    page,
    previousPageIds,
    nextPageIds,
    currentId,
    pageSize = PAGE_SIZE,
}: SequenceInput): Neighbours => {
    const index = pageIds.indexOf(currentId);

    /**
     * The item is not in the set.
     *
     * Reachable in ordinary use: open the only unrated item from "Unrated only", rate it, and
     * the set it came from no longer contains it. Reporting no neighbours is the honest answer
     * — there is no "next" in a set this item has left — and the page falls back to its link
     * home.
     */
    if (index === -1) {
        return { previousId: null, nextId: null, position: null };
    }

    const previousId =
        index > 0
            ? pageIds[index - 1]
            : page > 0 && previousPageIds && previousPageIds.length > 0
              ? (previousPageIds[previousPageIds.length - 1] ?? null)
              : null;

    const nextId =
        index < pageIds.length - 1
            ? pageIds[index + 1]
            : nextPageIds && nextPageIds.length > 0
              ? (nextPageIds[0] ?? null)
              : null;

    return {
        previousId,
        nextId,
        position: page * pageSize + index + 1,
    };
};

/**
 * Which page of the set `id` is on, among the pages held — or null when none of them has it.
 *
 * Asked as the viewer steps, so the recorded address can follow it onto the next page: without
 * that, the item after a page boundary is looked for on the page before it, is not found, and
 * the viewer loses its place in the set — no next, no previous, nothing warmed.
 */
export const pageOfId = (
    { pageIds, page, previousPageIds, nextPageIds }: Omit<SequenceInput, "currentId">,
    id: string
): number | null => {
    if (pageIds.includes(id)) return page;
    if (nextPageIds?.includes(id)) return page + 1;
    if (previousPageIds?.includes(id)) return page - 1;

    return null;
};

/**
 * Which adjacent pages this position needs.
 *
 * Asked before fetching, so the viewer requests a neighbouring page only when standing on an
 * edge. Stepping through the middle of a page costs nothing, and the page the viewer came
 * from is usually already in the cache the grid filled.
 *
 * **Whether there is a next page is the server's `hasMore`, never the page's length.** It
 * used to be "the page is full", which is true of a sorted library and false of a shuffled
 * playlist, whose pages can come back short in the middle -- so the viewer stopped at the end
 * of the first short page and the rest of the set was unreachable from it.
 */
export const adjacentPagesNeeded = (
    pageIds: string[],
    page: number,
    currentId: string,
    hasMore: boolean
): { previous: boolean; next: boolean } => {
    const index = pageIds.indexOf(currentId);

    if (index === -1) {
        return { previous: false, next: false };
    }

    return {
        previous: index === 0 && page > 0,
        next: index === pageIds.length - 1 && hasMore,
    };
};

/**
 * Which answer to hold for the page this item is on, or undefined to wait for another.
 *
 * `fresh` is the page as the cache has it now and `settled` whether it has finished being asked
 * again; `remembered` is the same page as it was held for an earlier item. An answer that has
 * this item in it wins, so arriving is instant whenever the cache already knows the item. The
 * remembered one is what keeps an item that has **left the set** walkable: stepping back onto
 * the one just tagged out of "Untagged", every fresh answer has dropped it and only the page held
 * a step ago still knows what was either side of it. With neither, the settled answer is held
 * anyway -- the item is genuinely not in the set, and saying so beats waiting forever.
 */
export const pickHeldPage = <T extends { ids: string[] }>(
    fresh: T | undefined,
    settled: boolean,
    remembered: T | undefined,
    currentId: string
): T | undefined => {
    if (fresh?.ids.includes(currentId)) return fresh;
    if (remembered?.ids.includes(currentId)) return remembered;

    return settled ? fresh : undefined;
};

/**
 * The ids after this one, continuing into the next page when it is held.
 *
 * An item that has left the set has nothing after it: slicing from an index of -1 would show
 * the start of the page as though it were what came next.
 */
export const upcomingIds = (
    pageIds: string[],
    nextPageIds: string[] | undefined,
    currentId: string,
    count: number
): string[] => {
    const index = pageIds.indexOf(currentId);

    if (index === -1) return [];

    return [...pageIds.slice(index + 1), ...(nextPageIds ?? [])].slice(0, count);
};
