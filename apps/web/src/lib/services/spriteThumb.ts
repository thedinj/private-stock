import {
    SPRITE_COLUMNS,
    SPRITE_TILE_WIDTH,
    TILES_PER_SHEET,
    type ArtifactKind,
} from "@private-stock/core";
import { artifactRepo } from "@private-stock/db";

import { artifactUrl } from "./artService";

/**
 * A picture of a clip, for free (§14d).
 *
 * A span in a list is a pair of timecodes, and a page of two hundred of them is unreadable. It
 * needs a face — and one already exists, on disk, for every video in the library: the scrubber's
 * sprite sheet carries a tile every few seconds and §9 pays for it whether or not anything else
 * uses it. So a clip's thumbnail costs **no ffmpeg, no `Artifact` row, no disk and nothing for
 * `db:reset` to clear**. It is a `background-position` into a sheet the browser has very likely
 * fetched already for the scrubber on the same item.
 *
 * The tile is found by arithmetic rather than by reading the VTT. `cueAt` exists and is right
 * for the player, which has already downloaded the cues to draw its filmstrip; doing the same
 * here would mean reading a file per row to render a list. The `Artifact` row records the
 * interval and the tile count, and the grid is fixed (§9 keeps `SPRITE_COLUMNS * SPRITE_ROWS`
 * equal to the target), so the sheet and the rectangle follow from a division.
 */

export interface SpriteThumb {
    url: string;
    rect: {
        x: number;
        y: number;
        width: number;
        height: number;
        sheetWidth: number;
        sheetHeight: number;
    };
}

export interface SpriteTileFile {
    ordinal: number;
    relPath: string;
    generatedAt: string;
    intervalMs: number;
    rect: SpriteThumb["rect"];
}

const SPRITE: ArtifactKind = "sprite";

/**
 * Where in the sheets the frame nearest `atMs` sits, or null when there is no sprite.
 *
 * Null is ordinary rather than a fault: a freshly scanned item has no sheet until the `sprite`
 * stage runs, and an image never gets one. Callers fall back to the item's cover.
 */
export const spriteThumbFor = (mediaId: string, atMs: number): SpriteThumb | null => {
    const tile = spriteTileFile(mediaId, atMs);

    return (
        tile && {
            url: artifactUrl(mediaId, `sprite-${tile.ordinal}`, tile.relPath, tile.generatedAt),
            rect: tile.rect,
        }
    );
};

/**
 * The tile nearest `atMs` as a file on disk: its sheet, the rectangle in it, and the interval
 * the sheets were sampled at -- for reading the tile itself rather than drawing it.
 */
export const spriteTileFile = (mediaId: string, atMs: number): SpriteTileFile | null => {
    const sheets = artifactRepo
        .listForMedia(mediaId, [SPRITE])
        .sort((left, right) => left.ordinal - right.ordinal);

    if (sheets.length === 0) {
        return null;
    }

    const [first] = sheets;
    const intervalMs = first.intervalMs ?? 0;

    if (intervalMs <= 0) {
        return null;
    }

    // Clamped to the tiles that exist: a clip at the very end of a file can round past the last
    // frame that was sampled, and a rectangle off the edge of the sheet is a blank square.
    const total = sheets.reduce((sum, sheet) => sum + (sheet.tileCount ?? 0), 0);
    const index = Math.min(Math.max(0, Math.floor(atMs / intervalMs)), Math.max(0, total - 1));

    const sheet = sheets[Math.floor(index / TILES_PER_SHEET)];

    if (!sheet) {
        return null;
    }

    const within = index % TILES_PER_SHEET;
    const tileWidth = SPRITE_TILE_WIDTH;
    // The sheet's own aspect: tiles are scaled to a fixed width, so the height follows from it.
    const tileHeight = sheet.height && sheet.width ? Math.round(sheet.height / SPRITE_COLUMNS) : 0;

    return {
        ordinal: sheet.ordinal,
        relPath: sheet.relPath,
        generatedAt: sheet.generatedAt,
        intervalMs,
        rect: {
            x: (within % SPRITE_COLUMNS) * tileWidth,
            y: Math.floor(within / SPRITE_COLUMNS) * tileHeight,
            width: tileWidth,
            height: tileHeight,
            sheetWidth: sheet.width ?? tileWidth * SPRITE_COLUMNS,
            sheetHeight: sheet.height ?? tileHeight * SPRITE_COLUMNS,
        },
    };
};
