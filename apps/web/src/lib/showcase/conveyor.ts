/**
 * Where the showcase is looking, in a library that has no top or bottom (§14f).
 *
 * The position is a block and an offset into it, not a scroll offset. A native scroller
 * would need the height of everything above the viewport, which at 20,000 items means laying
 * out 20,000 items to show thirty — and it cannot wrap: there is no scroll position after the
 * last page that is also the first. Here block `k` shows page `k mod pageCount`, so drifting
 * past the end simply arrives at the start again, in either direction, with no seam to
 * special-case.
 *
 * Heights are only known for blocks that have been fetched and laid out. Everything here
 * treats an unknown height as a wall: the position may not cross it, and the caller is told
 * which block to fetch so that it stops being one.
 */

export interface ConveyorPosition {
    block: number;
    /** Pixels from the top of `block` to the top of the viewport. */
    offset: number;
}

export interface ConveyorSpan {
    /** Pages in the filtered set, or null until something has said how many. */
    pageCount: number | null;
    /** Whether block `pageCount` is page 0 again. */
    wrap: boolean;
}

/** A block's laid-out height, or undefined when it has not been fetched yet. */
export type HeightOf = (block: number) => number | undefined;

export interface PlacedBlock {
    block: number;
    /** Top of the block, relative to the top of the viewport. */
    top: number;
}

/**
 * Bound on how many blocks one walk may visit.
 *
 * Blocks are hundreds of pixels at the least, so this is never reached by an honest walk. It
 * is what stops a set of empty blocks from spinning forever, should a page ever come back empty
 * before the end.
 */
const MAX_STEPS = 256;

export const pageOfBlock = (block: number, span: ConveyorSpan): number =>
    span.wrap && span.pageCount
        ? ((block % span.pageCount) + span.pageCount) % span.pageCount
        : block;

export const blockExists = (block: number, span: ConveyorSpan): boolean => {
    if (span.wrap) {
        return true;
    }

    return block >= 0 && (span.pageCount === null || block < span.pageCount);
};

/**
 * Whether the set is long enough to go round.
 *
 * A set that fits on a screen or two, wrapped, shows the same tiles twice at once, which reads
 * as a rendering fault rather than as an endless wall. It sits still instead.
 */
export const shouldWrap = (
    pageCount: number | null,
    firstBlockHeight: number | undefined,
    viewport: number
): boolean =>
    pageCount !== null &&
    (pageCount > 1 || (firstBlockHeight !== undefined && firstBlockHeight >= viewport * 2));

/**
 * Move the anchor to the block the viewport's top edge is actually in, and keep the viewport
 * inside content that is known.
 */
export const normalize = (
    position: ConveyorPosition,
    heightOf: HeightOf,
    span: ConveyorSpan,
    viewport: number
): ConveyorPosition => {
    if (heightOf(position.block) === undefined) {
        return position;
    }

    let low = position.block;
    let high = position.block;
    let y = position.offset;
    let total = heightOf(position.block)!;
    let steps = 0;

    while (y < 0 && steps++ < MAX_STEPS) {
        const previous = low - 1;
        const height = blockExists(previous, span) ? heightOf(previous) : undefined;

        if (height === undefined) break;

        low = previous;
        y += height;
        total += height;
    }

    while (total < y + viewport && steps++ < MAX_STEPS) {
        const next = high + 1;
        const height = blockExists(next, span) ? heightOf(next) : undefined;

        if (height === undefined) break;

        high = next;
        total += height;
    }

    // Both walks stopped at a wall, so the known range is exactly [low, high] and the viewport
    // must lie inside it — flush with the top when the whole thing is shorter than a screen.
    y = Math.min(Math.max(0, y), Math.max(0, total - viewport));

    let block = low;

    while (block < high && y >= heightOf(block)!) {
        y -= heightOf(block)!;
        block += 1;
    }

    return { block, offset: y };
};

/**
 * The blocks overlapping the viewport, stretched by a margin either side, and the blocks that
 * would have been there had they been fetched.
 */
export const placeBlocks = (
    position: ConveyorPosition,
    heightOf: HeightOf,
    span: ConveyorSpan,
    viewport: number,
    before: number,
    after: number
): { blocks: PlacedBlock[]; missing: number[] } => {
    const anchorHeight = heightOf(position.block);

    if (anchorHeight === undefined) {
        return { blocks: [], missing: [position.block] };
    }

    // `+ 0` so an offset of zero places the block at 0 rather than at -0.
    const blocks: PlacedBlock[] = [{ block: position.block, top: -position.offset + 0 }];
    const missing: number[] = [];

    let top = -position.offset;
    let block = position.block;
    let steps = 0;

    while (top > -before && steps++ < MAX_STEPS) {
        const previous = block - 1;

        if (!blockExists(previous, span)) break;

        const height = heightOf(previous);

        if (height === undefined) {
            missing.push(previous);
            break;
        }

        top -= height;
        block = previous;
        blocks.unshift({ block, top });
    }

    let bottom = -position.offset + anchorHeight;

    block = position.block;

    while (bottom < viewport + after && steps++ < MAX_STEPS) {
        const next = block + 1;

        if (!blockExists(next, span)) break;

        const height = heightOf(next);

        if (height === undefined) {
            missing.push(next);
            break;
        }

        blocks.push({ block: next, top: bottom });
        bottom += height;
        block = next;
    }

    return { blocks, missing };
};
