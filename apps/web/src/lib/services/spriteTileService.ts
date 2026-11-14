import { readFile } from "node:fs/promises";

import sharp from "sharp";

import { NotFoundError, RateLimitError, type TileCrop } from "@private-stock/core";
import { artifactVersion } from "@private-stock/core/server";

import type { AuthContext } from "../auth/withAuth";
import { centreSquare } from "../spriteCrop";
import { resolveArtifact } from "./artService";
import { spriteTileAtIndex } from "./spriteThumb";

/**
 * One sprite tile, cut out of its sheet and served as a picture of its own (§5e).
 *
 * The browser used to be handed the whole sheet and a rectangle to show. A sheet is 2000 px
 * wide, so each tile that did so held ~9 MB of decoded bitmap -- ~28 MB for an upright video --
 * to paint a 112 px square, and a page of sixty matched moments was half a gigabyte of decodes.
 * Cut here, the square is a few KB and decodes as one.
 *
 * **No cache of its own.** The URL names the sheet's version and the tile, so it is the exact
 * bytes and the browser keeps it for a year. A second viewer asking for the same tile costs one
 * more cut, which is the sheet read the browser's request would have cost anyway.
 *
 * **One cut at a time.** Each runs on libuv's thread pool, the same four threads that `stat` and
 * read every cover the grid is asking for in the same moment; sixty at once would queue the
 * covers behind them. A cut is a 50 KB read and a decode, so a page's worth finishes quickly in
 * line. The line is bounded so that a script cannot grow it without limit.
 */

const MAX_WAITING = 240;

type TileRect = NonNullable<ReturnType<typeof spriteTileAtIndex>>["rect"];

/**
 * Each crop's rectangle within the tile. A record over every `TileCrop`, so a shape added to the
 * schema is a compile error here until it says how it is cut.
 */
const CROPS: Record<TileCrop, (rect: TileRect) => TileRect> = {
    square: centreSquare,
};

let tail: Promise<unknown> = Promise.resolve();
let waiting = 0;

const inLine = <T>(work: () => Promise<T>): Promise<T> => {
    if (waiting >= MAX_WAITING) {
        throw new RateLimitError("Too many pictures asked for at once. Try again in a moment.", 2);
    }

    waiting += 1;

    const run = tail.then(work).finally(() => {
        waiting -= 1;
    });

    // The next in line waits for this one to finish, not to succeed.
    tail = run.catch(() => undefined);

    return run;
};

export interface TileImage {
    bytes: Buffer;
    /** Whether the URL carried the version of the sheet the tile was cut from. */
    versioned: boolean;
}

/**
 * The tile at `index` across an item's sheets, cut to `crop`.
 *
 * Visibility, the path's safety and the sheet's existence are the art route's own checks
 * (`resolveArtifact`), asked of the sheet the tile is on.
 */
export const tileImage = async (
    mediaId: string,
    index: number,
    crop: TileCrop,
    requestedVersion: string | null,
    auth: AuthContext
): Promise<TileImage> => {
    const tile = spriteTileAtIndex(mediaId, index);

    // The same answer as an item that cannot be seen: the sheet's absence says nothing more.
    if (!tile || tile.rect.height <= 0) {
        throw new NotFoundError("Artifact not found");
    }

    const sheet = await resolveArtifact(mediaId, `sprite-${tile.ordinal}`, null, auth);
    const area = CROPS[crop](tile.rect);
    // Inside the sheet, whatever the rounding: a tile's height is the sheet's tenth rounded, so
    // the last row of a 1125 px sheet would otherwise end at 1130, and `extract` refuses that.
    const left = Math.max(0, Math.round(area.x));
    const top = Math.max(0, Math.round(area.y));
    const width = Math.min(Math.round(area.width), area.sheetWidth - left);
    const height = Math.min(Math.round(area.height), area.sheetHeight - top);

    if (width <= 0 || height <= 0) {
        throw new NotFoundError("Artifact not found");
    }

    // Read here and handed over as bytes: given a path, libvips keeps the file open in its cache,
    // which holds a purged sheet's handle and, on Windows, stops it being deleted at all.
    const bytes = await inLine(async () =>
        sharp(await readFile(sheet.absolutePath))
            .extract({ left, top, width, height })
            .webp({ quality: 80 })
            .toBuffer()
    );

    return {
        bytes,
        versioned: requestedVersion === artifactVersion(tile.relPath, tile.generatedAt),
    };
};
