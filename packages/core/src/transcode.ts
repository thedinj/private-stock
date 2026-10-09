import { z } from "zod";

/**
 * Transcode settings and ffmpeg argument construction (§8).
 *
 * The argument list is built here, as pure data, rather than inside the job. Hardware
 * acceleration is the part most likely to be wrong on any particular box — a QNAP with
 * QuickSync, a box with no `/dev/dri` at all, a build of ffmpeg without VAAPI — and a
 * pure function is something that can be tested and printed without a NAS present.
 */

/**
 * Hardware acceleration backends.
 *
 * Default `none` on purpose. Hardware encoding needs the right silicon, the right ffmpeg
 * build, and `/dev/dri` passed into the container; when any of those is missing ffmpeg fails
 * in a way that looks like a corrupt file rather than a misconfiguration. Software encoding
 * always works, so it is what a fresh install does until someone deliberately says otherwise.
 */
export const hwaccelSchema = z.enum(["none", "qsv", "vaapi", "nvenc"]);
export type Hwaccel = z.infer<typeof hwaccelSchema>;

export const hwaccelProbeRequestSchema = z.object({ hwaccel: hwaccelSchema });
export type HwaccelProbeRequest = z.infer<typeof hwaccelProbeRequestSchema>;

/**
 * What a probe reports back.
 *
 * `detail` carries ffmpeg's own words on failure rather than a message of ours. The errors
 * here name the layer that broke -- "Failed to initialise VAAPI connection" is a missing
 * driver, "Permission denied" is the device node, "Unknown encoder" is the ffmpeg build -- and
 * three different fixes hide behind one friendly sentence.
 */
export const hwaccelProbeResultSchema = z.object({
    hwaccel: hwaccelSchema,
    ok: z.boolean(),
    encoder: z.string(),
    detail: z.string(),
});
export type HwaccelProbeResult = z.infer<typeof hwaccelProbeResultSchema>;

export const transcodeSettingsSchema = z.object({
    /**
     * Days a rendition may go unwatched before its bytes are reclaimed.
     *
     * The copy is derived, so keeping it for ever is a choice about disk rather than about
     * data: an item watched once in January should not still be holding a second copy of
     * itself in December. Seven days covers the case the cache is actually for — coming back
     * to something over a weekend, or several people watching the same item in the same week.
     *
     * Eviction does not forget the item: the row survives with `evictedAt` set, the automatic
     * sweep leaves it alone, and opening it queues the encode again. Without that memory the
     * five-minute backfill would re-encode everything this reclaimed, within five minutes,
     * for ever — a feature that costs CPU and saves nothing.
     *
     * Zero keeps renditions indefinitely, for a box with disk to spare and none to waste on
     * re-encoding.
     */
    retentionDays: z.coerce.number().int().min(0).max(365).default(7),
    hwaccel: hwaccelSchema.default("none"),
    /**
     * Cap on the output's long edge.
     *
     * 1080p rather than source resolution: a 4K original re-encoded at 4K takes many times
     * longer, produces a file a NAS cannot stream to several viewers anyway, and is being
     * transcoded precisely because something about it was already too demanding.
     */
    maxHeight: z.coerce.number().int().min(240).max(2160).default(1080),
    /**
     * x264 CRF. Lower is better quality and a larger file.
     *
     * 21 is visually near-transparent for most material and roughly half the size of 18.
     * Irrelevant when hardware encoding is used, which takes a bitrate instead.
     */
    crf: z.coerce.number().int().min(14).max(35).default(21),
    /**
     * x264 preset. Slower means smaller for the same quality, and much more CPU.
     *
     * `veryfast` because this is a NAS doing it in the background, not a workstation doing it
     * once. The file it produces is a convenience copy, not an archive master.
     */
    preset: z
        .enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"])
        .default("veryfast"),
    /** Target bitrate in kbps for hardware encoders, which do not take a CRF. */
    hwBitrateKbps: z.coerce.number().int().min(500).max(20_000).default(4_000),
});
export type TranscodeSettings = z.infer<typeof transcodeSettingsSchema>;

export const DEFAULT_TRANSCODE_SETTINGS: TranscodeSettings = transcodeSettingsSchema.parse({});

/** The one profile phase 3 produces. Named so a second one can be added without a migration. */
export const WEBSAFE_PROFILE = "websafe";

export interface TranscodePlan {
    /** Arguments after the binary, excluding the output path. */
    args: string[];
    /** Whether both streams are being copied — seconds of I/O rather than minutes of CPU. */
    remux: boolean;
}

export interface BuildTranscodeInput {
    inputPath: string;
    settings: TranscodeSettings;
    /** True when only the container is wrong, so both streams can be copied. */
    remuxOnly: boolean;
    /** Whether the video stream itself needs re-encoding. */
    videoNeedsEncode: boolean;
    /** Whether the audio stream needs re-encoding. */
    audioNeedsEncode: boolean;
    /**
     * Cap on encoder threads, or null for "use the whole box".
     *
     * The off-peak lever (§7c). Concurrency throttling cannot touch this job -- transcode is
     * pinned at one at every hour -- and process priority only settles who wins a contested
     * CPU, not how much of an idle one ffmpeg helps itself to. A thread cap is the only hard
     * ceiling of the three, and the only one that leaves the output unchanged: a file encoded
     * at two threads and the same file encoded at eight differ in how long they took, not in
     * what a viewer sees.
     */
    threads?: number | null;
}

/**
 * VAAPI needs the device opened and frames uploaded before the encoder sees them.
 *
 * QSV and NVENC take their device differently, which is why this is a switch rather than a
 * parameterised template — the three backends agree on almost nothing but the idea.
 */
const hwaccelInputArgs = (hwaccel: Hwaccel): string[] => {
    switch (hwaccel) {
        case "vaapi":
            return ["-vaapi_device", "/dev/dri/renderD128"];
        case "qsv":
            return ["-init_hw_device", "qsv=hw", "-filter_hw_device", "hw"];
        case "nvenc":
            return ["-hwaccel", "cuda"];
        case "none":
            return [];
    }
};

/** Exported so a probe can report which encoder it actually tried. */
export const videoEncoder = (hwaccel: Hwaccel): string => {
    switch (hwaccel) {
        case "vaapi":
            return "h264_vaapi";
        case "qsv":
            return "h264_qsv";
        case "nvenc":
            return "h264_nvenc";
        case "none":
            return "libx264";
    }
};

/**
 * The target height, as an expression ffmpeg evaluates against the real source.
 *
 * `min(H,ih)` rather than a plain height: scaling a 720p source up to 1080p costs CPU and
 * bytes to add no detail.
 *
 * `trunc(.../2)*2` is the part that was missing, and it is not cosmetic -- H.264 with
 * yuv420p cannot encode an odd dimension at all:
 *
 *     [libx264] height not divisible by 2 (446x345)
 *     Error while opening encoder
 *
 * It is written as an expression rather than computed here because the answer depends on the
 * source's real height, and the probed height we hold is null often enough to matter. Letting ffmpeg evaluate `ih` means the guarantee holds even when we do not know
 * the dimensions -- which is exactly the case that used to emit no filter at all.
 */
const evenHeight = (maxHeight: number): string => `trunc(min(${maxHeight},ih)/2)*2`;

/**
 * The scale filter. Always applied, which is the fix for an entire class of failure.
 *
 * It used to be skipped whenever the source was already below the cap, on the reasoning that
 * there was nothing to scale. That is true of the *size* and false of the *parity*: a 445x345
 * clip went straight to libx264 as-is and the encoder refused it outright. Those files failed
 * three times, were re-queued by the backfill, and failed again forever.
 *
 * Scaling a source to the size it already is costs a filter pass that changes no pixels, and
 * that is a real cost on a NAS (§17) -- but it is nothing beside the encode it feeds, and the
 * alternative is a whole category of file that can never be made playable.
 *
 * `-2` on the width keeps it even *and* preserves the aspect ratio against whatever height the
 * expression settles on. The comment here used to claim that made the output even; it only
 * ever covered one of the two axes.
 *
 * VAAPI runs its scaler on the GPU and needs the frames uploaded first; the others take an
 * ordinary software filter. It needs the same treatment for the same reason.
 */
const scaleFilter = (hwaccel: Hwaccel, maxHeight: number): string[] => {
    if (hwaccel === "vaapi") {
        // Upload regardless: the VAAPI encoder cannot take software frames.
        //
        // The quotes around the height are not decoration, and their absence made every
        // hardware transcode fail. `evenHeight` contains `min(480,ih)`, and a comma is what
        // ffmpeg splits a filtergraph on -- so the graph was cut mid-expression and ffmpeg
        // looked for a filter named `ih)/2)*2`:
        //
        //     [AVFilterGraph] No such filter: 'ih)/2)*2'
        //     Error reinitializing filters!
        //
        // The software branch below had always quoted it. This one did not, and nothing
        // noticed because the test asserted the filter contained "hwupload" rather than that
        // it parsed.
        return ["-vf", `format=nv12,hwupload,scale_vaapi=w=-2:h='${evenHeight(maxHeight)}'`];
    }

    return ["-vf", `scale=-2:'${evenHeight(maxHeight)}':flags=bicubic`];
};

/**
 * The thread cap, when there is one.
 *
 * Software encoding only. The hardware encoders do their work on silicon that has no notion
 * of an x264 thread pool, so passing this to them would be a setting that appears to apply
 * and quietly does not -- and hardware encoding is already cheap enough on the CPU that the
 * throttle has nothing to save there.
 */
const threadArgs = (settings: TranscodeSettings, threads: number | null | undefined): string[] =>
    settings.hwaccel === "none" && threads && threads > 0 ? ["-threads", String(threads)] : [];

const qualityArgs = (settings: TranscodeSettings): string[] => {
    if (settings.hwaccel === "none") {
        return ["-crf", String(settings.crf), "-preset", settings.preset];
    }

    // Hardware encoders do not implement CRF; they take a target bitrate.
    return ["-b:v", `${settings.hwBitrateKbps}k`, "-maxrate", `${settings.hwBitrateKbps * 2}k`];
};

/**
 * How long a hardware probe may run before it is killed.
 *
 * One second of 640x480 synthetic video is a fraction of this on any working encoder. The
 * margin is for the failing case, which is the one that matters: a driver that cannot reach
 * the device sometimes blocks rather than returning an error, and a probe that hangs is worse
 * than one that says no -- it holds a request open on a box with two cores.
 */
export const HWACCEL_PROBE_TIMEOUT_MS = 20_000;

/**
 * Build the ffmpeg arguments that prove a hwaccel mode actually works (§7).
 *
 * This is the "test" button's whole implementation, and it lives here rather than beside the
 * route for one reason: it is assembled from `hwaccelInputArgs`, `scaleFilter` and
 * `videoEncoder` -- the same three functions `buildTranscodeArgs` uses. A probe written
 * separately would drift, and a probe that passes while the jobs fail is worse than no probe,
 * because it converts "my transcodes fail" into "my transcodes fail and the test says they
 * should not".
 *
 * `testsrc` rather than a real file, so the probe needs no media, no library and no path
 * safety check, and measures the encoder rather than the disk. `-f null -` discards the
 * output: what is being asked is whether the encoder can be opened and fed, and that question
 * is answered identically whether or not anything keeps the bytes.
 *
 * The 480 matches the synthetic source's height, so `scaleFilter` emits the same
 * `format=nv12,hwupload` chain a real VAAPI job gets without also scaling -- the upload is the
 * part that fails when the driver is missing, and it is exercised either way.
 */
export const buildHwaccelProbeArgs = (hwaccel: Hwaccel): string[] => [
    "-hide_banner",
    // Never wait on a terminal. Without it a probe that spawns without a stdin can block.
    "-nostdin",
    ...hwaccelInputArgs(hwaccel),
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=1:size=640x480:rate=30",
    ...scaleFilter(hwaccel, 480),
    "-c:v",
    videoEncoder(hwaccel),
    "-f",
    "null",
    "-",
];

/**
 * Build the ffmpeg arguments for a web-safe rendition.
 *
 * Streams are copied wherever possible. The common case in a downloaded library is an MKV
 * holding perfectly good H.264 and AAC, where the whole job is a container change — and
 * re-encoding it anyway would waste hours of NAS CPU producing a worse copy.
 */
export const buildTranscodeArgs = ({
    inputPath,
    settings,
    remuxOnly,
    videoNeedsEncode,
    audioNeedsEncode,
    threads,
}: BuildTranscodeInput): TranscodePlan => {
    const copyVideo = remuxOnly || !videoNeedsEncode;
    const copyAudio = remuxOnly || !audioNeedsEncode;

    const args = [
        "-v",
        "error",
        // Progress on stdout in a parseable form, so the job can report it without scraping
        // ffmpeg's human-readable status line.
        "-progress",
        "pipe:1",
        "-nostats",
        "-y",
        ...(copyVideo ? [] : hwaccelInputArgs(settings.hwaccel)),
        "-i",
        inputPath,
        // First video and first audio track only. A file with six audio tracks would
        // otherwise produce a variant with six, which no browser will choose sensibly from.
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        // Subtitles are not carried: MP4 subtitle support is poor and they are served
        // separately as WebVTT (§9).
        "-sn",
    ];

    if (copyVideo) {
        args.push("-c:v", "copy");
    } else {
        args.push(
            ...scaleFilter(settings.hwaccel, settings.maxHeight),
            "-c:v",
            videoEncoder(settings.hwaccel),
            ...qualityArgs(settings),
            ...threadArgs(settings, threads),
            // 8-bit 4:2:0 is the whole point of the exercise; without pinning it, a 10-bit
            // source produces a 10-bit output that browsers still cannot decode.
            ...(settings.hwaccel === "none" ? ["-pix_fmt", "yuv420p"] : [])
        );
    }

    if (copyAudio) {
        args.push("-c:a", "copy");
    } else {
        // Stereo AAC. A 5.1 track downmixed by the browser is a gamble; doing it here means
        // every viewer hears the same thing.
        args.push("-c:a", "aac", "-b:a", "160k", "-ac", "2");
    }

    args.push(
        // Without this the moov atom lands at the end of the file, and a browser must
        // download the whole thing before it can start playing — which defeats the purpose.
        "-movflags",
        "+faststart",
        /**
         * Name the muxer rather than letting ffmpeg infer it from the extension.
         *
         * The job encodes to a temporary name and renames on success, so the path it is
         * actually given ends in ".partial" — from which ffmpeg infers nothing and refuses to
         * start. Being explicit is correct regardless of what the caller calls the file.
         */
        "-f",
        "mp4"
    );

    return { args, remux: copyVideo && copyAudio };
};

/**
 * Parse one `key=value` block of ffmpeg's `-progress` output into a fraction complete.
 *
 * Returns null when the block does not carry a usable time, which most do not — ffmpeg emits
 * several keys per update and only `out_time_us` (or `out_time_ms`, depending on version)
 * says how far it has got.
 */
export const parseTranscodeProgress = (chunk: string, durationMs: number | null): number | null => {
    if (!durationMs || durationMs <= 0) {
        return null;
    }

    // `out_time_ms` is a misnomer in most ffmpeg builds: it is microseconds, the same as
    // `out_time_us`. Reading it as milliseconds reports a job as complete a thousand times
    // too early, which shows as a progress bar that jumps to 100% and stays there.
    const match = /out_time_(?:us|ms)=(\d+)/.exec(chunk);

    if (!match) {
        return null;
    }

    const elapsedMs = Number(match[1]) / 1000;

    return Math.min(1, Math.max(0, elapsedMs / durationMs));
};
