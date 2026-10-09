import { describe, expect, it } from "vitest";

import {
    AUTO_PICTURE_MIN_FACE_PX,
    centredCrop,
    coherenceOf,
    pictureAroundSquare,
    randomCoherence,
    pictureAroundFace,
    tagPictureAspect,
    tagPictureRelPath,
} from "./tagPicture.js";

const HD = { width: 1920, height: 1080 };
const PORTRAIT = tagPictureAspect("performer");

/** The crop in the frame's pixels, for assertions a person can read. */
const inPixels = (crop: { x: number; y: number; w: number; h: number }, frame = HD) => ({
    left: crop.x * frame.width,
    top: crop.y * frame.height,
    width: crop.w * frame.width,
    height: crop.h * frame.height,
});

describe("pictureAroundFace", () => {
    it("frames head and shoulders in the facet's shape, the face above the middle", () => {
        // A 200-pixel face in the middle of an HD frame.
        const face = { x: 900 / 1920, y: 400 / 1080, w: 160 / 1920, h: 200 / 1080 };
        const crop = inPixels(pictureAroundFace(face, HD, PORTRAIT)!);

        expect(crop.height).toBeCloseTo(520, 0);
        expect(crop.width / crop.height).toBeCloseTo(4 / 5, 5);
        // Centred across, and the face's centre 40% of the way down.
        expect(crop.left + crop.width / 2).toBeCloseTo(980, 0);
        expect(500 - crop.top).toBeCloseTo(crop.height * 0.4, 0);
    });

    it("moves the crop rather than cutting it where the face is near an edge", () => {
        const face = { x: 0, y: 0, w: 120 / 1920, h: 150 / 1080 };
        const crop = inPixels(pictureAroundFace(face, HD, PORTRAIT)!);

        expect(crop.left).toBe(0);
        expect(crop.top).toBe(0);
        expect(crop.height).toBeCloseTo(390, 0);
    });

    it("shrinks to the frame when the face fills it", () => {
        const face = { x: 0.3, y: 0.1, w: 0.4, h: 0.8 };
        const crop = pictureAroundFace(face, HD, PORTRAIT)!;

        expect(crop.h).toBeCloseTo(1, 5);
        expect(crop.y).toBe(0);
        expect(inPixels(crop).width / inPixels(crop).height).toBeCloseTo(4 / 5, 5);
    });

    it("declines a face too small to make a picture of", () => {
        const face = { x: 0.5, y: 0.5, w: 0.02, h: (AUTO_PICTURE_MIN_FACE_PX - 1) / 1080 };

        expect(pictureAroundFace(face, HD, PORTRAIT)).toBeNull();
    });
});

describe("centredCrop", () => {
    it("is the largest crop of the shape the frame holds", () => {
        const crop = inPixels(centredCrop(HD, PORTRAIT));

        expect(crop.height).toBeCloseTo(1080, 5);
        expect(crop.width).toBeCloseTo(864, 5);
        expect(crop.left).toBeCloseTo(528, 5);
    });
});

describe("tagPictureRelPath", () => {
    it("names one file per tag, source and size", () => {
        expect(tagPictureRelPath("6f1c2d3e-0000-4000-8000-000000000000", "user", "small")).toBe(
            "tags/6f/6f1c2d3e-0000-4000-8000-000000000000-user-small.webp"
        );
    });

    it("refuses anything that is not an id", () => {
        expect(() => tagPictureRelPath("../../etc/passwd", "user", "large")).toThrow();
    });
});

describe("coherenceOf", () => {
    it("is one for identical items and smaller as they spread", () => {
        const a = Float32Array.from([1, 0]);
        const b = Float32Array.from([0, 1]);

        expect(coherenceOf([a, a]).length).toBeCloseTo(1, 6);
        expect(coherenceOf([a, b]).length).toBeCloseTo(Math.SQRT1_2, 6);
        expect([...coherenceOf([a, b]).direction].map((v) => +v.toFixed(4))).toEqual([
            0.7071, 0.7071,
        ]);
    });
});

describe("randomCoherence", () => {
    it("is the same for the same pool every time, and spreads less for larger sets", () => {
        const pool = Array.from({ length: 200 }, (_, i) =>
            Float32Array.from([Math.cos(i), Math.sin(i)])
        );

        expect(randomCoherence(pool, 10)).toEqual(randomCoherence(pool, 10));
        expect(randomCoherence(pool, 50).sd).toBeLessThan(randomCoherence(pool, 5).sd);
    });
});

describe("pictureAroundSquare", () => {
    it("centres a frame-shaped crop on the square the look was seen in", () => {
        // An upright phone frame read as two squares, top and bottom.
        const upright = { width: 1080, height: 1920 };
        const top = inPixels(pictureAroundSquare(0, upright, 16 / 9), upright);
        const bottom = inPixels(pictureAroundSquare(1, upright, 16 / 9), upright);

        expect(top.width).toBeCloseTo(1080, 5);
        expect(top.height).toBeCloseTo(607.5, 5);
        expect(top.top + top.height / 2).toBeCloseTo(540, 5);
        expect(bottom.top + bottom.height / 2).toBeCloseTo(1380, 5);
    });

    it("is the whole frame for a frame already that shape", () => {
        expect(pictureAroundSquare(1, HD, 16 / 9)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    });
});
