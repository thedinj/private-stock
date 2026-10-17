import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import {
    assertSafeRelativePath,
    assessPlayback,
    parseKeyframes,
    segmentIndexRelPath,
    segmentIndexSchema,
    type SegmentIndex,
    type StageOutcome,
} from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";
import { mediaRepo } from "@private-stock/db";

import { writeInPlace } from "../embed/pictures.js";
import { resolveFfprobe } from "../media/binaries.js";
import { execFilePolitely } from "../media/politeSpawn.js";
import { resolveSource } from "../media/sourcePath.js";
import { settledTwin } from "../media/twin.js";
import type { JobRow } from "../queue.js";

/**
 * The `segments` job: where an MPEG-TS file's keyframes are (§8, "Playing an MPEG-TS file
 * without copying it").
 *
 * ffprobe lists the video stream's packets, which means reading the whole file once -- the
 * container has no index to read instead, which is the whole reason this exists. What it keeps
 * is a few thousand pairs of numbers; the stream route turns them into a playlist of byte ranges
 * of the original.
 */

/** A whole file read from NAS disks, at a few hundred MB a minute when they are busy. */
const PROBE_TIMEOUT_MS = 30 * 60_000;

const absolute = (relPath: string): string =>
    path.resolve(loadConfig().dataDir, assertSafeRelativePath(relPath));

/** Exported for the integration test, which holds it to a file ffmpeg really wrote. */
export const readKeyframes = async (filePath: string): Promise<[number, number][]> => {
    const ffprobe = await resolveFfprobe();
    const { stdout } = await execFilePolitely(
        ffprobe,
        [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts_time,pos,flags",
            "-of",
            "csv=p=0",
            filePath,
        ],
        // A line per video packet: a two-hour film at 60 fps is about ten megabytes.
        { timeout: PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 }
    );

    return parseKeyframes(String(stdout));
};

/** A byte-identical twin's index, restamped with this file's identity. Null if unusable. */
const twinIndex = async (
    twinMediaId: string,
    identity: Pick<SegmentIndex, "sizeBytes" | "mtimeMs">
): Promise<SegmentIndex | null> => {
    try {
        const parsed = segmentIndexSchema.safeParse(
            JSON.parse(await readFile(absolute(segmentIndexRelPath(twinMediaId)), "utf8"))
        );

        return parsed.success ? { ...parsed.data, ...identity } : null;
    } catch {
        return null;
    }
};

export const runSegments = async (job: JobRow): Promise<StageOutcome | void> => {
    if (!job.mediaId || !job.fileId) {
        throw new Error("segments job requires both mediaId and fileId");
    }

    const media = mediaRepo.findBasic(job.mediaId);

    // Only a file that plays as segments needs its keyframes found. Not applicable rather than
    // not done, so the sweep stops offering it -- which is every video but a few.
    if (!media || media.kind !== "video" || assessPlayback(media).via !== "segments") {
        return "skipped";
    }

    if (!media.durationMs) {
        return "empty";
    }

    const source = resolveSource(job.fileId);

    if (!source) {
        return "skipped";
    }

    const stats = await stat(source.absolutePath);
    const identity = { sizeBytes: stats.size, mtimeMs: stats.mtimeMs };

    // An identical copy has already been read, which is the expensive part (§10f).
    const twin = settledTwin(job.fileId, "segments");

    if (twin?.state === "empty") {
        return "empty";
    }

    const adopted = twin ? await twinIndex(twin.mediaId, identity) : null;
    const keyframes = adopted ? adopted.keyframes : await readKeyframes(source.absolutePath);

    if (keyframes.length === 0) {
        // Nothing to start a picture from. The file will not play this way, and a retry would
        // read it all again to find the same.
        return "empty";
    }

    const index: SegmentIndex = segmentIndexSchema.parse({
        version: 1,
        ...identity,
        durationMs: media.durationMs,
        keyframes,
    });

    await writeInPlace(
        absolute(segmentIndexRelPath(job.mediaId)),
        new TextEncoder().encode(JSON.stringify(index))
    );
};
