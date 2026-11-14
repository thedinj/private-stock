import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ProbeResult } from "@private-stock/db";

import { resolveFfprobe } from "./binaries.js";

const execFileAsync = promisify(execFile);

/**
 * Reading metadata out of a media file with ffprobe.
 *
 * `execFile`, never `exec`: the argument list goes to the process directly rather than
 * through a shell, so a filename containing a quote, a semicolon, or a backtick is just a
 * filename. Media libraries are full of such names.
 */

/** A file that takes longer than this to probe is broken, not slow. */
const PROBE_TIMEOUT_MS = 30_000;

export interface ProbeStream {
    kind: "video" | "audio" | "subtitle";
    streamIndex: number;
    codec: string | null;
    language: string | null;
    title: string | null;
    channels: number | null;
    isDefault: boolean;
    isForced: boolean;
}

export interface FullProbe extends ProbeResult {
    streams: ProbeStream[];
}

interface FfprobeStream {
    index: number;
    codec_type?: string;
    codec_name?: string;
    profile?: string | number;
    level?: number;
    pix_fmt?: string;
    width?: number;
    height?: number;
    channels?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    nb_frames?: string;
    disposition?: Record<string, number>;
    tags?: Record<string, string>;
}

interface FfprobeOutput {
    streams?: FfprobeStream[];
    format?: {
        duration?: string;
        bit_rate?: string;
        format_name?: string;
        tags?: Record<string, string>;
    };
}

/** "30000/1001" → 29.97. Returns null for the "0/0" ffprobe reports on still images. */
const parseFrameRate = (value: string | undefined): number | null => {
    if (!value) return null;

    const [numerator, denominator] = value.split("/").map(Number);

    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
        return null;
    }

    const fps = numerator / denominator;

    return fps > 0 ? Math.round(fps * 1000) / 1000 : null;
};

/**
 * `r_frame_rate` as the rational an editor needs (§14d "Editor export").
 *
 * The nominal rate, not the average: a 30000/1001 camera file says so exactly here, and an
 * average over a file with one dropped frame does not. Both halves are capped at what a real
 * rate needs -- ffprobe reports 90000/1 for some broken streams, and that is not a timeline.
 */
const parseRationalRate = (
    value: string | undefined
): { fpsNum: number; fpsDen: number } | null => {
    const match = /^(\d+)\/(\d+)$/.exec(value ?? "");

    if (!match) return null;

    const fpsNum = Number(match[1]);
    const fpsDen = Number(match[2]);

    if (fpsNum <= 0 || fpsDen <= 0 || fpsNum / fpsDen > 240 || fpsNum > 1_000_000) return null;

    return { fpsNum, fpsDen };
};

/**
 * Whether the frames arrive at a varying rate, which phones do: the average strays from the
 * nominal by more than a percent. An editor conforms such a file and in-points drift, so the
 * export warns about it rather than pretending.
 */
const isVariableRate = (stream: FfprobeStream | undefined): boolean => {
    const nominal = parseFrameRate(stream?.r_frame_rate);
    const average = parseFrameRate(stream?.avg_frame_rate);

    return nominal !== null && average !== null && Math.abs(nominal - average) / nominal > 0.01;
};

/**
 * The SMPTE start timecode a camera writes: a `tmcd` data stream's tag, the video stream's, or
 * the container's. Kept only in the shape a timecode has.
 */
const parseTimecode = (output: FfprobeOutput): string | null => {
    const raw =
        output.streams?.find((stream) => stream.tags?.timecode)?.tags?.timecode ??
        output.format?.tags?.timecode;

    return raw && /^\d{1,2}:\d{2}:\d{2}[:;.,]\d{2}$/.test(raw.trim()) ? raw.trim() : null;
};

/** The editor-export facts of a probe's output (§14d). */
const timingOf = (
    output: FfprobeOutput
): {
    fpsNum: number | null;
    fpsDen: number | null;
    isVfr: boolean;
    timecodeStart: string | null;
} => {
    const video = output.streams?.find((stream) => stream.codec_type === "video");

    return {
        ...(parseRationalRate(video?.r_frame_rate) ?? { fpsNum: null, fpsDen: null }),
        isVfr: isVariableRate(video),
        timecodeStart: parseTimecode(output),
    };
};

/**
 * Only the timing facts, for the `timing` stage's sweep over items probed before they were
 * recorded. Streams and container tags, never frames: one header read.
 */
export const readTiming = async (absolutePath: string): Promise<ReturnType<typeof timingOf>> => {
    const ffprobe = await resolveFfprobe();

    const { stdout } = await execFileAsync(
        ffprobe,
        [
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,r_frame_rate,avg_frame_rate:stream_tags=timecode:format_tags=timecode",
            "-of",
            "json",
            absolutePath,
        ],
        { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
    );

    return timingOf(JSON.parse(stdout) as FfprobeOutput);
};

/**
 * Capture date from container or EXIF tags.
 *
 * Only tags that actually mean "when this was recorded" are used. `creation_time` on a
 * re-encoded file is the date of the *encode*, but it is still the best available signal and
 * a wrong-but-plausible date beats none — the UI sorts by `addedAt` by default for exactly
 * this reason.
 */
const parseCapturedAt = (tags: Record<string, string> | undefined): string | null => {
    const raw =
        tags?.creation_time ??
        tags?.["com.apple.quicktime.creationdate"] ??
        tags?.date ??
        tags?.DateTimeOriginal;

    if (!raw) return null;

    // EXIF uses "2024:03:11 14:22:05", which Date cannot parse.
    const normalised = /^\d{4}:\d{2}:\d{2}/.test(raw)
        ? raw.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").replace(" ", "T")
        : raw;

    const parsed = new Date(normalised);

    if (Number.isNaN(parsed.getTime())) return null;

    // Cameras with a dead clock report 1970 or 1904 (QuickTime's epoch); both are noise.
    if (parsed.getUTCFullYear() < 1980 || parsed.getTime() > Date.now() + 86_400_000) {
        return null;
    }

    return parsed.toISOString();
};

/**
 * The descriptive tags worth keeping, in the order they are stored (§5b).
 *
 * Sampled on the real library (2026-10-11): about one video in fourteen carries any of these,
 * and in the ones that do they are often the only record of who is in it or where it was
 * posted -- a creator's handle in a title or comment, a site in an artist or album. Everything
 * else the containers carry is the encoder talking: brands, handler names, `Lavf58.29.100`.
 */
const EMBEDDED_KEYS = ["title", "comment", "description", "artist", "album", "show"] as const;

/** `MediaAttribute.value`'s CHECK. */
const MAX_EMBEDDED_LENGTH = 2000;

/**
 * A tag's value as text: markup out, whitespace collapsed.
 *
 * Descriptions arrive as the HTML of the post they were copied from (`<p>Here…`), and a `p` is
 * not something to show, search or match a name against.
 */
const plainText = (value: string): string =>
    value
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

/**
 * Descriptive text the file carries about itself, keyed by tag.
 *
 * Container-level tags only. Stream titles are already `MediaStream.title`, and the keys are
 * matched case-insensitively because Matroska writes `TITLE` where MP4 writes `title`.
 */
export const readEmbeddedText = async (absolutePath: string): Promise<Map<string, string>> => {
    const ffprobe = await resolveFfprobe();

    const { stdout } = await execFileAsync(
        ffprobe,
        ["-v", "error", "-show_entries", "format_tags", "-of", "json", absolutePath],
        { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
    );

    const tags = (JSON.parse(stdout) as FfprobeOutput).format?.tags ?? {};
    const byKey = new Map(
        Object.entries(tags).map(([key, value]) => [key.toLowerCase(), plainText(String(value))])
    );
    const found = new Map<string, string>();

    for (const key of EMBEDDED_KEYS) {
        const value = byKey.get(key);

        if (value) {
            found.set(key, value.slice(0, MAX_EMBEDDED_LENGTH));
        }
    }

    return found;
};

export const probeFile = async (absolutePath: string): Promise<FullProbe> => {
    const ffprobe = await resolveFfprobe();

    const { stdout } = await execFileAsync(
        ffprobe,
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", absolutePath],
        { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
    );

    const output = JSON.parse(stdout) as FfprobeOutput;
    const streams = output.streams ?? [];

    const video = streams.find((stream) => stream.codec_type === "video");

    /**
     * The audio track a player would pick by default.
     *
     * Denormalised onto Media so the playability check does not need a join per row (§8). The
     * dispositioned default wins; failing that, the first audio stream, which is what every
     * player does when nothing is marked.
     */
    const audio =
        streams.find(
            (stream) => stream.codec_type === "audio" && stream.disposition?.default === 1
        ) ?? streams.find((stream) => stream.codec_type === "audio");
    const durationSeconds = Number(output.format?.duration);
    const bitrate = Number(output.format?.bit_rate);

    // A single-frame "video" stream is a still image, not a one-frame movie. This is how a
    // JPEG and an animated GIF are told apart, since ffprobe calls both a video stream.
    const frameCount = Number(video?.nb_frames ?? "0");
    const isAnimated = frameCount > 1 || (durationSeconds > 0.2 && frameCount !== 1);

    return {
        durationMs:
            Number.isFinite(durationSeconds) && durationSeconds > 0
                ? Math.round(durationSeconds * 1000)
                : null,
        width: video?.width ?? null,
        height: video?.height ?? null,
        codec: video?.codec_name ?? null,
        // ffprobe reports the profile as a string for H.264 ("High 10") but as a number for
        // some codecs; the playability check reads it as text either way.
        videoProfile: video?.profile === undefined ? null : String(video.profile),
        videoLevel: typeof video?.level === "number" ? video.level : null,
        pixFmt: video?.pix_fmt ?? null,
        audioCodec: audio?.codec_name ?? null,
        audioChannels: audio?.channels ?? null,
        container: output.format?.format_name ?? null,
        bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : null,
        fps: parseFrameRate(video?.avg_frame_rate ?? video?.r_frame_rate),
        ...timingOf(output),
        capturedAt: parseCapturedAt({ ...output.format?.tags, ...video?.tags }),
        isAnimated,
        streams: streams
            .filter((stream) => ["video", "audio", "subtitle"].includes(stream.codec_type ?? ""))
            .map((stream) => ({
                kind: stream.codec_type as "video" | "audio" | "subtitle",
                streamIndex: stream.index,
                codec: stream.codec_name ?? null,
                language: stream.tags?.language ?? null,
                title: stream.tags?.title ?? null,
                channels: stream.channels ?? null,
                isDefault: stream.disposition?.default === 1,
                isForced: stream.disposition?.forced === 1,
            })),
    };
};
