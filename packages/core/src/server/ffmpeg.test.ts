import { describe, expect, it } from "vitest";

import { frameArgs } from "./ffmpeg.js";

/**
 * The frame arguments, which two processes now share (§13).
 *
 * Worth asserting rather than trusting, because both of the things that matter here fail
 * silently: a seek in the wrong place is a performance cliff nobody sees until a NAS is
 * involved, and the `thumbnail` filter saves a *different* frame from the one asked for
 * while still producing a perfectly good picture.
 */

describe("frameArgs", () => {
    it("seeks before opening the input", () => {
        const args = frameArgs("/media/film.mkv", "/data/art/x/capture-0.webp", {
            atMs: 3_600_000,
            width: 640,
        });

        // `-ss` after `-i` makes ffmpeg decode from the start of the file. For a two-hour
        // video that is minutes instead of milliseconds, and nothing about the output would
        // look wrong — which is exactly why it needs a test rather than a comment.
        expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
        expect(args[args.indexOf("-ss") + 1]).toBe("3600.000");
    });

    it("crops before scaling, in even pixels, and refuses a crop off the frame", () => {
        const args = frameArgs("/in.mkv", "/out.webp", {
            atMs: 0,
            width: 600,
            crop: { x: 0.25, y: 0, w: 0.5, h: 1 },
        });
        const filters = args[args.indexOf("-vf") + 1];

        expect(filters).toBe(
            "crop=trunc(iw*0.500000/2)*2:trunc(ih*1.000000/2)*2" +
                ":trunc(iw*0.250000/2)*2:trunc(ih*0.000000/2)*2," +
                "scale='min(600,iw)':-2:flags=lanczos"
        );
        expect(() =>
            frameArgs("/in.mkv", "/out.webp", { width: 600, crop: { x: 2, y: 0, w: 0.5, h: 1 } })
        ).toThrow(RangeError);
    });

    it("omits the seek entirely for a still image", () => {
        const args = frameArgs("/media/photo.jpg", "/data/art/x/cover.webp", { width: 640 });

        expect(args).not.toContain("-ss");
    });

    it("asks for a representative frame only when told to", () => {
        const cover = frameArgs("/in.mkv", "/out.webp", {
            atMs: 0,
            width: 640,
            representative: true,
        });
        const capture = frameArgs("/in.mkv", "/out.webp", { atMs: 0, width: 640 });

        // The filter is what makes an automatic cover step over fades and title cards. On a
        // capture it would quietly save a moment up to two seconds away from the one on
        // screen, which is baffling rather than helpful.
        expect(cover.join(" ")).toContain("thumbnail=");
        expect(capture.join(" ")).not.toContain("thumbnail");
    });

    it("never enlarges a source smaller than the target", () => {
        const args = frameArgs("/in.mkv", "/out.webp", { atMs: 0, width: 640 }).join(" ");

        // A 320px clip blown up to 640 is blurry and costs four times the bytes to say
        // nothing more.
        expect(args).toContain("min(640,iw)");
    });

    it("passes paths as arguments rather than building a command line", () => {
        // Media libraries are full of names with quotes and semicolons in them. These go to
        // the process directly, so a filename is only ever a filename.
        const args = frameArgs("/media/it's; fine.mkv", "/out.webp", { width: 640 });

        expect(args).toContain("/media/it's; fine.mkv");
    });
});

describe("frames for recognition", () => {
    const filters = (options: { strongContrast?: boolean }) => {
        const args = frameArgs("/media/film.mkv", "/tmp/f.webp", {
            width: 1280,
            forRecognition: true,
            ...options,
        });

        return args[args.indexOf("-vf") + 1];
    };

    it("stretches mildly by default, and hard when faint text is being boosted", () => {
        expect(filters({})).toContain("eq=contrast=1.15");
        expect(filters({ strongContrast: true })).toContain("eq=contrast=1.6");
        expect(filters({ strongContrast: true })).toContain("unsharp");
    });

    it("leaves a picture for looking at alone", () => {
        const args = frameArgs("/media/film.mkv", "/tmp/f.webp", {
            width: 640,
            strongContrast: true,
        });

        expect(args[args.indexOf("-vf") + 1]).not.toContain("eq=");
    });
});
