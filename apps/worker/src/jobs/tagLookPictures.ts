import { readFile } from "node:fs/promises";
import * as path from "node:path";

import {
    LOOK_PICTURE_MIN_ITEMS,
    LOOK_PICTURE_MIN_Z,
    REPRESENTATIVES_LOG_REL_PATH,
    assertSafeRelativePath,
    centredCrop,
    coherenceOf,
    decodeRepresentatives,
    dequantize,
    meanDirection,
    normaliseVector,
    pictureAroundSquare,
    quantizedSimilarity,
    randomCoherence,
    tagPictureAspect,
    type RepresentativesRecord,
} from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";
import { tagPictureRepo } from "@private-stock/db";

import { breathe } from "../eventLoop.js";
import {
    drawAutoPicture,
    drawFromTile,
    showsTile,
    withdrawAutoPicture,
} from "../media/tagPicture.js";

/**
 * The `tagLookPictures` job: a source's or a keyword's picture from how its items look, until
 * somebody chooses one (§6 "A tag's picture").
 *
 * Faces say who a performer is; nothing says what a source or a keyword is, except the items
 * carrying it. So its picture is its **most typical frame**: each item's look is the mean of its
 * representatives (§5e), the tag's look is the mean of its items', and the picture is the
 * representative nearest that -- framed 16:9 around the square it was seen in.
 *
 * **Only where the tag has a look at all.** Its items must be clearly more alike than random sets
 * of the same size from the library (`LOOK_PICTURE_MIN_Z` standard deviations), or the "most
 * typical" frame is an arbitrary one. Measured on the library when this was built: every source
 * and 17 of 20 keywords cleared it.
 *
 * **A tag without one gets a stand-in** (decided 2026-10-08): somebody's capture from one of its
 * items, else one of its covers, framed centred. Arbitrary, and better than none -- it makes a
 * card of the tag on an item rather than a chip, there are few such tags, and a wrong picture is
 * the nudge to choose a right one. It is kept while its item still carries the tag.
 *
 * One read of `embed/reps.log`, which the web process already reads the same way, rather than a
 * file per item. A tag whose picture is within a hair of the best is left alone, so tagging one
 * more item does not redraw it. Daily and at startup: a typical look moves slowly.
 */

/** How much better than the picture's own frame another must be to replace it. */
const HOLD = 0.01;

/** Random sets drawn per baseline size. */
const DRAWS = 40;

const absolute = (relPath: string): string =>
    path.resolve(loadConfig().dataDir, assertSafeRelativePath(relPath));

interface Best {
    mediaId: string;
    atMs: number | null;
    square: number;
    score: number;
}

export const runTagLookPictures = async (): Promise<void> => {
    // Nothing embedded yet means nothing has a look; every tag is then pictured by a stand-in.
    const bytes = await readFile(absolute(REPRESENTATIVES_LOG_REL_PATH)).catch(() => null);
    const listable = new Set(tagPictureRepo.listableMediaIds());
    const latest = new Map<string, RepresentativesRecord>();

    // The last record of an item is its current one (§5e "Where the vectors live").
    for (const record of bytes ? decodeRepresentatives(new Uint8Array(bytes)).records : []) {
        if (listable.has(record.mediaId) && record.vectors.length > 0) {
            latest.set(record.mediaId, record);
        }
    }

    let since = Date.now();
    const looks = new Map<string, Float32Array>();

    for (const [mediaId, record] of latest) {
        looks.set(
            mediaId,
            meanDirection(record.vectors.map((entry) => normaliseVector(dequantize(entry.vector))))
        );
        since = await breathe(since);
    }

    const members = new Map<string, Set<string>>();
    const byTag = new Map<string, string[]>();

    for (const { tagId, mediaId } of tagPictureRepo.lookPictureMembers()) {
        members.set(tagId, (members.get(tagId) ?? new Set()).add(mediaId));

        if (looks.has(mediaId)) {
            byTag.set(tagId, [...(byTag.get(tagId) ?? []), mediaId]);
        }
    }

    const pool = [...looks.values()];
    const baselines = new Map<number, { mean: number; sd: number }>();
    // At the tag's own size: how alike random items are falls with how many there are, steeply
    // for a handful, so a baseline drawn at a nearby size would flatter a small tag.
    const baseline = (size: number) => {
        if (!baselines.has(size)) {
            baselines.set(size, randomCoherence(pool, size, DRAWS));
        }

        return baselines.get(size)!;
    };

    const current = new Map(tagPictureRepo.listAuto("others").map((row) => [row.tagId, row]));
    const aspect = tagPictureAspect("source");
    let drawn = 0;
    let standIns = 0;
    let dropped = 0;

    for (const [tagId, carriers] of members) {
        const existing = current.get(tagId);
        const mediaIds = byTag.get(tagId) ?? [];

        current.delete(tagId);

        const enough = mediaIds.length >= LOOK_PICTURE_MIN_ITEMS;
        const { length, direction } = coherenceOf(mediaIds.map((id) => looks.get(id)!));
        const { mean, sd } = enough ? baseline(mediaIds.length) : { mean: 0, sd: 0 };
        const typical = enough && sd > 0 && (length - mean) / sd >= LOOK_PICTURE_MIN_Z;

        if (!typical) {
            // An arbitrary picture beats none: it makes a card of the tag on an item, and a wrong
            // one is the nudge to choose a better. Whatever it shows now is kept while that item
            // still carries the tag, so it does not change from day to day.
            if (existing?.mediaId && carriers.has(existing.mediaId)) {
                continue;
            }

            const standIn = tagPictureRepo.standInFor(tagId);

            if (
                standIn &&
                (await drawAutoPicture({ tagId, ...standIn }, (frame) =>
                    centredCrop(frame, aspect)
                ))
            ) {
                standIns += 1;
            } else if (existing) {
                await withdrawAutoPicture(existing);
                dropped += 1;
            }

            since = await breathe(since);
            continue;
        }

        let best: Best | null = null;
        let shown = Number.NEGATIVE_INFINITY;

        for (const mediaId of mediaIds) {
            for (const entry of latest.get(mediaId)!.vectors) {
                const score = quantizedSimilarity(
                    direction,
                    entry.vector.values,
                    entry.vector.scale
                );

                if (!best || score > best.score) {
                    best = { mediaId, atMs: entry.atMs, square: entry.square, score };
                }

                if (existing && showsTile(existing, { mediaId, atMs: entry.atMs })) {
                    shown = Math.max(shown, score);
                }
            }
        }

        since = await breathe(since);

        if (!best || (existing && shown >= best.score - HOLD)) {
            continue;
        }

        const original = tagPictureRepo.originalOf(best.mediaId);
        const square = best.square;

        // An unreadable original keeps the picture there is, rather than none: the next run
        // tries again.
        if (
            original &&
            (await drawFromTile(
                { tagId, mediaId: best.mediaId, atMs: best.atMs, ...original },
                (frame) => pictureAroundSquare(square, frame, aspect)
            ))
        ) {
            drawn += 1;
        }
    }

    // Tags no listable item carries any more.
    for (const row of current.values()) {
        await withdrawAutoPicture(row);
        dropped += 1;
    }

    if (drawn + standIns + dropped > 0) {
        console.log(
            `Sources' and keywords' pictures: ${drawn} drawn from their looks, ` +
                `${standIns} stand-ins, ${dropped} withdrawn`
        );
    }
};
