/**
 * The showcase's mosaic: justified rows, the way a photo wall is hung (§14f).
 *
 * Every tile keeps its video's own shape, and each row is scaled until it spans the width
 * exactly. Rows vary in height a little, and that variation is most of what makes the wall
 * read as a collection rather than as a spreadsheet of thumbnails.
 *
 * Pure, and run once per fetched page rather than across the whole library: a page of two
 * hundred items is laid out as one independent block, so the layout of item 19,000 never
 * depends on having laid out the 18,999 before it.
 */

/** Narrowest and widest shape a tile may take. Past these a row fills with slivers or bands. */
export const MIN_ASPECT = 0.6;
export const MAX_ASPECT = 2.2;

const DEFAULT_ASPECT = 16 / 9;

/**
 * How far a row may grow past the target before it is folded into the one above.
 *
 * Only the last row of a block can fall short, and stretching it to the full width would turn
 * two leftover tiles into a band three times the height of everything around it.
 */
const MAX_STRETCH = 1.6;

export interface JustifiedTile {
    /** Index into the block's items. */
    index: number;
    x: number;
    width: number;
}

export interface JustifiedRow {
    /** Top of the row, relative to the top of its block. */
    y: number;
    height: number;
    tiles: JustifiedTile[];
}

export interface JustifiedBlock {
    rows: JustifiedRow[];
    /** Including the gap under the last row, so consecutive blocks butt together evenly. */
    height: number;
}

/** A tile's shape, from the source's dimensions, clamped so no row fills with slivers. */
export const tileAspect = (width: number | null, height: number | null): number => {
    if (!width || !height || width <= 0 || height <= 0) {
        return DEFAULT_ASPECT;
    }

    return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, width / height));
};

const rowHeightFor = (aspectSum: number, count: number, width: number, gap: number): number =>
    (width - gap * (count - 1)) / aspectSum;

export const justify = (
    aspects: number[],
    width: number,
    targetHeight: number,
    gap: number
): JustifiedBlock => {
    if (aspects.length === 0 || width <= 0 || targetHeight <= 0) {
        return { rows: [], height: 0 };
    }

    // Group first, place afterwards: folding a short last row into its neighbour changes that
    // neighbour's height, so no row's position is final until every row's membership is.
    const groups: number[][] = [];
    let current: number[] = [];
    let aspectSum = 0;

    aspects.forEach((aspect, index) => {
        current.push(index);
        aspectSum += aspect;

        if (aspectSum * targetHeight + gap * (current.length - 1) >= width) {
            groups.push(current);
            current = [];
            aspectSum = 0;
        }
    });

    if (current.length > 0) {
        const lastHeight = rowHeightFor(aspectSum, current.length, width, gap);
        const previous = groups[groups.length - 1];

        if (lastHeight > targetHeight * MAX_STRETCH && previous) {
            previous.push(...current);
        } else {
            groups.push(current);
        }
    }

    const rows: JustifiedRow[] = [];
    let y = 0;

    for (const group of groups) {
        const sum = group.reduce((total, index) => total + aspects[index], 0);
        const natural = rowHeightFor(sum, group.length, width, gap);
        // Only a block too small to fold anything into can still be short here. It keeps a
        // sane height and sits centred rather than stretching into a banner.
        const height = Math.min(natural, targetHeight * MAX_STRETCH);
        const used = sum * height + gap * (group.length - 1);
        let x = (width - used) / 2;

        const tiles = group.map((index) => {
            const tileWidth = aspects[index] * height;
            const tile = { index, x, width: tileWidth };

            x += tileWidth + gap;

            return tile;
        });

        rows.push({ y, height, tiles });
        y += height + gap;
    }

    return { rows, height: y };
};
