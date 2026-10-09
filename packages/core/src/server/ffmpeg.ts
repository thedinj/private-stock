import { existsSync } from "node:fs";

/**
 * Where ffmpeg is, and how to ask it for one frame (§9, §13).
 *
 * In `core/server` rather than in the worker because two processes need it now. The worker
 * makes covers, posters, sprites and previews; the web app extracts the single frame someone
 * pressed a button for, which is the one piece of ffmpeg work that happens inside a request
 * (§13). The argument list in particular must have exactly one definition — `-ss` before
 * `-i` is the difference between milliseconds and minutes, and a second copy of it is a
 * second chance to get that backwards.
 *
 * Only the arguments and the binary's location live here. *How* to spawn it stays with each
 * caller: background work lowers its child's priority (§7c), and a request must not.
 */

/** A frame that takes longer than this to extract means a broken file, not a slow one. */
export const FRAME_TIMEOUT_MS = 60_000;

/**
 * Frames the `thumbnail` filter considers before choosing one.
 *
 * The filter scores each frame in the batch against the batch's average histogram and picks
 * the most representative — which is what makes it skip fades, hard cuts and near-uniform
 * frames rather than taking whatever happened to land on the seek point. Sixty frames is
 * roughly two seconds of material, enough to escape a fade without decoding meaningfully
 * more than a single frame would have cost after the seek.
 */
const THUMBNAIL_BATCH = 60;

export interface ExtractFrameOptions {
    /** Position in the source, in milliseconds. Omitted for still images. */
    atMs?: number;
    /** Target width. Height follows the source aspect ratio; the image is never upscaled. */
    width: number;
    /**
     * Pick a representative frame near the seek point rather than the exact one.
     *
     * Wanted for covers and posters, not for a user's capture — someone who paused on a
     * frame and pressed the button means *that* frame, and quietly saving a different one two
     * seconds later would be baffling.
     */
    representative?: boolean;
    /** WebP quality, 0-100. */
    quality?: number;
    /**
     * Keep only this region, as fractions of the frame, before scaling: a tag's picture (§6).
     * Numbers rather than a filter string, for the reason `forRecognition` is a flag.
     */
    crop?: { x: number; y: number; w: number; h: number };
    /**
     * Prepare the frame to be read by an OCR engine rather than looked at (§5d).
     *
     * Greyscale, because colour is noise to the engine, and a mild contrast stretch, because
     * burned-in text is usually flat white over whatever happens to be behind it — which is
     * the case a stretch helps most. Stated as a flag rather than accepted as a filter string
     * from the caller: filter syntax is where a Windows drive letter's colon and every
     * backslash stop being path characters, and this file is where that is already known.
     */
    forRecognition?: boolean;
    /**
     * With `forRecognition`, a much stronger stretch and a sharpen, for a faint watermark that
     * the mild one leaves too thin to read. The calibration harness's `--contrast` filter; an
     * administrator turns it on (§5d "Settings"), because on ordinary text it adds noise.
     */
    strongContrast?: boolean;
}

/**
 * `crop` over fractions of the input, rounded down to even pixels, which some encoders require.
 * Each number is formatted here, so nothing but digits and a point reaches the filter string.
 */
const cropFilter = (crop: { x: number; y: number; w: number; h: number }): string => {
    const fraction = (value: number): string => {
        if (!Number.isFinite(value) || value < 0 || value > 1.0001) {
            throw new RangeError(`A crop is fractions of the frame, not ${value}`);
        }

        return Math.min(value, 1).toFixed(6);
    };
    const even = (expression: string): string => `trunc(${expression}/2)*2`;

    return (
        `crop=${even(`iw*${fraction(crop.w)}`)}:${even(`ih*${fraction(crop.h)}`)}` +
        `:${even(`iw*${fraction(crop.x)}`)}:${even(`ih*${fraction(crop.y)}`)}`
    );
};

/**
 * The ffmpeg arguments that write one frame of `inputPath` to `outputPath` as WebP.
 *
 * `-ss` goes **before** `-i`, which makes ffmpeg seek by container index rather than decoding
 * from the start of the file. For a two-hour video the difference is a few milliseconds
 * against a few minutes, and it is the entire reason frame extraction is affordable on a NAS
 * — and the reason a capture can be served from inside a request at all.
 *
 * Pure, so the ordering above can be asserted in a unit test rather than discovered as a
 * performance cliff on somebody's NAS.
 */
export const frameArgs = (
    inputPath: string,
    outputPath: string,
    options: ExtractFrameOptions
): string[] => {
    // `min(iw, W)` never enlarges a small source: a 320px clip upscaled to 640 is blurry and
    // costs four times the bytes to say nothing more. `-2` keeps the height even, which some
    // encoders require and none object to.
    const scale = `scale='min(${options.width},iw)':-2:flags=lanczos`;
    const cropped = options.crop ? `${cropFilter(options.crop)},${scale}` : scale;
    const staged = options.representative ? `thumbnail=${THUMBNAIL_BATCH},${cropped}` : cropped;
    const recognise = options.strongContrast
        ? "format=gray,eq=contrast=1.6:brightness=0.02,unsharp=5:5:1.0"
        : "format=gray,eq=contrast=1.15";
    const filters = options.forRecognition ? `${staged},${recognise}` : staged;

    return [
        "-v",
        "error",
        // Overwrite: a retry after a partial write must not stall waiting for a y/n that
        // nobody is there to type.
        "-y",
        ...(options.atMs !== undefined ? ["-ss", (options.atMs / 1000).toFixed(3)] : []),
        "-i",
        inputPath,
        // Audio and subtitles would be decoded for nothing.
        "-an",
        "-sn",
        "-vf",
        filters,
        "-frames:v",
        "1",
        "-q:v",
        String(options.quality ?? 80),
        outputPath,
    ];
};

/**
 * Locating ffmpeg and ffprobe.
 *
 * Two environments with opposite needs:
 *
 *  - **Development**, where nobody should have to install ffmpeg by hand — the pinned
 *    `ffmpeg-static` / `ffprobe-static` dev dependencies provide it.
 *  - **The container**, which uses the distro build because it links the system libraries
 *    the hardware-acceleration paths need, and because bundling a second copy of ffmpeg into
 *    an image that already has one is wasteful.
 *
 * Resolution order therefore is: explicit env override, then PATH, then the static packages.
 * The env override exists so a NAS user with a better ffmpeg (one built with QSV, say) can
 * point at it without rebuilding the image.
 *
 * `ffmpeg-static` and `ffprobe-static` are dev dependencies **of this package**, which looks
 * misplaced and is not. The fallback is a dynamic import, and an import resolves from the
 * module that performs it — so with them declared only on the worker, moving this file here
 * left every ffmpeg call in development unable to find a binary while the code looked
 * correct. They stay out of the image either way, which installs production dependencies
 * only and uses the distro build.
 */

const fromStaticPackage = async (packageName: string): Promise<string | null> => {
    try {
        /**
         * `webpackIgnore` because the specifier is a variable, which Next's bundler reports
         * as "Critical dependency: the request of a dependency is an expression" on every
         * dev build — it cannot see what is being imported, so it gives up and warns.
         *
         * Leaving it to Node is the intended behaviour rather than a workaround. These are
         * optional development-only packages that may not be installed at all, and the
         * container deliberately does not have them: it uses the distro ffmpeg. A bundler
         * that succeeded in resolving them would be doing the wrong thing.
         */
        const module = (await import(/* webpackIgnore: true */ packageName)) as {
            default?: unknown;
            path?: unknown;
        };
        const candidate = module.path ?? module.default;

        // ffmpeg-static exports a string; ffprobe-static exports { path }.
        const resolved =
            typeof candidate === "string"
                ? candidate
                : typeof (candidate as { path?: unknown } | undefined)?.path === "string"
                  ? (candidate as { path: string }).path
                  : null;

        return resolved && existsSync(resolved) ? resolved : null;
    } catch {
        return null;
    }
};

const onPath = (name: string): string | null => {
    // Trusting PATH is correct in the container, where ffmpeg is installed by the image.
    // `spawn` will surface a clear ENOENT if it is not actually there.
    const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
    const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];

    for (const dir of dirs) {
        if (!dir) continue;

        for (const ext of exts) {
            const candidate = `${dir}${process.platform === "win32" ? "\\" : "/"}${name}${ext}`;
            if (existsSync(candidate)) {
                return candidate;
            }
        }
    }

    return null;
};

let ffmpegPath: string | null | undefined;
let ffprobePath: string | null | undefined;
let tesseractPath: string | null | undefined;

export const resolveFfprobe = async (): Promise<string> => {
    if (ffprobePath === undefined) {
        ffprobePath =
            process.env.PRIVATE_STOCK_FFPROBE ??
            onPath("ffprobe") ??
            (await fromStaticPackage("ffprobe-static"));
    }

    if (!ffprobePath) {
        throw new Error(
            "ffprobe not found. Install ffmpeg, or set PRIVATE_STOCK_FFPROBE to its path."
        );
    }

    return ffprobePath;
};

/**
 * Where Tesseract is (§5d).
 *
 * No static-package fallback, unlike ffmpeg: the npm builds bundle their own language data
 * and are large, and the container installs `tesseract-ocr` and `tesseract-ocr-eng` from the
 * distribution anyway. So there are exactly two answers, and the error names both — a person
 * who has not installed it needs to be told what to do, not that something was not found.
 *
 * OCR is `onDemand`, so a library without Tesseract runs normally and only fails when
 * somebody asks for text. That is the right shape: the absence should surface at the moment
 * it matters and not before.
 */
export const resolveTesseract = (): string => {
    if (tesseractPath === undefined) {
        tesseractPath = process.env.PRIVATE_STOCK_TESSERACT ?? onPath("tesseract");
    }

    if (!tesseractPath) {
        throw new Error(
            "Tesseract not found. Install tesseract-ocr, or set PRIVATE_STOCK_TESSERACT to its path."
        );
    }

    return tesseractPath;
};

export const resolveFfmpeg = async (): Promise<string> => {
    if (ffmpegPath === undefined) {
        ffmpegPath =
            process.env.PRIVATE_STOCK_FFMPEG ??
            onPath("ffmpeg") ??
            (await fromStaticPackage("ffmpeg-static"));
    }

    if (!ffmpegPath) {
        throw new Error(
            "ffmpeg not found. Install ffmpeg, or set PRIVATE_STOCK_FFMPEG to its path."
        );
    }

    return ffmpegPath;
};
