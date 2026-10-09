import {
    AUTO_PICTURE_MIN_FACE_PX,
    AUTO_PICTURE_MIN_SCORE,
    FALLBACK_PICTURE_MIN_FACE_PX,
    pictureAroundFace,
    tagPictureAspect,
} from "@private-stock/core";
import { db, faceRepo, tagPictureRepo } from "@private-stock/db";

import { breathe } from "../eventLoop.js";
import { drawAutoPicture, showsMoment, withdrawAutoPicture } from "../media/tagPicture.js";
import { enqueue } from "../queue.js";

/**
 * The `tagPictures` job: a performer's picture from their faces, until somebody chooses one (§6
 * "A tag's picture").
 *
 * One job for the library, coalescing. For each library performer it takes the largest, surest
 * face somebody confirmed as them, reads that moment from the original at full size, and frames
 * head and shoulders around it — the picture a person would have cut. A face too small in the
 * original for a sharp portrait is passed over for the next.
 *
 * Without one, it falls back a tier at a time: a face one of their automatic tags rests on, then
 * the best confirmed face below the bars, cut at a smaller size. A performer with none of those
 * keeps no automatic picture, and stays a chip on an item.
 *
 * Nothing is read twice: a performer whose best face is the one their picture already shows is
 * left alone, so a run after nothing changed is one query. A picture somebody chose is never
 * touched here; it is drawn over this one, and this one shows again if they take theirs back.
 * Sources' and keywords' pictures are `tagLookPictures`'.
 */

/** Long enough for a review session's decisions to arrive together; short enough to see. */
const SETTLE_MS = 2 * 60 * 1000;

/**
 * The least of the frame's height a face must fill to be offered: a close-up. A face that fills
 * less is a smudge in a portrait unless the original is very large, and a close-up of somebody is
 * the picture of them anyone would choose.
 */
const MIN_SHARE = 0.2;

/** Faces tried per performer and tier when the first is too small in its original. */
const TRIES = 3;

/** Queue a pass, once, after the decisions it follows have settled. */
export const enqueueTagPictures = (): void => {
    enqueue(db, {
        kind: "tagPictures",
        priority: 200,
        availableAt: new Date(Date.now() + SETTLE_MS),
    });
};

type Candidate = faceRepo.PictureCandidate;

export const runTagPictures = async (): Promise<void> => {
    const byTag = new Map<string, Candidate[]>();

    for (const candidate of faceRepo.pictureCandidates(AUTO_PICTURE_MIN_SCORE, MIN_SHARE, TRIES)) {
        byTag.set(candidate.tagId, [...(byTag.get(candidate.tagId) ?? []), candidate]);
    }

    const current = new Map(tagPictureRepo.listAuto("performers").map((row) => [row.tagId, row]));
    let since = Date.now();
    let drawn = 0;
    let dropped = 0;

    for (const [tagId, candidates] of byTag) {
        const existing = current.get(tagId);
        let settled = false;

        current.delete(tagId);

        for (const candidate of candidates) {
            // Anything better ranked was tried before this and failed, or is new and was tried
            // just now; the picture already shows this one, so there is nothing to do.
            if (existing && showsMoment(existing, candidate)) {
                settled = true;
                break;
            }

            if (
                await drawAutoPicture(candidate, (frame) =>
                    pictureAroundFace(
                        candidate,
                        frame,
                        tagPictureAspect("performer"),
                        candidate.tier === 3
                            ? FALLBACK_PICTURE_MIN_FACE_PX
                            : AUTO_PICTURE_MIN_FACE_PX
                    )
                )
            ) {
                drawn += 1;
                settled = true;
                break;
            }

            since = await breathe(since);
        }

        // Its face is no longer one of theirs worth a picture -- a confirmation taken back, a
        // face too small after all -- so neither is the picture.
        if (!settled && existing) {
            await withdrawAutoPicture(existing);
            dropped += 1;
        }

        since = await breathe(since);
    }

    // Performers with no face of theirs left at all.
    for (const row of current.values()) {
        await withdrawAutoPicture(row);
        dropped += 1;
    }

    if (drawn + dropped > 0) {
        console.log(`Performers' pictures: ${drawn} drawn from their faces, ${dropped} withdrawn`);
    }
};
