import { mkdir, rm } from "node:fs/promises";
import * as path from "node:path";

import {
    SPRITE_COLUMNS,
    SPRITE_ROWS,
    TAG_PICTURE_WIDTH,
    TILES_PER_SHEET,
    assertSafeRelativePath,
    spriteTile,
    tagPictureRelPath,
    type PictureCrop,
} from "@private-stock/core";
import { dataPaths, loadConfig, readTileMoments } from "@private-stock/core/server";
import { artifactRepo, tagPictureRepo } from "@private-stock/db";

import { extractFrame, imageDimensions } from "./frames.js";
import { execFilePolitely } from "./politeSpawn.js";
import { resolveSource } from "./sourcePath.js";

/**
 * Drawing a tag's automatic picture from one moment of an item (§6 "A tag's picture"), for the
 * two jobs that choose the moment: `tagPictures` from a performer's confirmed faces, and
 * `tagLookPictures` from how a source's or a keyword's items look.
 */

/** The frame is read at up to this width, so the crop has the original's pixels to work with. */
const FRAME_WIDTH = 3840;

const absolute = (dataDir: string, relPath: string): string =>
    path.resolve(dataDir, assertSafeRelativePath(relPath));

export interface AutoPictureSource {
    tagId: string;
    mediaId: string;
    kind: "video" | "image";
    atMs: number | null;
    fileId: string;
    /** The sprite tile's moment it was chosen by, where `atMs` is the frame the tile shows. */
    tileAtMs?: number | null;
}

/**
 * Read the moment from the original and keep the part `cropFor` chooses, as the tag's automatic
 * picture. False when it will not make one: the original is gone or unreadable, or `cropFor`
 * declines the frame.
 *
 * `cropFor` is handed the frame as decoded, not the dimensions on record: a phone's portrait video
 * is stored landscape and turned on playback, and what the faces and the looks were read from is
 * the turned picture.
 */
export const drawAutoPicture = async (
    source: AutoPictureSource,
    cropFor: (frame: { width: number; height: number }) => PictureCrop | null
): Promise<boolean> => {
    const config = loadConfig();
    const original = resolveSource(source.fileId);

    if (!original) {
        return false;
    }

    const work = path.join(dataPaths(config).tags, ".work", `${source.tagId}.webp`);

    await mkdir(path.dirname(work), { recursive: true });

    try {
        await extractFrame(original.absolutePath, work, {
            atMs: source.kind === "video" ? (source.atMs ?? 0) : undefined,
            width: FRAME_WIDTH,
        });

        const { width, height } = await imageDimensions(work);

        if (!width || !height) {
            return false;
        }

        const crop = cropFor({ width, height });

        if (!crop) {
            return false;
        }

        const relPath = tagPictureRelPath(source.tagId, "auto", "large");
        const smallRelPath = tagPictureRelPath(source.tagId, "auto", "small");

        await extractFrame(work, absolute(config.dataDir, relPath), {
            width: TAG_PICTURE_WIDTH.large,
            crop,
        });
        await extractFrame(work, absolute(config.dataDir, smallRelPath), {
            width: TAG_PICTURE_WIDTH.small,
            crop,
        });

        tagPictureRepo.upsert({
            tagId: source.tagId,
            source: "auto",
            relPath,
            smallRelPath,
            mediaId: source.mediaId,
            atMs: source.atMs,
            tileAtMs: source.tileAtMs ?? null,
            crop,
            setByUserId: null,
        });

        return true;
    } catch (error) {
        console.warn(
            `No picture for tag ${source.tagId} from ${source.mediaId}: ${
                error instanceof Error ? error.message : String(error)
            }`
        );

        return false;
    } finally {
        await rm(work, { force: true });
    }
};

/** Take an automatic picture away: the row, then its files. */
export const withdrawAutoPicture = async (row: tagPictureRepo.TagPictureRow): Promise<void> => {
    const { dataDir } = loadConfig();

    tagPictureRepo.remove(row.tagId, "auto");

    for (const relPath of [row.relPath, row.smallRelPath]) {
        await rm(absolute(dataDir, relPath), { force: true });
    }
};

/**
 * The frame a video's sprite tile really shows (§9 "What a tile shows"), or the tile's own moment
 * when that cannot be told -- no sprite left to compare with, or the original unreadable.
 *
 * A face or a look is found on a tile and records the tile's moment, and the tile is another
 * frame, usually half an interval later: cut there, a picture is of a different moment, framed
 * around where the face or the square was not.
 */
export const seenAt = async (face: {
    mediaId: string;
    atMs: number;
    fileId: string;
}): Promise<number> => {
    const original = resolveSource(face.fileId);
    const sheets = artifactRepo.listForMedia(face.mediaId, ["sprite"]);
    const intervalMs = sheets[0]?.intervalMs ?? 0;
    const total = sheets.reduce((sum, sheet) => sum + (sheet.tileCount ?? 0), 0);

    if (!original || intervalMs <= 0 || total === 0) {
        return face.atMs;
    }

    // As the faces job found it: the tile by arithmetic, its size from the sheet's.
    const index = Math.min(Math.floor(face.atMs / intervalMs), total - 1);
    const sheet = sheets.find((row) => row.ordinal === Math.floor(index / TILES_PER_SHEET));

    if (!sheet?.width || !sheet.height) {
        return face.atMs;
    }

    const width = sheet.width / SPRITE_COLUMNS;
    const height = sheet.height / SPRITE_ROWS;
    const { x, y } = spriteTile(index, SPRITE_COLUMNS, width, height);

    try {
        const read = await readTileMoments({
            original: original.absolutePath,
            atMs: face.atMs,
            intervalMs,
            tile: {
                sheetPath: absolute(loadConfig().dataDir, sheet.relPath),
                rect: { x, y, width, height },
            },
            run: execFilePolitely,
        });

        return read.matched === null ? face.atMs : read.moments[read.matched].atMs;
    } catch (error) {
        console.warn(
            `No frame found for the tile of ${face.mediaId} at ${face.atMs}ms: ${
                error instanceof Error ? error.message : String(error)
            }`
        );

        return face.atMs;
    }
};

/**
 * Does the picture already show what was found on this tile -- a face, a look? The same item,
 * and the tile's moment, which a video's picture keeps apart from the frame it was cut from. A
 * picture drawn before the two were told apart has none, so is drawn again once, from the frame
 * really seen. A photograph has no moment and no tile.
 */
export const showsTile = (
    row: tagPictureRepo.TagPictureRow,
    found: { mediaId: string; atMs: number | null }
): boolean =>
    row.mediaId === found.mediaId &&
    (found.atMs === null ? row.atMs === null : row.tileAtMs === found.atMs);

/**
 * The picture drawn from what was found on a tile: for a video, from the frame the tile really
 * shows, remembering the tile's moment (`showsTile`).
 */
export const drawFromTile = async (
    source: AutoPictureSource,
    cropFor: (frame: { width: number; height: number }) => PictureCrop | null
): Promise<boolean> =>
    drawAutoPicture(
        source.kind === "video" && source.atMs !== null
            ? {
                  ...source,
                  atMs: await seenAt({ ...source, atMs: source.atMs }),
                  tileAtMs: source.atMs,
              }
            : source,
        cropFor
    );

/** Is this the moment the picture already shows? The same item and moment: a stand-in's. */
export const showsMoment = (
    row: tagPictureRepo.TagPictureRow,
    moment: { mediaId: string; atMs: number | null }
): boolean => row.mediaId === moment.mediaId && row.atMs === moment.atMs;
