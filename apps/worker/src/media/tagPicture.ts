import { mkdir, rm } from "node:fs/promises";
import * as path from "node:path";

import {
    TAG_PICTURE_WIDTH,
    assertSafeRelativePath,
    tagPictureRelPath,
    type PictureCrop,
} from "@private-stock/core";
import { dataPaths, loadConfig } from "@private-stock/core/server";
import { tagPictureRepo } from "@private-stock/db";

import { extractFrame, imageDimensions } from "./frames.js";
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

/** Is this the moment the picture already shows? The same item and moment. */
export const showsMoment = (
    row: tagPictureRepo.TagPictureRow,
    moment: { mediaId: string; atMs: number | null }
): boolean => row.mediaId === moment.mediaId && row.atMs === moment.atMs;
