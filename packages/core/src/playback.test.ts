import { describe, expect, it } from "vitest";

import {
    assessPlayback,
    describeBlocker,
    describePlaybackKind,
    type PlaybackInput,
} from "./playback.js";

/**
 * This verdict decides whether a NAS spends minutes of CPU on a file, or serves it for free.
 *
 * Both failure directions are expensive and neither is loud. Too optimistic and a viewer gets
 * a black rectangle with no explanation; too pessimistic and the box transcodes a library
 * that would have played perfectly well.
 */
const video = (overrides: Partial<PlaybackInput> = {}): PlaybackInput => ({
    kind: "video",
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    codec: "h264",
    videoProfile: "High",
    pixFmt: "yuv420p",
    audioCodec: "aac",
    probedAt: "2026-09-15 00:00:00",
    ...overrides,
});

describe("assessPlayback", () => {
    it("accepts ordinary H.264/AAC in MP4", () => {
        const result = assessPlayback(video());

        expect(result.directPlay).toBe(true);
        expect(result.blockers).toEqual([]);
        expect(result.remuxOnly).toBe(false);
    });

    it("matches any name in ffprobe's comma list of container formats", () => {
        // ffprobe names the demuxer family it recognised, not a single format.
        expect(assessPlayback(video({ container: "mov,mp4,m4a,3gp,3g2,mj2" })).directPlay).toBe(
            true
        );
    });

    describe("what the household's devices showed (§8)", () => {
        // The playback check tried these in Chrome on a Pixel and on a Windows PC, and both
        // played them. They were refused here before it.
        it("plays MKV, whatever the extension says", () => {
            for (const relPath of ["films/feature.mkv", "FILMS/FEATURE.MKV", "clips/a.webm"]) {
                expect(
                    assessPlayback(video({ container: "matroska,webm", relPath })).directPlay
                ).toBe(true);
            }
        });

        it("plays HEVC, 8-bit and 10-bit", () => {
            expect(assessPlayback(video({ codec: "hevc", videoProfile: "Main" })).directPlay).toBe(
                true
            );
            expect(
                assessPlayback(
                    video({ codec: "hevc", videoProfile: "Main 10", pixFmt: "yuv420p10le" })
                ).directPlay
            ).toBe(true);
        });

        it("plays 16-bit PCM sound", () => {
            expect(assessPlayback(video({ audioCodec: "pcm_s16le" })).directPlay).toBe(true);
        });

        it("plays its originals as they are, not as segments", () => {
            expect(assessPlayback(video({ codec: "hevc" })).via).toBe("file");
        });
    });

    describe("MPEG-TS, as a playlist of byte ranges", () => {
        const ts = (overrides: Partial<PlaybackInput> = {}) =>
            assessPlayback(
                video({ container: "mpegts", relPath: "show.mpg", audioCodec: "mp3", ...overrides })
            );

        it("plays H.264 with MP3 or AAC sound as segments", () => {
            for (const audioCodec of ["mp3", "aac", null]) {
                const result = ts({ audioCodec });

                expect(result.directPlay).toBe(true);
                expect(result.via).toBe("segments");
            }
        });

        it("refuses streams the segments cannot carry", () => {
            expect(ts({ codec: "hevc" }).blockers).toEqual(["container"]);
            expect(ts({ audioCodec: "mp2" }).blockers).toEqual(["container", "audioCodec"]);
        });
    });

    it("rejects 10-bit and 4:2:2 H.264 despite the codec being h264", () => {
        // The case that makes a library mysteriously half-work: these play in VLC, report
        // codec "h264", and no browser decodes them.
        for (const profile of ["High 10", "High 4:2:2", "High 4:4:4 Predictive"]) {
            const result = assessPlayback(video({ videoProfile: profile }));

            expect(result.directPlay).toBe(false);
            expect(result.blockers).toContain("videoProfile");
        }
    });

    it("accepts every H.264 profile a browser actually decodes", () => {
        for (const profile of [
            "Baseline",
            "Constrained Baseline",
            "Main",
            "High",
            "Progressive High",
        ]) {
            expect(assessPlayback(video({ videoProfile: profile })).directPlay).toBe(true);
        }
    });

    it("ignores the profile for codecs where it does not decide support", () => {
        // VP9 and AV1 carry profiles too, but not ones that change browser support the way
        // H.264's do — rejecting them would transcode files that play fine.
        expect(
            assessPlayback(
                video({
                    container: "matroska,webm",
                    relPath: "clips/a.webm",
                    codec: "vp9",
                    videoProfile: "Profile 2",
                })
            ).directPlay
        ).toBe(true);
    });

    it("identifies a file of good streams in the wrong container as a remux", () => {
        // Seconds of I/O instead of minutes of CPU — on a NAS, the difference between
        // watchable now and watchable this evening.
        const result = assessPlayback(video({ container: "avi" }));

        expect(result.directPlay).toBe(false);
        expect(result.blockers).toEqual(["container"]);
        expect(result.remuxOnly).toBe(true);
    });

    it("does not call it a remux when a stream also needs re-encoding", () => {
        const result = assessPlayback(video({ container: "avi", codec: "mpeg4" }));

        expect(result.remuxOnly).toBe(false);
        expect(result.blockers).toEqual(["container", "videoCodec"]);
    });

    it("rejects video no browser decodes", () => {
        for (const codec of ["prores", "mpeg4", "wmv3"]) {
            expect(assessPlayback(video({ codec })).blockers).toContain("videoCodec");
        }
    });

    it("rejects unsupported audio even when the video is fine", () => {
        for (const codec of ["ac3", "eac3", "dts", "truehd"]) {
            const result = assessPlayback(video({ audioCodec: codec }));

            expect(result.directPlay).toBe(false);
            expect(result.blockers).toEqual(["audioCodec"]);
        }
    });

    it("treats a silent video as playable", () => {
        // A file with no audio track is not a problem to solve.
        expect(assessPlayback(video({ audioCodec: null })).directPlay).toBe(true);
    });

    it("assumes an unknown profile or pixel format is fine", () => {
        // Absence of evidence. ffprobe often reports no profile for a remuxed file, and
        // refusing those would transcode a large part of a typical library for nothing.
        expect(assessPlayback(video({ videoProfile: null, pixFmt: null })).directPlay).toBe(true);
    });

    it("is optimistic about an unprobed file rather than queuing work for it", () => {
        // Queuing a transcode for everything the moment it is scanned would saturate the NAS
        // before anyone had looked at a single item.
        const result = assessPlayback(video({ probedAt: null, codec: "hevc", container: "mkv" }));

        expect(result.directPlay).toBe(true);
        expect(result.probed).toBe(false);
    });

    it("always plays images", () => {
        expect(assessPlayback({ ...video(), kind: "image" }).directPlay).toBe(true);
    });

    it("reports every blocker, not just the first", () => {
        const result = assessPlayback(
            video({
                container: "avi",
                codec: "h264",
                videoProfile: "High 10",
                pixFmt: "yuv420p10le",
                audioCodec: "dts",
            })
        );

        // The admin job view explains why a file needed work; one reason out of four is a
        // misleading explanation.
        expect(result.blockers).toEqual(["container", "videoProfile", "audioCodec"]);
    });

    it("is case and whitespace insensitive, because ffprobe is not consistent", () => {
        expect(assessPlayback(video({ codec: " H264 ", videoProfile: "HIGH" })).directPlay).toBe(
            true
        );
    });

    it("treats a missing container as unplayable rather than assuming the best", () => {
        // Unlike a missing profile, a missing container means the probe failed outright.
        expect(assessPlayback(video({ container: null })).blockers).toContain("container");
    });
});

describe("describeBlocker", () => {
    it("explains every blocker the assessment can produce", () => {
        const result = assessPlayback(
            video({
                container: "avi",
                codec: "prores",
                pixFmt: "yuv444p",
                audioCodec: "dts",
            })
        );

        for (const blocker of result.blockers) {
            expect(describeBlocker(blocker).length).toBeGreaterThan(10);
        }
    });
});

describe("describePlaybackKind", () => {
    const kind = (overrides: Partial<PlaybackInput>) => describePlaybackKind(video(overrides));

    it("names the cases the library holds", () => {
        expect(kind({ codec: "hevc", videoProfile: "Main", relPath: "a.mp4" })).toBe("HEVC in MP4");
        expect(
            kind({
                codec: "hevc",
                videoProfile: "Main 10",
                pixFmt: "yuv420p10le",
                container: "mov,mp4,m4a,3gp,3g2,mj2",
                relPath: "IMG_1.MOV",
            })
        ).toBe("HEVC 10-bit in MOV");
        expect(kind({ container: "mpegts", relPath: "show.mpg", audioCodec: "mp3" })).toBe(
            "H.264 in MPEG-TS"
        );
        expect(kind({ container: "matroska,webm", relPath: "film.mkv" })).toBe("H.264 in MKV");
        expect(kind({ audioCodec: "pcm_s24le", relPath: "cam.mov" })).toBe(
            "H.264 in MOV, PCM sound"
        );
    });

    it("names a 10-bit H.264 by the profile that blocks it", () => {
        expect(kind({ videoProfile: "High 10", pixFmt: "yuv420p10le" })).toBe(
            "H.264 High 10 in MP4"
        );
    });

    it("leaves playable sound out of the name", () => {
        expect(kind({ codec: "hevc", audioCodec: "aac" })).toBe("HEVC in MP4");
    });
});
