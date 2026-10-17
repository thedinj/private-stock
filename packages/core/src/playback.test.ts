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

    describe("telling MKV from WebM", () => {
        // They share one demuxer, so ffprobe reports "matroska,webm" for both. Matching that
        // against the playable set finds "webm" and declares every MKV in the library
        // playable — the file is then served, the browser refuses it, and nothing ever queues
        // a rendition. Only the extension separates the two.
        const matroska = (relPath: string) =>
            assessPlayback(video({ container: "matroska,webm", relPath }));

        it("treats a .webm file as playable", () => {
            expect(matroska("clips/holiday.webm").directPlay).toBe(true);
        });

        it("treats a .mkv file as needing a remux", () => {
            const result = matroska("films/feature.mkv");

            expect(result.directPlay).toBe(false);
            expect(result.blockers).toEqual(["container"]);
            expect(result.remuxOnly).toBe(true);
        });

        it("is not fooled by a .webm elsewhere in the path", () => {
            expect(matroska("webm/feature.mkv").directPlay).toBe(false);
        });

        it("assumes MKV when no path is given, which is the safe default", () => {
            // One unnecessary remux is cheap; a file that never plays and never gets queued
            // is not.
            expect(assessPlayback(video({ container: "matroska,webm" })).directPlay).toBe(false);
        });

        it("ignores case, since a library is full of .MKV", () => {
            expect(matroska("FILMS/FEATURE.MKV").directPlay).toBe(false);
            expect(matroska("CLIPS/HOLIDAY.WEBM").directPlay).toBe(true);
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

    it("identifies an MKV of good streams as a remux rather than a re-encode", () => {
        // Seconds of I/O instead of minutes of CPU — on a NAS, the difference between
        // watchable now and watchable this evening.
        const result = assessPlayback(video({ container: "matroska" }));

        expect(result.directPlay).toBe(false);
        expect(result.blockers).toEqual(["container"]);
        expect(result.remuxOnly).toBe(true);
    });

    it("does not call it a remux when a stream also needs re-encoding", () => {
        const result = assessPlayback(video({ container: "matroska", codec: "hevc" }));

        expect(result.remuxOnly).toBe(false);
        expect(result.blockers).toEqual(["container", "videoCodec"]);
    });

    it("rejects HEVC, which plays in Safari and nowhere else", () => {
        expect(assessPlayback(video({ codec: "hevc" })).blockers).toContain("videoCodec");
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
                container: "matroska",
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
                container: "matroska",
                codec: "hevc",
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
        expect(kind({ audioCodec: "pcm_s16le", relPath: "cam.mov" })).toBe(
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
