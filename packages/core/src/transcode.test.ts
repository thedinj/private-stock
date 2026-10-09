import { describe, expect, it } from "vitest";

import {
    DEFAULT_TRANSCODE_SETTINGS,
    buildTranscodeArgs,
    parseTranscodeProgress,
    transcodeSettingsSchema,
    type BuildTranscodeInput,
    type Hwaccel,
} from "./transcode.js";

/**
 * Transcoding is the most expensive thing this app does, and the arguments are the whole of
 * it. A wrong flag here is minutes of NAS CPU producing a file that still does not play.
 */
const plan = (overrides: Partial<BuildTranscodeInput> = {}) =>
    buildTranscodeArgs({
        inputPath: "/media/videos/clip.mkv",
        settings: DEFAULT_TRANSCODE_SETTINGS,
        remuxOnly: false,
        videoNeedsEncode: true,
        audioNeedsEncode: true,
        ...overrides,
    });

const argsAfter = (args: string[], flag: string): string | undefined =>
    args[args.indexOf(flag) + 1];

/**
 * Split a filtergraph the way ffmpeg does: on commas, except inside quotes.
 *
 * Written out rather than asserted against a literal string because the bug this guards
 * against produced a filter string that read perfectly well and parsed into nonsense.
 */
const splitOutsideQuotes = (filters: string | undefined): string[] => {
    const segments: string[] = [];
    let current = "";
    let quoted = false;

    for (const character of filters ?? "") {
        if (character === "'") {
            quoted = !quoted;
            continue;
        }

        if (character === "," && !quoted) {
            segments.push(current);
            current = "";
            continue;
        }

        current += character;
    }

    return current ? [...segments, current] : segments;
};

describe("buildTranscodeArgs", () => {
    it("copies both streams for a remux, which is the common case", () => {
        // An MKV of perfectly good H.264 and AAC: seconds of I/O, not minutes of CPU.
        const result = plan({ remuxOnly: true });

        expect(result.remux).toBe(true);
        expect(argsAfter(result.args, "-c:v")).toBe("copy");
        expect(argsAfter(result.args, "-c:a")).toBe("copy");
        expect(result.args).not.toContain("-crf");
    });

    it("re-encodes only the stream that needs it", () => {
        const videoOnly = plan({ videoNeedsEncode: true, audioNeedsEncode: false });
        expect(argsAfter(videoOnly.args, "-c:v")).toBe("libx264");
        expect(argsAfter(videoOnly.args, "-c:a")).toBe("copy");
        expect(videoOnly.remux).toBe(false);

        const audioOnly = plan({ videoNeedsEncode: false, audioNeedsEncode: true });
        expect(argsAfter(audioOnly.args, "-c:v")).toBe("copy");
        expect(argsAfter(audioOnly.args, "-c:a")).toBe("aac");
    });

    it("always writes faststart, or the browser must download the file before playing", () => {
        for (const remuxOnly of [true, false]) {
            expect(argsAfter(plan({ remuxOnly }).args, "-movflags")).toBe("+faststart");
        }
    });

    it("names the muxer instead of relying on the output extension", () => {
        // The job encodes to a temporary name ending in ".partial", from which ffmpeg infers
        // nothing and refuses to start — it fails before writing a byte.
        for (const remuxOnly of [true, false]) {
            expect(argsAfter(plan({ remuxOnly }).args, "-f")).toBe("mp4");
        }
    });

    it("pins 8-bit 4:2:0 when software encoding", () => {
        // Without this a 10-bit source yields a 10-bit output, which browsers still cannot
        // decode — the transcode would have achieved nothing.
        expect(argsAfter(plan().args, "-pix_fmt")).toBe("yuv420p");
    });

    it("takes only the first video and audio track", () => {
        // Six audio tracks in, six audio tracks out, and no browser chooses sensibly.
        const { args } = plan();

        expect(args.filter((arg) => arg === "-map")).toHaveLength(2);
        expect(args).toContain("0:v:0");
        // Optional: a silent video must not fail the whole job.
        expect(args).toContain("0:a:0?");
        expect(args).toContain("-sn");
    });

    /**
     * The filter is unconditional, and the previous version of this test asserted the bug.
     *
     * It checked that a source already below the cap got no `-vf` at all, which is true of the
     * *size* and false of the *parity*: an odd dimension then reached libx264 untouched and the
     * encoder refused the file outright. Those transcodes failed three times and were re-queued
     * forever. Skipping the filter is exactly what must not happen.
     */
    it("always scales, even when the source is already small enough", () => {
        expect(plan({ settings: { ...DEFAULT_TRANSCODE_SETTINGS } }).args).toContain("-vf");
    });

    it("clamps a source above the cap rather than re-encoding at full size", () => {
        expect(argsAfter(plan({}).args, "-vf")).toContain("1080");
    });

    /** `min(H,ih)`: scaling a 720p source up to 1080p adds bytes and no detail. */
    it("clamps rather than upscaling", () => {
        expect(argsAfter(plan({}).args, "-vf")).toContain("min(1080,ih)");
    });

    /**
     * The regression. H.264 with yuv420p cannot encode an odd dimension at all, and `-2` on
     * the width only ever covered one of the two axes -- a 445x345 source scaled to 446x345
     * and failed with "height not divisible by 2".
     *
     * Asserted as an expression rather than a computed number because it has to hold for
     * sources whose dimensions we never probed.
     */
    it("forces an even height, which the encoder requires", () => {
        expect(argsAfter(plan({}).args, "-vf")).toContain("trunc(min(1080,ih)/2)*2");
    });

    it("forces an even width alongside it, preserving the aspect ratio", () => {
        expect(argsAfter(plan({}).args, "-vf")).toContain("scale=-2:");
    });

    describe("hardware acceleration", () => {
        const backends: Hwaccel[] = ["qsv", "vaapi", "nvenc"];

        it("selects the matching encoder for each backend", () => {
            const encoders: Record<Hwaccel, string> = {
                none: "libx264",
                qsv: "h264_qsv",
                vaapi: "h264_vaapi",
                nvenc: "h264_nvenc",
            };

            for (const hwaccel of [...backends, "none" as const]) {
                const result = plan({
                    settings: { ...DEFAULT_TRANSCODE_SETTINGS, hwaccel },
                });

                expect(argsAfter(result.args, "-c:v")).toBe(encoders[hwaccel]);
            }
        });

        it("uses a bitrate rather than CRF, which hardware encoders do not implement", () => {
            for (const hwaccel of backends) {
                const result = plan({ settings: { ...DEFAULT_TRANSCODE_SETTINGS, hwaccel } });

                expect(result.args).not.toContain("-crf");
                expect(result.args).not.toContain("-preset");
                expect(argsAfter(result.args, "-b:v")).toBe("4000k");
            }
        });

        it("uploads frames for VAAPI, whose encoder cannot take software frames", () => {
            const result = plan({ settings: { ...DEFAULT_TRANSCODE_SETTINGS, hwaccel: "vaapi" } });

            expect(argsAfter(result.args, "-vf")).toContain("hwupload");
            expect(result.args).toContain("-vaapi_device");
        });

        it("keeps the VAAPI upload even when no scaling is needed", () => {
            // Dropping the filter entirely for a small source would hand the hardware encoder
            // software frames and fail at runtime, only for sources under the cap.
            const result = plan({
                settings: { ...DEFAULT_TRANSCODE_SETTINGS, hwaccel: "vaapi" },
            });

            expect(argsAfter(result.args, "-vf")).toContain("hwupload");
        });

        /**
         * The regression, found by the hwaccel probe on its first real deployment.
         *
         * `evenHeight` contains `min(480,ih)`, and a comma separates filters in a filtergraph.
         * Unquoted, the graph was cut mid-expression and ffmpeg looked for a filter called
         * `ih)/2)*2`, so every VAAPI transcode failed with "No such filter". The software
         * branch had quoted it all along.
         *
         * Asserted by splitting the way ffmpeg does -- on commas outside quotes -- rather than
         * by matching the string, because the string is exactly what looked fine.
         */
        it("protects the height expression from the filtergraph separator", () => {
            const filters = argsAfter(
                plan({ settings: { ...DEFAULT_TRANSCODE_SETTINGS, hwaccel: "vaapi" } }).args,
                "-vf"
            );

            const segments = splitOutsideQuotes(filters);

            expect(segments).toEqual([
                "format=nv12",
                "hwupload",
                expect.stringMatching(/^scale_vaapi=/),
            ]);

            for (const segment of segments) {
                // Every segment ffmpeg sees must start with a filter name, not the tail of an
                // expression that was cut in half.
                expect(segment).toMatch(/^[a-z_][a-z0-9_]*(=|$)/);
            }
        });

        it("does not set up a device when the video is being copied", () => {
            // A remux needs no encoder, and initialising one would fail on a box without the
            // hardware for a job that never needed it.
            const result = plan({
                settings: { ...DEFAULT_TRANSCODE_SETTINGS, hwaccel: "vaapi" },
                remuxOnly: true,
            });

            expect(result.args).not.toContain("-vaapi_device");
        });
    });
});

describe("transcodeSettingsSchema", () => {
    it("defaults to software encoding", () => {
        // Hardware needs the right silicon, the right ffmpeg build and /dev/dri passed
        // through; when any is missing ffmpeg fails like a corrupt file, not a misconfig.
        expect(DEFAULT_TRANSCODE_SETTINGS.hwaccel).toBe("none");
    });

    it("reclaims renditions nobody has watched for a week", () => {
        expect(DEFAULT_TRANSCODE_SETTINGS.retentionDays).toBe(7);
        // Zero is the escape hatch for a box with disk to spare, not an accident.
        expect(transcodeSettingsSchema.parse({ retentionDays: 0 }).retentionDays).toBe(0);
        expect(() => transcodeSettingsSchema.parse({ retentionDays: -1 })).toThrow();
    });

    it("rejects values that would produce an unusable encode", () => {
        expect(() => transcodeSettingsSchema.parse({ crf: 5 })).toThrow();
        expect(() => transcodeSettingsSchema.parse({ maxHeight: 60 })).toThrow();
        expect(() => transcodeSettingsSchema.parse({ hwaccel: "videotoolbox" })).toThrow();
    });
});

describe("parseTranscodeProgress", () => {
    it("reads microseconds, not milliseconds, from out_time_ms", () => {
        // `out_time_ms` is a misnomer in most ffmpeg builds — it is microseconds. Reading it
        // as milliseconds reports the job complete a thousand times too early.
        expect(parseTranscodeProgress("out_time_ms=30000000", 60_000)).toBeCloseTo(0.5, 5);
        expect(parseTranscodeProgress("out_time_us=30000000", 60_000)).toBeCloseTo(0.5, 5);
    });

    it("clamps to one, because ffmpeg overshoots the probed duration", () => {
        expect(parseTranscodeProgress("out_time_us=99000000", 60_000)).toBe(1);
    });

    it("returns null for a block with no timing, which is most of them", () => {
        expect(parseTranscodeProgress("frame=120\nfps=30\n", 60_000)).toBeNull();
    });

    it("returns null when the duration is unknown rather than dividing by zero", () => {
        for (const duration of [null, 0, -1]) {
            expect(parseTranscodeProgress("out_time_us=1000000", duration)).toBeNull();
        }
    });

    it("handles a full multi-line progress block", () => {
        const chunk = [
            "frame=1234",
            "fps=45.2",
            "bitrate=2000.0kbits/s",
            "total_size=4096000",
            "out_time_us=15000000",
            "out_time_ms=15000000",
            "out_time=00:00:15.000000",
            "speed=1.5x",
            "progress=continue",
        ].join("\n");

        expect(parseTranscodeProgress(chunk, 60_000)).toBeCloseTo(0.25, 5);
    });
});

/**
 * The off-peak thread cap (§7c).
 *
 * The only lever that genuinely bounds a transcode: the kind runs one job at a time at every
 * hour, so there is no concurrency to reduce, and process priority only settles a contest
 * for the CPU rather than capping an idle one.
 */
describe("buildTranscodeArgs, thread cap", () => {
    it("takes the whole box when no cap is set", () => {
        expect(plan({ threads: null }).args).not.toContain("-threads");
        expect(plan().args).not.toContain("-threads");
    });

    it("caps the software encoder when one is set", () => {
        expect(argsAfter(plan({ threads: 2 }).args, "-threads")).toBe("2");
    });

    /**
     * `-threads 0` is ffmpeg for "use everything", so a zero arriving here would read as the
     * opposite of the instruction. Core refuses to emit it; `throttledThreads` refuses to
     * produce it. Both, because either alone is one edit from being the only one.
     */
    it("emits nothing rather than a zero, which ffmpeg reads as unlimited", () => {
        expect(plan({ threads: 0 }).args).not.toContain("-threads");
    });

    it("does not cap a remux, which spends no CPU to begin with", () => {
        expect(plan({ remuxOnly: true, threads: 2 }).args).not.toContain("-threads");
    });

    /**
     * Hardware encoders do their work on silicon with no x264 thread pool, so passing this to
     * them would be a setting that appears to apply and quietly does not.
     */
    it("leaves hardware encoding alone", () => {
        const settings = transcodeSettingsSchema.parse({ hwaccel: "vaapi" satisfies Hwaccel });

        expect(plan({ settings, threads: 2 }).args).not.toContain("-threads");
    });
});
