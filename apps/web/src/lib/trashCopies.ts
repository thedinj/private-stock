import type { MediaCopy, MediaDetail } from "@private-stock/core";

/**
 * What the delete confirmation decides about an item's other copies (§10d).
 *
 * Pure, so the rules the dialog draws from can be tested without rendering it.
 */

/**
 * Whether a copy starts ticked.
 *
 * **Identical copies do.** Somebody deleting an item because they do not want it does not want
 * a byte-for-byte copy of it either, and a byte-identical file has nothing a closer look could
 * find. So Delete then Enter takes them too.
 *
 * **Except one with clips on it**, which starts unticked exactly as a triage row does when its
 * doomed copies hold some (§10c): clips are the one thing that neither moves nor comes back once
 * the bin is purged, and they are somebody's work.
 *
 * Every other copy starts unticked. A near duplicate may be the film a clip was cut from, or a
 * link at the far end of a chain of pairs (§10b); those are ticked by a person who has looked.
 */
export const tickedByDefault = (copy: MediaCopy): boolean =>
    copy.identical && copy.deletable && copy.clipCount === 0;

export interface TrashPlan {
    /** Copies going with the item. Only deletable ones, whatever was ticked. */
    alsoTrash: MediaCopy[];
    /**
     * No copy of it stays in the library: every copy the viewer can see is going, and there
     * are none in libraries they cannot.
     */
    noneLeft: boolean;
    /** The best copy is going while a worse one stays -- the mistake worth warning about. */
    bestGoing: boolean;
    /** Clips on the ticked copies, beyond the item's own. */
    clipsOnCopies: number;
}

export const planTrash = (
    duplicate: NonNullable<MediaDetail["duplicate"]>,
    copies: MediaCopy[],
    ticked: ReadonlySet<string>
): TrashPlan => {
    const alsoTrash = copies.filter((copy) => copy.deletable && ticked.has(copy.id));
    const staying = copies.length - alsoTrash.length;

    // `duplicate.copies` counts every copy with a file, this one included, in every root.
    const unseen = Math.max(0, duplicate.copies - 1 - copies.length);
    const noneLeft = staying === 0 && unseen === 0;

    const bestGoing = !noneLeft && (duplicate.best || alsoTrash.some((copy) => copy.best));

    return {
        alsoTrash,
        noneLeft,
        bestGoing,
        clipsOnCopies: alsoTrash.reduce((sum, copy) => sum + copy.clipCount, 0),
    };
};
