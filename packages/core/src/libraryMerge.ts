import { ROWID_SHUFFLE_PRIME, rowidShuffleParams, shuffleSlot } from "./shuffle.js";

/**
 * All, as one list: the library's items with the viewer's clips and stills slotted between them
 * (§14e "What a kind is", §20 "All, merged").
 *
 * The library is thousands of items, paged by an index walk; one person's clips and stills are
 * hundreds. So the small set is read whole, sorted here, and merged into a *window* of the walk:
 * the merged list's positions `[o, o + n)` can only hold items whose own rank is in
 * `[o − |small|, o + n)`, because at most `|small|` entries of the small set come before any of
 * them. One walk of that window -- the grid's own page walk, `|small|` rows longer -- and a count
 * of the small set ahead of its first row place it exactly.
 *
 * Pure, so the rule can be checked against a plain sort of everything (`libraryMerge.test.ts`).
 */

/** A sort key as SQLite compares it: NULL first, then numbers, then text. */
export type SortKey = number | string | null;

export interface Keyed {
    id: string;
    k: SortKey;
}

const rankOf = (key: SortKey): number => (key === null ? 0 : typeof key === "number" ? 1 : 2);

/** SQLite's NOCASE: ASCII letters folded, everything else compared as it is. */
const foldAscii = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** By code point, which is the order of SQLite's UTF-8 bytes; JS `<` compares UTF-16 units. */
const compareText = (a: string, b: string): number => {
    const left = [...a];
    const right = [...b];

    for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
        const diff = (left[i].codePointAt(0) ?? 0) - (right[i].codePointAt(0) ?? 0);

        if (diff !== 0) return diff;
    }

    return left.length - right.length;
};

export const compareKeys = (a: SortKey, b: SortKey, nocase: boolean): number => {
    const ranks = rankOf(a) - rankOf(b);

    if (ranks !== 0 || a === null || b === null) return ranks;
    if (typeof a === "number" && typeof b === "number") return a - b;

    return nocase
        ? compareText(foldAscii(String(a)), foldAscii(String(b)))
        : compareText(String(a), String(b));
};

/**
 * The library's order as one comparator: the key, then the id, both the same way round --
 * `ORDER BY k <dir>, m."id" <dir>`.
 */
export const entryOrder =
    (direction: "asc" | "desc", nocase: boolean) =>
    (a: Keyed, b: Keyed): number => {
        const sign = direction === "asc" ? 1 : -1;
        const byKey = compareKeys(a.k, b.k, nocase);

        return sign * (byKey !== 0 ? byKey : compareText(a.id, b.id));
    };

/**
 * A clip's or a still's place in a shuffle: the slot the library's own permutation gives its id,
 * hashed into the rowid range (FNV-1a), so a seed keeps one order however the page is turned.
 */
export const shuffleKey = (id: string, seed: number): number => {
    let hash = 0x811c9dc5;

    for (let i = 0; i < id.length; i += 1) {
        hash ^= id.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return shuffleSlot((hash % (ROWID_SHUFFLE_PRIME - 1)) + 1, rowidShuffleParams(seed));
};

export type MergedEntry<S> = { from: "media"; id: string } | { from: "small"; row: S };

/**
 * Where to start walking the library's order for merged positions `[offset, …)`.
 *
 * Never before the start, and never further back than the whole small set could reach.
 */
export const mediaWindowStart = (offset: number, smallCount: number): number =>
    Math.max(0, offset - smallCount);

/**
 * Merged positions `[offset, offset + count)`.
 *
 * `media` is the library's order from rank `mediaStart` on, as far as the walk went (a short walk
 * means the library ended); `small` is the whole small set, sorted by `order`.
 */
export const mergeWindow = <S extends Keyed>(
    media: Keyed[],
    mediaStart: number,
    small: S[],
    offset: number,
    count: number,
    order: (a: Keyed, b: Keyed) => number
): MergedEntry<S>[] => {
    let i = 0;
    let j = 0;
    let position = 0;

    if (mediaStart > 0) {
        // Everything before the window's first item is `mediaStart` items and the small set's
        // rows that sort ahead of it.
        const first = media[0];

        j =
            first === undefined
                ? small.length
                : small.filter((row) => order(row, first) < 0).length;
        position = mediaStart + j;
    }

    const out: MergedEntry<S>[] = [];

    while (out.length < count && (i < media.length || j < small.length)) {
        const takeMedia = i < media.length && (j >= small.length || order(media[i], small[j]) <= 0);

        if (position >= offset) {
            out.push(
                takeMedia ? { from: "media", id: media[i].id } : { from: "small", row: small[j] }
            );
        }

        if (takeMedia) i += 1;
        else j += 1;

        position += 1;
    }

    return out;
};
