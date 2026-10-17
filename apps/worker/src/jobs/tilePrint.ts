import * as path from "node:path";

import {
    SPRITE_COLUMNS,
    SPRITE_ROWS,
    TILE_PRINT_SIDE,
    assertSafeRelativePath,
    encodeTilePrints,
    tilePrintFromRgb,
    tilePrintRelPath,
    type StageOutcome,
} from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";
import { artifactRepo, dupeRepo, mediaRepo } from "@private-stock/db";

import { writeInPlace } from "../embed/pictures.js";
import { resolveFfmpeg } from "../media/binaries.js";
import { capThreads } from "../media/ffmpegThreads.js";
import { execFilePolitely } from "../media/politeSpawn.js";
import { placeDataFile, settledTwin } from "../media/twin.js";
import type { JobRow } from "../queue.js";

import { queueDupePass } from "./dupes.js";

/**
 * The `tileprint` job: a 4×4 colour grid for every sprite tile of a video (§10h).
 *
 * Reads the sprite sheets on /data and never the original. ffmpeg shrinks a whole sheet so
 * that each tile becomes exactly `TILE_PRINT_SIDE` square — the sheet is always a padded 10×10
 * grid, so the tiles stay aligned — and the rest is arithmetic on 300 KB of pixels.
 */

const SHEET_WIDTH = SPRITE_COLUMNS * TILE_PRINT_SIDE;
const SHEET_HEIGHT = SPRITE_ROWS * TILE_PRINT_SIDE;

/** A sheet is a webp of a few hundred KB; anything slower than this is a stuck decoder. */
const DECODE_TIMEOUT_MS = 60_000;

const absolute = (relPath: string): string =>
    path.resolve(loadConfig().dataDir, assertSafeRelativePath(relPath));

const decodeSheet = async (sheetPath: string): Promise<Uint8Array> => {
    const ffmpeg = await resolveFfmpeg();
    const { stdout } = await execFilePolitely(
        ffmpeg,
        capThreads([
            "-v",
            "error",
            "-i",
            sheetPath,
            "-vf",
            `scale=${SHEET_WIDTH}:${SHEET_HEIGHT}:flags=area`,
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ]),
        { timeout: DECODE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "buffer" }
    );
    const pixels = stdout as unknown as Buffer;

    if (pixels.length !== SHEET_WIDTH * SHEET_HEIGHT * 3) {
        throw new Error(`${path.basename(sheetPath)} decoded to ${pixels.length} bytes`);
    }

    return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length);
};

/** The pixels of one tile, cut out of the shrunk sheet. */
const tileOf = (sheet: Uint8Array, index: number): Uint8Array => {
    const tile = new Uint8Array(TILE_PRINT_SIDE * TILE_PRINT_SIDE * 3);
    const left = (index % SPRITE_COLUMNS) * TILE_PRINT_SIDE;
    const top = Math.floor(index / SPRITE_COLUMNS) * TILE_PRINT_SIDE;
    const rowBytes = TILE_PRINT_SIDE * 3;

    for (let y = 0; y < TILE_PRINT_SIDE; y += 1) {
        const from = ((top + y) * SHEET_WIDTH + left) * 3;

        tile.set(sheet.subarray(from, from + rowBytes), y * rowBytes);
    }

    return tile;
};

/**
 * The prints of a sheet's first `tileCount` tiles. Exported for the integration test, which
 * holds it to a sheet ffmpeg really drew.
 */
export const printSheet = async (
    sheetPath: string,
    tileCount: number
): Promise<(Uint8Array | null)[]> => {
    const pixels = await decodeSheet(sheetPath);

    return Array.from({ length: tileCount }, (_, index) => tilePrintFromRgb(tileOf(pixels, index)));
};

export const runTilePrint = async (job: JobRow): Promise<StageOutcome | void> => {
    if (!job.mediaId || !job.fileId) {
        throw new Error("tileprint job requires both mediaId and fileId");
    }

    if (!mediaRepo.findBasic(job.mediaId)) {
        return "skipped";
    }

    const outRelPath = tilePrintRelPath(job.mediaId);
    const twin = settledTwin(job.fileId, "tileprint");

    if (twin?.state === "empty") {
        return "empty";
    }

    let placed = false;

    if (twin) {
        try {
            // Hardlinked, as the vectors file is: written by rename, so neither copy can be
            // rewritten through the link.
            await placeDataFile(tilePrintRelPath(twin.mediaId), outRelPath, { hardlink: true });
            placed = true;
        } catch {
            // The twin's file is gone: print this one from its own sheets.
        }
    }

    if (!placed) {
        const sheets = artifactRepo
            .listForMedia(job.mediaId, ["sprite"])
            .filter((sheet) => sheet.tileCount && sheet.intervalMs);

        if (sheets.length === 0) {
            // The sprite stage settled with nothing: a video too short for a filmstrip.
            return "empty";
        }

        const tiles: (Uint8Array | null)[] = [];

        for (const sheet of sheets) {
            tiles.push(...(await printSheet(absolute(sheet.relPath), sheet.tileCount!)));
        }

        if (tiles.every((tile) => tile === null)) {
            return "empty";
        }

        await writeInPlace(
            absolute(outRelPath),
            encodeTilePrints({ intervalMs: sheets[0].intervalMs!, tiles })
        );
    }

    // New evidence for an item that may already have been compared without it (§10b).
    dupeRepo.forgetClustered(job.mediaId);
    queueDupePass();
};
