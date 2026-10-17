import {
    AUTO_PICTURE_MIN_FACE_PX,
    AUTO_PICTURE_MIN_SCORE,
    FALLBACK_PICTURE_MIN_FACE_PX,
    SUGGEST_NAMED_LINE,
    centredCrop,
    pictureAroundFace,
    tagPictureAspect,
} from "@private-stock/core";
import { db, faceRepo, tagPictureRepo } from "@private-stock/db";

import { breathe } from "../eventLoop.js";
import {
    drawAutoPicture,
    drawFromTile,
    showsMoment,
    showsTile,
    withdrawAutoPicture,
} from "../media/tagPicture.js";
import { enqueue } from "../queue.js";

/**
 * The `tagPictures` job: a performer's picture from their faces, until somebody chooses one (§6
 * "A tag's picture").
 *
 * One job for the library, coalescing. For each library performer it takes the largest, surest
 * face somebody confirmed as them, finds the frame it was really seen in (§9 "What a tile
 * shows"), reads that from the original at full size, and frames head and shoulders around it —
 * the picture a person would have cut. A face too small in the
 * original for a sharp portrait is passed over for the next.
 *
 * Without one, it falls back a tier at a time: a face one of their automatic tags rests on, then
 * the best confirmed face below the bars, cut at a smaller size, then — nobody having confirmed
 * any face of theirs — the person most like them on an item tagged with them. And a performer whose
 * faces give nothing at all gets a stand-in (decided 2026-10-11, as sources and keywords did): a
 * capture or a cover of one of their items, framed centred. Every performer on an item is then a
 * card, never a chip, and a wrong picture is the nudge to choose a right one. Only a performer on
 * no item anybody can see has none.
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

    for (const candidate of faceRepo.pictureCandidates(
        AUTO_PICTURE_MIN_SCORE,
        MIN_SHARE,
        TRIES,
        SUGGEST_NAMED_LINE
    )) {
        byTag.set(candidate.tagId, [...(byTag.get(candidate.tagId) ?? []), candidate]);
    }

    const current = new Map(tagPictureRepo.listAuto("performers").map((row) => [row.tagId, row]));
    const aspect = tagPictureAspect("performer");
    let since = Date.now();
    let drawn = 0;
    let standIns = 0;
    let dropped = 0;

    for (const tagId of new Set([...byTag.keys(), ...tagPictureRepo.performersCarried()])) {
        const existing = current.get(tagId);
        let settled = false;

        current.delete(tagId);

        for (const candidate of byTag.get(tagId) ?? []) {
            // Anything better ranked was tried before this and failed, or is new and was tried
            // just now; the picture already shows this one, so there is nothing to do.
            if (existing && showsTile(existing, candidate)) {
                settled = true;
                break;
            }

            if (
                await drawFromTile(candidate, (frame) =>
                    pictureAroundFace(
                        candidate,
                        frame,
                        aspect,
                        candidate.tier >= 3
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

        // No face of theirs makes one: a stand-in, the same one each run while its item carries
        // them, so it does not change from day to day.
        const standIn = settled ? undefined : tagPictureRepo.standInFor(tagId);

        if (standIn) {
            if (existing && showsMoment(existing, standIn)) {
                settled = true;
            } else if (
                await drawAutoPicture({ tagId, ...standIn }, (frame) => centredCrop(frame, aspect))
            ) {
                standIns += 1;
                settled = true;
            }
        }

        // Nothing of theirs left worth a picture -- a confirmation taken back, an item gone -- so
        // neither is the picture.
        if (!settled && existing) {
            await withdrawAutoPicture(existing);
            dropped += 1;
        }

        since = await breathe(since);
    }

    // Performers on no item anybody can see.
    for (const row of current.values()) {
        await withdrawAutoPicture(row);
        dropped += 1;
    }

    if (drawn + standIns + dropped > 0) {
        console.log(
            `Performers' pictures: ${drawn} drawn from their faces, ${standIns} stand-ins, ` +
                `${dropped} withdrawn`
        );
    }
};
