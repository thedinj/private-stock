/**
 * A tag's own picture (§6 "A tag's picture"): its shape, its files, and how one is framed around a
 * confirmed face.
 *
 * Pure, so the framing can be tested without ffmpeg; the web process renders a chosen picture and
 * the worker's `tagPictures` job renders the automatic one, both from these numbers.
 */

import { squaresIn } from "./embedding.js";
import { PathSafetyError } from "./errors.js";

/** Who put the picture there: a person, or the job reading their confirmed faces. */
export type TagPictureSource = "user" | "auto";

/**
 * The two renderings, by width. `large` is the browse tile and the tag page's inset; `small` is
 * everything drawn at 72–88 CSS pixels, at twice that for a dense screen. Nothing draws a picture
 * smaller than that: a face at chip size is a smudge, which is worse than a name alone.
 */
export const TAG_PICTURE_WIDTH = { large: 600, small: 240 } as const;
export type TagPictureSize = keyof typeof TAG_PICTURE_WIDTH;

export const isTagPictureSize = (value: string): value is TagPictureSize =>
    value === "large" || value === "small";

/**
 * Width over height. A performer is a portrait, as their browse tile is; a source or a keyword is
 * a frame of what it describes, and a video frame is landscape.
 */
export const tagPictureAspect = (kind: string): number => (kind === "performer" ? 4 / 5 : 16 / 9);

/** A region of a picture, as fractions of its width and height. */
export interface PictureCrop {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * Where a picture's file lives under `dataDir`: `tags/<two characters>/<tag>-<source>-<size>.webp`.
 *
 * Built only from a tag id this app minted, and checked as such: the result is written to.
 */
export const tagPictureRelPath = (
    tagId: string,
    source: TagPictureSource,
    size: TagPictureSize
): string => {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(tagId)) {
        throw new PathSafetyError(`Not a tag id: "${tagId}"`);
    }

    return `tags/${tagId.slice(0, 2)}/${tagId}-${source}-${size}.webp`;
};

/**
 * The smallest face the automatic picture is cut around, in pixels of the original: its height
 * from brow to chin, roughly. A 600-pixel portrait from less than this is an enlargement.
 */
export const AUTO_PICTURE_MIN_FACE_PX = 96;

/** And how sure the detector has to have been. Well above what it keeps (`FACE_SCORE`). */
export const AUTO_PICTURE_MIN_SCORE = 0.7;

/**
 * The smallest face of the last resort: a performer with no face that clears the bars above is
 * pictured from their best confirmed face anyway (§6 "A tag's picture"), because a soft picture
 * of them beats a chip. Below this the enlargement is a blur, and the chip is the better of two
 * bad answers.
 */
export const FALLBACK_PICTURE_MIN_FACE_PX = 48;

/** How much of the crop's height the face fills: head and shoulders, not a passport photo. */
const FACE_SHARE = 1 / 2.6;

/** Where the face's centre sits, down from the top of the crop. */
const FACE_LINE = 0.4;

const clamp = (value: number, low: number, high: number): number =>
    Math.min(Math.max(value, low), high);

/**
 * A crop of `aspect` around a face, or null when the face is too small for one.
 *
 * `face` is fractions of the frame, which is what the faces stage stores: a sprite tile is the
 * frame scaled down whole, and a photograph's cover is the photograph, so the fractions hold for
 * the original too. `frame` is the original's size in pixels.
 *
 * Head and shoulders, the face's centre a little above the middle, kept inside the frame — moved
 * rather than cut where the face is near an edge, and shrunk only when the frame is smaller than
 * the crop would be.
 */
export const pictureAroundFace = (
    face: PictureCrop,
    frame: { width: number; height: number },
    aspect: number,
    minFacePx = AUTO_PICTURE_MIN_FACE_PX
): PictureCrop | null => {
    const faceHeight = face.h * frame.height;

    if (faceHeight < minFacePx) {
        return null;
    }

    let height = faceHeight / FACE_SHARE;
    let width = height * aspect;

    if (width > frame.width) {
        width = frame.width;
        height = width / aspect;
    }

    if (height > frame.height) {
        height = frame.height;
        width = height * aspect;
    }

    const centreX = (face.x + face.w / 2) * frame.width;
    const centreY = (face.y + face.h / 2) * frame.height;
    const left = clamp(centreX - width / 2, 0, frame.width - width);
    const top = clamp(centreY - height * FACE_LINE, 0, frame.height - height);

    return {
        x: left / frame.width,
        y: top / frame.height,
        w: width / frame.width,
        h: height / frame.height,
    };
};

/**
 * The largest crop of `aspect` a frame holds, centred: where the crop dialogue starts when there
 * is no face to start from.
 */
export const centredCrop = (
    frame: { width: number; height: number },
    aspect: number
): PictureCrop => {
    const width = Math.min(frame.width, frame.height * aspect);
    const height = width / aspect;

    return {
        x: (frame.width - width) / 2 / frame.width,
        y: (frame.height - height) / 2 / frame.height,
        w: width / frame.width,
        h: height / frame.height,
    };
};

/**
 * A source or a keyword has an automatic picture only with at least this many items whose looks
 * have been read: fewer is not a "typical" anything.
 */
export const LOOK_PICTURE_MIN_ITEMS = 5;

/**
 * And only when its items are this many standard deviations more alike than random sets of the
 * same size. Measured 2026-10-07: every source and 17 of 20 keywords cleared it; the three that
 * did not are no more alike than any items picked at random, and their "most typical frame" would
 * be an arbitrary one.
 */
export const LOOK_PICTURE_MIN_Z = 2;

/**
 * How alike several items look: the length of the mean of their unit directions -- one when all
 * are the same, smaller as they spread -- and the direction itself, the tag's "typical look".
 */
export const coherenceOf = (
    directions: readonly Float32Array[]
): { length: number; direction: Float32Array } => {
    const sum = new Float32Array(directions[0]?.length ?? 0);

    for (const direction of directions) {
        for (let i = 0; i < sum.length; i += 1) sum[i] += direction[i];
    }

    let squared = 0;

    for (const value of sum) squared += value * value;

    const total = Math.sqrt(squared) || 1;

    return {
        length: total / Math.max(1, directions.length),
        direction: sum.map((value) => value / total),
    };
};

/** A small seeded generator, so the same library gives the same baseline every run. */
const seeded = (seed: number): (() => number) => {
    let state = seed >>> 0;

    return () => {
        state = (state + 0x6d2b79f5) >>> 0;

        let t = state;

        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

/**
 * How alike random sets of `size` items from the library are: the mean and spread of their
 * coherence, over `draws` sets. What a tag's coherence is compared with, since the library's own
 * items are far from evenly spread -- any 25 of them already measure about 0.9.
 */
export const randomCoherence = (
    pool: readonly Float32Array[],
    size: number,
    draws = 40,
    seed = size
): { mean: number; sd: number } => {
    const random = seeded(seed);
    const take = Math.min(size, pool.length);
    const values: number[] = [];

    for (let draw = 0; draw < draws; draw += 1) {
        const chosen = new Set<number>();

        while (chosen.size < take) chosen.add(Math.floor(random() * pool.length));

        values.push(coherenceOf([...chosen].map((index) => pool[index])).length);
    }

    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const variance =
        values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);

    return { mean, sd: Math.sqrt(variance) };
};

/**
 * A crop of `aspect` around one of the squares a frame was read as (§5e): the part of it the
 * matching look was seen in, as large as the frame allows and centred on that square.
 */
export const pictureAroundSquare = (
    square: number,
    frame: { width: number; height: number },
    aspect: number
): PictureCrop => {
    const squares = squaresIn({ x: 0, y: 0, width: frame.width, height: frame.height });
    const chosen = squares[Math.min(Math.max(square, 0), squares.length - 1)];
    const width = Math.min(frame.width, frame.height * aspect);
    const height = width / aspect;
    const centreX = chosen ? chosen.x + chosen.width / 2 : frame.width / 2;
    const centreY = chosen ? chosen.y + chosen.height / 2 : frame.height / 2;

    return {
        x: clamp(centreX - width / 2, 0, frame.width - width) / frame.width,
        y: clamp(centreY - height / 2, 0, frame.height - height) / frame.height,
        w: width / frame.width,
        h: height / frame.height,
    };
};
