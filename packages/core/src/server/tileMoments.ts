import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import {
    SPRITE_TILE_WIDTH,
    pictureDistance,
    tileCandidates,
    tileReadWindow,
    type VideoPacket,
} from "../sprites.js";
import { FRAME_TIMEOUT_MS, resolveFfmpeg, resolveFfprobe } from "./ffmpeg.js";

/**
 * Which frame a sprite tile really is (§9 "What a tile shows").
 *
 * A tile's moment is `index × interval`, and its picture is a different frame -- usually half an
 * interval later, sometimes a keyframe earlier -- by which path the sprite was read, which
 * nothing records. So the few frames it can be (`tileCandidates`) are read from the original,
 * each is compared with the tile itself, and the closest is the moment.
 *
 * Headers for the packets, then one short decode a candidate: a keyframe by `-noaccurate_seek`,
 * anything else by an exact seek from the keyframe before it. The caller holds whatever ceiling
 * applies; this only reads.
 */

const execFileAsync = promisify(execFile);

/** How ffprobe and ffmpeg are run: `execFile`, or the worker's, which lowers their priority. */
export type RunProgram = (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number }
) => Promise<{ stdout: string | Buffer }>;

export interface TileMomentsInput {
    /** The original, as an absolute path. */
    original: string;
    /** The tile's nominal moment: what a face found on it records. */
    atMs: number;
    /** The interval its sprite was sampled at. */
    intervalMs: number;
    /** The tile itself, to compare with; null when there is no sprite to ask. */
    tile: {
        sheetPath: string;
        rect: { x: number; y: number; width: number; height: number };
    } | null;
    /** Background work passes its own, so these reads give way to requests (§7c). */
    run?: RunProgram;
}

export interface TileMoments {
    /** Earliest first: each frame's time, rounded down so an exact seek to it is that frame. */
    moments: { atMs: number; thumb: Buffer }[];
    /** The one most like the tile, or null without a tile. */
    matched: number | null;
}

const formatAnswer = z.object({
    format: z.object({ start_time: z.string().optional() }).optional(),
});
const packetsAnswer = z.object({
    packets: z
        .array(z.object({ pts_time: z.string().optional(), flags: z.string().optional() }))
        .optional(),
});

const probe = async (run: RunProgram, args: string[]): Promise<unknown> => {
    const { stdout } = await run(await resolveFfprobe(), ["-v", "error", ...args], {
        timeout: FRAME_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
    });

    return JSON.parse(stdout.toString());
};

/**
 * The video's packets from `fromMs` to `toMs`, timed as `-ss` counts.
 *
 * Headers only, nothing decoded. ffprobe's `-read_intervals` are the container's own times, so
 * the start time is read first and added, then taken off every packet.
 */
const packetsBetween = async (
    run: RunProgram,
    original: string,
    fromMs: number,
    toMs: number
): Promise<VideoPacket[]> => {
    const format = formatAnswer.parse(
        await probe(run, ["-show_entries", "format=start_time", "-of", "json", original])
    );
    const startS = Number(format.format?.start_time ?? 0) || 0;
    const listed = packetsAnswer.parse(
        await probe(run, [
            "-select_streams",
            "v:0",
            "-read_intervals",
            `${(startS + fromMs / 1000).toFixed(3)}%${(startS + toMs / 1000).toFixed(3)}`,
            "-show_entries",
            "packet=pts_time,flags",
            "-of",
            "json",
            original,
        ])
    );

    return (listed.packets ?? []).flatMap((packet) => {
        const ptsS = Number(packet.pts_time);

        return Number.isFinite(ptsS)
            ? [{ ptsMs: (ptsS - startS) * 1000, key: packet.flags?.includes("K") ?? false }]
            : [];
    });
};

/** A path for one temporary file of this read, removed by whoever asked for it. */
const scratch = (extension: string): string =>
    path.join(tmpdir(), `private-stock-moment-${randomUUID()}.${extension}`);

/**
 * One frame, as the tile would be and as a thumbnail to choose it by: one decode, two outputs --
 * the greyscale pixels at the tile's size to compare, and a WebP of the same to show.
 */
const readFrame = async (
    run: RunProgram,
    original: string,
    packet: VideoPacket,
    size: { width: number; height: number }
): Promise<{ grey: Uint8Array; thumb: Buffer }> => {
    const greyPath = scratch("grey");
    const thumbPath = scratch("webp");
    // Just after a keyframe, without decoding forward, lands on it; just before anything else,
    // decoding forward, stops at it.
    const seek = packet.key
        ? ["-ss", ((packet.ptsMs + 0.5) / 1000).toFixed(4), "-noaccurate_seek"]
        : ["-ss", (Math.max(0, packet.ptsMs - 0.5) / 1000).toFixed(4)];

    try {
        await run(
            await resolveFfmpeg(),
            [
                "-v",
                "error",
                "-y",
                ...seek,
                "-i",
                original,
                "-an",
                "-sn",
                "-filter_complex",
                `[0:v]scale=${size.width}:${size.height}:flags=lanczos,split=2[a][b];[a]format=gray[g]`,
                "-map",
                "[g]",
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                greyPath,
                "-map",
                "[b]",
                "-frames:v",
                "1",
                "-c:v",
                "libwebp",
                "-q:v",
                "70",
                "-f",
                "image2",
                thumbPath,
            ],
            { timeout: FRAME_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
        );

        return {
            grey: new Uint8Array(await readFile(greyPath)),
            thumb: await readFile(thumbPath),
        };
    } finally {
        await Promise.all([rm(greyPath, { force: true }), rm(thumbPath, { force: true })]);
    }
};

/** The tile, in greyscale, cut from its sheet. */
const readTile = async (
    run: RunProgram,
    tile: NonNullable<TileMomentsInput["tile"]>
): Promise<Uint8Array> => {
    const greyPath = scratch("grey");
    const { x, y, width, height } = tile.rect;

    try {
        await run(
            await resolveFfmpeg(),
            [
                "-v",
                "error",
                "-y",
                "-i",
                tile.sheetPath,
                "-vf",
                `crop=${width}:${height}:${x}:${y},format=gray`,
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                greyPath,
            ],
            { timeout: FRAME_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
        );

        return new Uint8Array(await readFile(greyPath));
    } finally {
        await rm(greyPath, { force: true });
    }
};

/** The frames a tile at `atMs` may be, read from the original, and the one it looks like. */
export const readTileMoments = async ({
    original,
    atMs,
    intervalMs,
    tile,
    run = execFileAsync,
}: TileMomentsInput): Promise<TileMoments> => {
    const { fromMs, toMs } = tileReadWindow(atMs, intervalMs);
    let packets = await packetsBetween(run, original, fromMs, toMs);

    // The seeking path's keyframe can sit further back than an interval in a long-GOP file:
    // look once more, further back, before going without it.
    if (!packets.some((packet) => packet.key && packet.ptsMs <= atMs + 0.5)) {
        packets = await packetsBetween(run, original, Math.max(0, atMs - 120_000), toMs);
    }

    const candidates = tileCandidates(atMs, intervalMs, packets);
    const size = tile
        ? { width: tile.rect.width, height: tile.rect.height }
        : { width: SPRITE_TILE_WIDTH, height: -2 };
    const reference = tile ? await readTile(run, tile) : null;
    const frames: { grey: Uint8Array; thumb: Buffer }[] = [];

    // One at a time: each is a decode on the disks every request shares.
    for (const candidate of candidates) {
        frames.push(await readFrame(run, original, candidate, size));
    }

    const distances = frames.map((frame) =>
        reference ? pictureDistance(reference, frame.grey) : Number.POSITIVE_INFINITY
    );
    const best = distances.indexOf(Math.min(...distances));

    return {
        moments: candidates.map((candidate, index) => ({
            atMs: Math.max(0, Math.floor(candidate.ptsMs)),
            thumb: frames[index].thumb,
        })),
        matched: best >= 0 && Number.isFinite(distances[best]) ? best : null,
    };
};
