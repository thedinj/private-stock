import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
    NotFoundError,
    TAG_PICTURE_WIDTH,
    ValidationError,
    assertSafeRelativePath,
    tagPictureRelPath,
    type SetTagPictureInput,
    type TagPicture,
    type TagPictureSize,
} from "@private-stock/core";
import {
    FRAME_TIMEOUT_MS,
    artifactVersion,
    dataPaths,
    frameArgs,
    libraryFilePath,
    loadConfig,
    resolveFfmpeg,
} from "@private-stock/core/server";
import { mediaRepo, mediaRootRepo, tagPictureRepo, tagRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { inFrameSlot } from "./frameSlot";

/**
 * A tag's picture (§6 "A tag's picture").
 *
 * Anybody who can see a tag may choose its picture, as anybody who can see an item may choose its
 * cover: it is curation everybody sees, it writes nothing anybody else made, and it is undone by
 * choosing again. A private tag is its owner's alone, because nobody else can see it.
 *
 * The picture is cut from the original, never from what the dialogue showed: the still there is
 * a preview at screen size, and a portrait taken from it would be a downscale of a downscale.
 * ffmpeg runs inside the request for the reason a capture's does (§9) -- one seek, one decode,
 * the shared ceiling on how many at once -- and so the tile has changed by the time the
 * dialogue closes.
 */

const execFileAsync = promisify(execFile);

/** The still the crop dialogue shows: wide enough to frame on a large screen, no wider. */
const STILL_WIDTH = 1280;

/** The tag, if this viewer can see it: the library's, or their own. */
const visibleTag = (tagId: string, auth: AuthContext): tagRepo.TagRow => {
    const tag = tagRepo.findById(tagId);

    if (!tag || (tag.ownerId !== null && tag.ownerId !== auth.userId)) {
        throw new NotFoundError("Tag not found");
    }

    return tag;
};

/** The item and its original, if this viewer may see it. Missing rather than forbidden (§6). */
export const readableOriginal = (mediaId: string, auth: AuthContext) => {
    const row = mediaRepo.findDetail(mediaId, auth.userId, auth.accessibleRootIds);

    if (!row) {
        throw new NotFoundError("Media not found");
    }

    const root = mediaRootRepo.findById(row.rootId);

    if (!root) {
        throw new NotFoundError("That library is no longer configured");
    }

    return { row, original: libraryFilePath(root.path, row.relPath) };
};

/** Where a moment of an item is: a video needs one, a photograph has none. */
const momentOf = (kind: string, atMs: number | null): number | undefined => {
    if (kind !== "video") {
        return undefined;
    }

    if (atMs === null) {
        throw new ValidationError("Say which moment of the video to use");
    }

    return atMs;
};

const toPicture = (row: tagPictureRepo.TagPictureRow): TagPicture => ({
    url: `/api/tags/${row.tagId}/picture?v=${artifactVersion(row.relPath, row.generatedAt)}`,
    smallUrl: `/api/tags/${row.tagId}/picture?size=small&v=${artifactVersion(
        row.smallRelPath,
        row.generatedAt
    )}`,
    source: row.source,
    mediaId: row.mediaId,
    atMs: row.atMs,
});

/** What each of these tags shows this viewer, by tag id. Tags without one are absent. */
export const picturesFor = (
    tagIds: readonly string[],
    auth: AuthContext
): Map<string, TagPicture> =>
    new Map(
        [...tagPictureRepo.effectiveFor(tagIds, auth.accessibleRootIds)].map(([tagId, row]) => [
            tagId,
            toPicture(row),
        ])
    );

/** Each tag with its picture, or null: what every reader that draws one is handed. */
export const withPictures = <T extends { id: string }>(
    tags: T[],
    auth: AuthContext
): (T & { picture: TagPicture | null })[] => {
    const pictures = picturesFor(
        tags.map((tag) => tag.id),
        auth
    );

    return tags.map((tag) => ({ ...tag, picture: pictures.get(tag.id) ?? null }));
};

/** A file under `tags/`, refusing anything that resolves elsewhere (§4). */
const tagsPath = (relPath: string): string => {
    const config = loadConfig();
    const root = dataPaths(config).tags + path.sep;
    const absolute = path.resolve(config.dataDir, assertSafeRelativePath(relPath));

    if (!absolute.startsWith(root)) {
        throw new ValidationError("Refusing to use a path outside the pictures directory");
    }

    return absolute;
};

/**
 * Cut this tag's picture from a moment of an item, replacing any chosen before.
 *
 * The large rendering from the original, the small one from the large: a second seek into the
 * original could land on a different frame of a variable-rate video, and the two must be one
 * picture. The row goes in after both files are there, so it never names a file that is not.
 */
export const setTagPicture = async (
    tagId: string,
    input: SetTagPictureInput,
    auth: AuthContext
): Promise<TagPicture> => {
    visibleTag(tagId, auth);

    const { row, original } = readableOriginal(input.mediaId, auth);
    const atMs = momentOf(row.kind, input.atMs);
    const relPath = tagPictureRelPath(tagId, "user", "large");
    const smallRelPath = tagPictureRelPath(tagId, "user", "small");
    const large = tagsPath(relPath);
    const small = tagsPath(smallRelPath);

    await inFrameSlot(async () => {
        const ffmpeg = await resolveFfmpeg();

        await mkdir(path.dirname(large), { recursive: true });

        try {
            await execFileAsync(
                ffmpeg,
                frameArgs(original, large, {
                    atMs,
                    width: TAG_PICTURE_WIDTH.large,
                    crop: input.crop,
                }),
                { timeout: FRAME_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
            );
            await execFileAsync(
                ffmpeg,
                frameArgs(large, small, { width: TAG_PICTURE_WIDTH.small }),
                { timeout: FRAME_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
            );
        } catch {
            throw new ValidationError("Could not read a picture at that position");
        }

        const written = await stat(small).catch(() => null);

        if (!written || written.size === 0) {
            throw new ValidationError("There is no frame at that position");
        }
    });

    return toPicture(
        tagPictureRepo.upsert({
            tagId,
            source: "user",
            relPath,
            smallRelPath,
            mediaId: input.mediaId,
            atMs: atMs ?? null,
            crop: input.crop,
            setByUserId: auth.userId,
        })
    );
};

/**
 * Take back the chosen picture. What shows then is the one read from their faces, if they have
 * one, or nothing -- returned, so the screen that pressed the button can draw it at once.
 *
 * The row first, then the files: a row without its file is a broken picture, a file without its
 * row is invisible and swept up (§9).
 */
export const clearTagPicture = async (
    tagId: string,
    auth: AuthContext
): Promise<TagPicture | null> => {
    visibleTag(tagId, auth);

    const removed = tagPictureRepo.remove(tagId, "user");

    if (removed) {
        for (const relPath of [removed.relPath, removed.smallRelPath]) {
            await rm(tagsPath(relPath), { force: true });
        }
    }

    return picturesFor([tagId], auth).get(tagId) ?? null;
};

export interface ResolvedTagPicture {
    absolutePath: string;
    sizeBytes: number;
    /** Whether the URL named these bytes, so they may be cached for good. */
    versioned: boolean;
}

/** The file behind a picture URL: the tag's picture as this viewer is shown it. */
export const resolveTagPicture = async (
    tagId: string,
    size: TagPictureSize,
    version: string | null,
    auth: AuthContext
): Promise<ResolvedTagPicture> => {
    visibleTag(tagId, auth);

    const row = tagPictureRepo.effectiveFor([tagId], auth.accessibleRootIds).get(tagId);

    if (!row) {
        throw new NotFoundError("This tag has no picture");
    }

    const relPath = size === "small" ? row.smallRelPath : row.relPath;
    const absolutePath = tagsPath(relPath);
    const sizeBytes = await stat(absolutePath)
        .then((stats) => stats.size)
        .catch(() => {
            throw new NotFoundError("This tag's picture is not available");
        });

    return {
        absolutePath,
        sizeBytes,
        versioned: version === artifactVersion(relPath, row.generatedAt),
    };
};

/**
 * One moment of an item as a picture, for the dialogue that frames a tag's picture.
 *
 * Read from the original, as the picture will be, so what is framed is what is kept -- the
 * player may be showing a web-safe rendition, and a frame strip's stills are of other moments.
 * Nothing is kept: the file is read back and removed in the one request.
 */
export const readStill = async (
    mediaId: string,
    atMs: number | null,
    auth: AuthContext
): Promise<Buffer> => {
    const { row, original } = readableOriginal(mediaId, auth);
    const moment = momentOf(row.kind, atMs);
    const out = path.join(tmpdir(), `private-stock-still-${randomUUID()}.webp`);

    return inFrameSlot(async () => {
        try {
            await execFileAsync(
                await resolveFfmpeg(),
                frameArgs(original, out, { atMs: moment, width: STILL_WIDTH }),
                { timeout: FRAME_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
            );

            const bytes = await readFile(out).catch(() => null);

            if (!bytes || bytes.length === 0) {
                throw new ValidationError("There is no frame at that position");
            }

            return bytes;
        } catch (error) {
            throw error instanceof ValidationError
                ? error
                : new ValidationError("Could not read a frame at that position");
        } finally {
            await rm(out, { force: true });
        }
    });
};
