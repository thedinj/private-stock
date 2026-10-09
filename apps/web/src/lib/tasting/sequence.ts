import type { MediaListItem } from "@private-stock/core";

/**
 * Walking the tasting's set, one item at a time, round and round (§14g).
 *
 * The set is the showcase's: the library's filter and order, in pages of two hundred. A
 * position is a page and an index within it, never a global index -- a shuffled page can come
 * back short in the middle of the library (see `mediaListResponseSchema.hasMore`), so a global
 * index would point at the wrong item after the first short page. The end of the set is the
 * page that says `hasMore: false`, and nothing else.
 *
 * **What is tasted is what can be shown.** An image always; a video only when the browser can
 * play what will be served (`directPlay`), and not once it has failed on this visit. Skipping
 * is the tasting's rule and deliberately not the viewer's: the viewer is a position in the set
 * you chose and has to stop on every item, while a tasting is a sequence of moments and an
 * item with nothing to play contributes none.
 *
 * Pure: the stage holds the pages and the ids that failed, and asks.
 */

export interface TastingPage {
    items: readonly MediaListItem[];
    hasMore: boolean;
    /** For a look's set, where each item matched, in ms by id (§5e); absent otherwise. */
    moments?: Readonly<Record<string, number>>;
}

export type Pages = ReadonlyMap<number, TastingPage>;

export interface Position {
    page: number;
    index: number;
}

/**
 * Where to look from.
 *
 * - `start`: the first tastable item, the first item included.
 * - `step`: the next or previous tastable item after `from`, not including it.
 * - `anchor`: the item with this id on this page, or the one after it if it cannot be tasted;
 *   the start of the page if the id is no longer there. How a return from the viewer lands.
 */
export type Cursor =
    | { kind: "start" }
    | { kind: "step"; from: Position; direction: 1 | -1 }
    | { kind: "anchor"; page: number; itemId: string };

export type Seek =
    | { kind: "found"; position: Position; item: MediaListItem }
    /** The answer is on a page that has not arrived. Nothing else can be said until it does. */
    | { kind: "need"; page: number }
    /**
     * Nothing can be found: a whole lap without a tastable item, or an empty set, or a step back
     * from the very first item before the end of the set is known.
     */
    | { kind: "none" };

export const tastable = (item: MediaListItem, failed: ReadonlySet<string>): boolean => {
    if (failed.has(item.id)) {
        return false;
    }

    // Written as "an image, or a video that plays" so that a third kind added later is skipped
    // rather than handed to a player that cannot show it.
    return item.kind === "image" || (item.kind === "video" && item.directPlay);
};

/** The last page of the set, once a page has said so. */
export const lastPage = (pages: Pages): number | null => {
    for (const [page, data] of pages) {
        if (!data.hasMore) {
            return page;
        }
    }

    return null;
};

type Step = { kind: "at"; position: Position } | { kind: "need"; page: number } | { kind: "none" };

/**
 * One position onward or back, wrapping at the ends.
 *
 * Positions past the items a page holds are skipped rather than landed on: an empty page that
 * still says `hasMore` is a gap in a shuffle, not the end. `hops` counts the empty pages crossed,
 * so a set whose every loaded page is empty ends the walk instead of circling it.
 */
const move = (pages: Pages, from: Position, direction: 1 | -1, hops = 0): Step => {
    if (hops > pages.size) {
        return { kind: "none" };
    }

    const data = pages.get(from.page);

    if (!data) {
        return { kind: "need", page: from.page };
    }

    if (direction === 1) {
        if (from.index + 1 < data.items.length) {
            return { kind: "at", position: { page: from.page, index: from.index + 1 } };
        }

        const page = data.hasMore ? from.page + 1 : 0;
        const next = pages.get(page);

        if (!next) {
            return { kind: "need", page };
        }

        return next.items.length > 0
            ? { kind: "at", position: { page, index: 0 } }
            : move(pages, { page, index: -1 }, 1, hops + 1);
    }

    if (from.index - 1 >= 0 && from.index - 1 < data.items.length) {
        return { kind: "at", position: { page: from.page, index: from.index - 1 } };
    }

    let page: number;

    if (from.page > 0) {
        page = from.page - 1;
    } else {
        // Round to the end, which is only somewhere once a page has said it is the last.
        const last = lastPage(pages);

        if (last === null) {
            return { kind: "none" };
        }

        page = last;
    }

    const previous = pages.get(page);

    if (!previous) {
        return { kind: "need", page };
    }

    return previous.items.length > 0
        ? { kind: "at", position: { page, index: previous.items.length - 1 } }
        : move(pages, { page, index: 0 }, -1, hops + 1);
};

const same = (a: Position, b: Position): boolean => a.page === b.page && a.index === b.index;

/**
 * Walks from `origin` until something can be tasted.
 *
 * `inclusive` checks `origin` itself first. Otherwise the origin is checked last, on the way
 * round -- so a set of one playable item finds that item again, which is what a loop of one
 * should do. Either way, arriving at the origin a second time ends the lap empty-handed.
 */
const walk = (
    pages: Pages,
    origin: Position,
    direction: 1 | -1,
    inclusive: boolean,
    failed: ReadonlySet<string>
): Seek => {
    let position = origin;

    if (!inclusive) {
        const first = move(pages, origin, direction);

        if (first.kind !== "at") {
            return first;
        }

        position = first.position;
    }

    // Bounded by the items loaded, plus slack for empty pages: a lap cannot be longer. A safety
    // net only -- arriving back at the origin is what ends a fruitless lap.
    let budget = 2;

    for (const data of pages.values()) {
        budget += data.items.length + 1;
    }

    for (let first = true; budget > 0; budget -= 1, first = false) {
        const item = pages.get(position.page)?.items[position.index];

        if (item && tastable(item, failed)) {
            return { kind: "found", position, item };
        }

        // The origin, checked: either the walk began there or it has come all the way round.
        if (same(position, origin) && !(inclusive && first)) {
            return { kind: "none" };
        }

        const next = move(pages, position, direction);

        if (next.kind !== "at") {
            return next;
        }

        position = next.position;

        // Round to an origin that was checked at the very start.
        if (inclusive && same(position, origin)) {
            return { kind: "none" };
        }
    }

    return { kind: "none" };
};

export const seek = (cursor: Cursor, pages: Pages, failed: ReadonlySet<string>): Seek => {
    if (cursor.kind === "step") {
        return walk(pages, cursor.from, cursor.direction, false, failed);
    }

    const page = cursor.kind === "anchor" ? cursor.page : 0;
    const data = pages.get(page);

    if (!data) {
        return { kind: "need", page };
    }

    if (data.items.length === 0) {
        // The first page, empty and the last: there is no set.
        if (page === 0 && !data.hasMore) {
            return { kind: "none" };
        }

        // A gap in a shuffle, or an anchor on a page the set has since shrunk away from: on from
        // just before it, which wraps to the start if this was the end.
        return walk(pages, { page, index: -1 }, 1, false, failed);
    }

    const anchored =
        cursor.kind === "anchor" ? data.items.findIndex((item) => item.id === cursor.itemId) : -1;

    return walk(pages, { page, index: Math.max(0, anchored) }, 1, true, failed);
};
