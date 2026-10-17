import * as path from "node:path";

import {
    ValidationError,
    assertSafeRelativePath,
    spriteLayout,
    type FaceMoments,
} from "@private-stock/core";
import { dataPaths, loadConfig, readTileMoments } from "@private-stock/core/server";

import type { AuthContext } from "../auth/withAuth";
import { inFrameSlot } from "./frameSlot";
import { spriteTileFile } from "./spriteThumb";
import { readableOriginal } from "./tagPictureService";

/**
 * Which frame a video's face was really seen in (§9 "What a tile shows").
 *
 * Faces are found on sprite tiles, and a face's `atMs` is its tile's nominal moment, seldom the
 * frame the tile shows. `readTileMoments` reads the frames it may be and compares each with the
 * tile. Done here, when somebody asks, rather than as a sweep: correcting the stored moments
 * would mean reading every sprite again, days of the NAS, for the handful of faces anybody
 * frames a picture from or goes to.
 *
 * Under the frame ceiling (§9), as one frame: a few short reads of a few seconds of the file.
 */

/** Answers already worked out, by face moment: the same face is asked about again and again. */
const CACHE_SIZE = 32;
const cache = new Map<string, FaceMoments>();

const remember = (key: string, value: FaceMoments): FaceMoments => {
    cache.delete(key);
    cache.set(key, value);

    if (cache.size > CACHE_SIZE) {
        cache.delete(cache.keys().next().value!);
    }

    return value;
};

/** A sprite sheet's file, refusing anything that resolves outside `art/` (§4). */
const sheetPath = (relPath: string): string => {
    const config = loadConfig();
    const root = dataPaths(config).art + path.sep;
    const absolute = path.resolve(config.dataDir, assertSafeRelativePath(relPath));

    if (!absolute.startsWith(root)) {
        throw new ValidationError("Refusing to read a sheet outside the art directory");
    }

    return absolute;
};

/** The frames a video's face at `atMs` may be, and which of them its tile looks like. */
export const faceMoments = async (
    mediaId: string,
    atMs: number,
    auth: AuthContext
): Promise<FaceMoments> => {
    // Visibility first, every time: the cache holds answers, not permission.
    const { row, original } = readableOriginal(mediaId, auth);

    if (row.kind !== "video") {
        throw new ValidationError("Only a video's faces have a moment to find");
    }

    const tile = spriteTileFile(mediaId, atMs);
    const key = `${mediaId}:${atMs}:${tile?.generatedAt ?? ""}`;
    const known = cache.get(key);

    if (known) {
        return remember(key, known);
    }

    return inFrameSlot(async () => {
        let read;

        try {
            read = await readTileMoments({
                original,
                atMs,
                // Without a sprite there is nothing to compare with, but the frames are still
                // the ones a tile at this moment would be, and worth offering.
                intervalMs: tile?.intervalMs ?? spriteLayout(row.durationMs).intervalMs,
                tile: tile && { sheetPath: sheetPath(tile.relPath), rect: tile.rect },
            });
        } catch (error) {
            throw error instanceof ValidationError
                ? error
                : new ValidationError("Could not read the frames near that moment");
        }

        if (read.moments.length === 0) {
            throw new ValidationError("There is no frame at that position");
        }

        return remember(key, {
            moments: read.moments.map((moment) => ({
                atMs: moment.atMs,
                thumbUrl: `data:image/webp;base64,${moment.thumb.toString("base64")}`,
            })),
            matched: read.matched,
        });
    });
};
