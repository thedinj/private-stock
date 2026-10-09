import { stat } from "node:fs/promises";
import * as path from "node:path";

import {
    WEBSAFE_PROFILE,
    assessPlayback,
    describeBlocker,
    stagePolicySchema,
    transcodeEnabled,
    transcodeSettingsSchema,
    variantRelPath,
    type TranscodeSettings,
    SETTING_KEYS,
} from "@private-stock/core";
import { dataPaths, loadConfig } from "@private-stock/core/server";
import { db, mediaRepo, settingRepo, variantRepo } from "@private-stock/db";

import { probeFile } from "../media/probe.js";
import { resolveSource } from "../media/sourcePath.js";
import { runTranscode } from "../media/transcode.js";
import { placeDataFile, twinsOf } from "../media/twin.js";
import { isPolite, threadsPerJob, throttleState } from "../throttle.js";
import { heartbeat, type JobRow } from "../queue.js";

/**
 * The `transcode` job: make an unplayable file playable (§8).
 *
 * This is the preferred path over on-demand HLS. It costs CPU once, in the background, and
 * afterwards the file is direct play again — which is the only mode that performs acceptably
 * on a NAS with several viewers.
 */

export const loadTranscodeSettings = (): TranscodeSettings =>
    transcodeSettingsSchema.parse(settingRepo.get(SETTING_KEYS.transcode, {}));

/**
 * Whether transcoding is switched on: its entry in the stage policy (§7b, §8).
 *
 * Read on every claim and every backfill pass rather than cached, so switching it off stops
 * new work at the next job rather than the next restart.
 */
export const transcodingEnabled = (): boolean => {
    const parsed = stagePolicySchema.safeParse(settingRepo.get(SETTING_KEYS.stagePolicy, {}));

    return parsed.success && transcodeEnabled(parsed.data);
};

/**
 * What actually came out, read from the file rather than predicted.
 *
 * The row used to be filled in from the *source* — `width: media.width` with only the height
 * capped — on the reasoning that we know what we asked ffmpeg for. We do not. The scale
 * filter (§8) forces both axes even and derives the width from the height it settles on, so a
 * 445x345 source becomes a 444x344 file while the row claimed 445x345. Worse, the width was
 * never scaled at all: the first source taller than `maxHeight` would have been recorded as
 * 1920x720 — not a rounding error but a wrong aspect ratio, in the column a player uses to
 * shape the frame before the first byte arrives.
 *
 * Computing it correctly here was the other option and is the one that rots. It would mean a
 * second implementation of the filter's rounding, kept in step with the filter by hand, and
 * VAAPI's scaler does not round identically to libswscale anyway. Probing cannot disagree with
 * the file, whatever produced it.
 *
 * One ffprobe against a local file, after an encode that ran for minutes. Null on failure
 * rather than throwing: the encode succeeded and the file is good, so losing it over the
 * metadata read would be the worse trade — the caller falls back to the old estimate.
 */
const describeOutput = async (
    outputPath: string
): Promise<{
    width: number | null;
    height: number | null;
    codec: string | null;
    bitrate: number | null;
} | null> => {
    try {
        const probe = await probeFile(outputPath);

        return {
            width: probe.width,
            height: probe.height,
            codec: probe.codec,
            bitrate: probe.bitrate,
        };
    } catch (error) {
        console.warn(
            `Could not probe the variant just written (${outputPath}); ` +
                `recording the requested dimensions instead: ${(error as Error).message}`
        );

        return null;
    }
};

/**
 * Take the rendition an identical copy already has, rather than encoding another (§10f).
 *
 * The largest saving of all: an encode can hold the box for an hour, and the copy is a hard
 * link, so it costs no disk either. Safe to link because the encoder only ever lands a file
 * by renaming over it, and retention deletes by unlinking — neither can reach the twin's file
 * through this one.
 *
 * Any ready rendition will do, not only a twin whose stage is settled: transcoding is not a
 * registry stage (§7b), and `ready` is the whole of its record.
 */
const borrowVariant = async (
    mediaId: string,
    fileId: string,
    rootId: string,
    relPath: string
): Promise<boolean> => {
    for (const twinMediaId of twinsOf(fileId)) {
        const variant = variantRepo.findOne(twinMediaId, WEBSAFE_PROFILE);

        if (!variant?.ready) {
            continue;
        }

        try {
            await placeDataFile(variant.relPath, relPath, { hardlink: true });
        } catch (error) {
            console.warn(
                `Could not borrow the rendition of ${twinMediaId} for its identical copy ` +
                    `${mediaId}: ${(error as Error).message}`
            );
            continue;
        }

        db.transaction(() => {
            variantRepo.upsert({
                mediaId,
                profile: WEBSAFE_PROFILE,
                relPath,
                codec: variant.codec,
                width: variant.width,
                height: variant.height,
                bitrate: variant.bitrate,
                bytes: variant.bytes,
                ready: true,
            });

            variantRepo.recordVariantChange(mediaId, rootId);
        })();

        console.log(`Borrowed the rendition of ${twinMediaId} for its identical copy ${mediaId}`);

        return true;
    }

    return false;
};

export const runTranscodeJob = async (job: JobRow, signal: AbortSignal): Promise<void> => {
    if (!job.mediaId || !job.fileId) {
        throw new Error("transcode job requires both mediaId and fileId");
    }

    if (!transcodingEnabled()) {
        // Switched off by an admin between enqueue and claim. Not a failure.
        return;
    }

    const settings = loadTranscodeSettings();

    const mediaId = job.mediaId;
    const media = mediaRepo.findBasic(mediaId);

    if (!media || media.kind !== "video") {
        return;
    }

    const source = resolveSource(job.fileId);

    if (!source) {
        return;
    }

    const assessment = assessPlayback({
        kind: media.kind,
        relPath: source.relPath,
        container: media.container,
        codec: media.codec,
        videoProfile: media.videoProfile,
        pixFmt: media.pixFmt,
        audioCodec: media.audioCodec,
        probedAt: media.probedAt,
    });

    if (assessment.directPlay) {
        // Re-probed since the job was queued, or queued in error. Transcoding a file that
        // already plays is the most expensive possible no-op.
        return;
    }

    const existing = variantRepo.findOne(mediaId, WEBSAFE_PROFILE);

    if (existing?.ready) {
        return;
    }

    const config = loadConfig();
    const relPath = variantRelPath(mediaId, WEBSAFE_PROFILE);
    const outputPath = path.resolve(config.dataDir, relPath);

    // Everything this job writes belongs under dataDir/variants. The app's only write to a
    // media root is a delete (§18.1).
    const variantRoot = dataPaths(config).variants;
    if (!outputPath.startsWith(variantRoot + path.sep)) {
        throw new Error(`Refusing to write a variant outside ${variantRoot}`);
    }

    if (await borrowVariant(mediaId, job.fileId, source.rootId, relPath)) {
        return;
    }

    const reason = assessment.blockers.map(describeBlocker).join("; ");
    console.log(
        `Transcoding ${mediaId} (${assessment.remuxOnly ? "remux" : "re-encode"}): ${reason}`
    );

    const result = await runTranscode({
        inputPath: source.absolutePath,
        outputPath,
        settings,
        remuxOnly: assessment.remuxOnly,
        videoNeedsEncode:
            assessment.blockers.includes("videoCodec") ||
            assessment.blockers.includes("videoProfile") ||
            assessment.blockers.includes("pixelFormat"),
        audioNeedsEncode: assessment.blockers.includes("audioCodec"),
        /**
         * The only lever that actually caps this job (§7c).
         *
         * Concurrency throttling cannot touch a transcode -- it is pinned at one job at every
         * hour -- and priority only decides who wins a contested core. Always held to the
         * threads its CPU slot stands for, requested or not: the budget is a statement about
         * how many cores exist, and an uncapped encode under the container's quota freezes the
         * web process with it (§20). Inside the window the window's own share may be lower.
         */
        threads: Math.min(
            threadsPerJob(),
            (isPolite() ? throttleState().threads : null) ?? Number.POSITIVE_INFINITY
        ),
        durationMs: media.durationMs,
        // Progress doubles as the heartbeat. A transcode can run for an hour, far longer than
        // the stale-claim window, so without this the queue would reclaim a job that is
        // working perfectly well and start a second copy of it.
        onProgress: (fraction) => heartbeat(db, job.id, fraction),
        // Cancelling kills the ffmpeg child and removes the partial file. This is the reason
        // the signal exists at all: a transcode is the one job long enough that somebody
        // watching it wants a way to stop it, and an hour of CPU on a NAS is worth stopping.
        signal,
    });

    const stats = await stat(outputPath);
    const produced = await describeOutput(outputPath);

    db.transaction(() => {
        variantRepo.upsert({
            mediaId,
            profile: WEBSAFE_PROFILE,
            relPath,
            codec: produced?.codec ?? (result.remux ? media.codec : "h264"),
            width: produced?.width ?? media.width,
            height:
                produced?.height ??
                (result.remux ? media.height : Math.min(media.height ?? 0, settings.maxHeight)),
            bitrate: produced?.bitrate ?? null,
            bytes: stats.size,
            ready: true,
        });

        variantRepo.recordVariantChange(mediaId, source.rootId);
    })();

    console.log(
        `Transcoded ${mediaId} in ${Math.round(result.elapsedMs / 1000)}s ` +
            `(${Math.round(stats.size / 1_048_576)} MB)`
    );
};
