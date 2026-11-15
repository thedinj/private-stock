import { describe, expect, it } from "vitest";

import { writeMarkerEdl } from "./edl.js";
import { buildReelTimeline, timelineMarkers, type TimelineSource } from "./timeline.js";

const source = (mediaId: string): TimelineSource => ({
    mediaId,
    fileName: `${mediaId}.mp4`,
    path: `//NAS/Videos/${mediaId}.mp4`,
    durationMs: 600_000,
    width: 1920,
    height: 1080,
    rate: { num: 30000, den: 1001 },
    timecode: null,
    hasAudio: true,
    audioChannels: 2,
});

const timeline = () =>
    buildReelTimeline({
        name: "Beach | day",
        description: null,
        rate: { num: 30000, den: 1001 },
        sources: [source("a"), source("b")],
        entries: [
            {
                mediaId: "a",
                startMs: 0,
                endMs: 61_000,
                speed: null,
                label: "Jump",
                notes: [
                    { kind: "performer", text: "People: Ann, Bo" },
                    { kind: "rating", text: "Rating: 4/5" },
                ],
            },
            // One frame long: three things to say and room for one.
            {
                mediaId: "b",
                startMs: 0,
                endMs: 10,
                speed: null,
                label: "Blink",
                notes: [
                    { kind: "tag", text: "Keywords: a|b" },
                    { kind: "rating", text: "Rating: 1/5" },
                ],
            },
        ],
    });

describe("timelineMarkers", () => {
    it("puts the label and each note a frame apart from the cut's start", () => {
        expect(timelineMarkers(timeline()).slice(0, 3)).toEqual([
            { frame: 0, kind: "label", text: "Jump" },
            { frame: 1, kind: "performer", text: "People: Ann, Bo" },
            { frame: 2, kind: "rating", text: "Rating: 4/5" },
        ]);
    });

    it("joins what does not fit onto a short cut's last frame", () => {
        // 61 s at 29.97 is 1828 frames, so the second cut is frame 1828 alone.
        expect(timelineMarkers(timeline())[3]).toEqual({
            frame: 1828,
            kind: "label",
            text: "Blink · Keywords: a|b · Rating: 1/5",
        });
    });
});

describe("writeMarkerEdl", () => {
    it("writes one-frame events with Resolve's marker comments, non-drop at the nominal rate", () => {
        const edl = writeMarkerEdl(timeline())!;

        expect(edl.split("\r\n").slice(0, 6)).toEqual([
            "TITLE: Beach / day",
            "FCM: NON-DROP FRAME",
            "",
            "001  001      V     C        00:00:00:00 00:00:00:01 00:00:00:00 00:00:00:01  ",
            " |C:ResolveColorBlue |M:Jump |D:1",
            "",
        ]);
        // 1828 frames counted at 30: 1 minute, 0 seconds, 28 frames.
        expect(edl).toContain(
            "004  001      V     C        00:01:00:28 00:01:00:29 00:01:00:28 00:01:00:29  \r\n |C:ResolveColorBlue |M:Blink · Keywords: a/b · Rating: 1/5 |D:1"
        );
        expect(edl).toContain(" |C:ResolveColorRed |M:Rating: 4/5 |D:1");
    });

    it("writes nothing for a timeline with nothing to mark", () => {
        const bare = buildReelTimeline({
            name: "Bare",
            description: null,
            rate: { num: 25, den: 1 },
            sources: [source("a")],
            entries: [
                { mediaId: "a", startMs: 0, endMs: 1_000, speed: null, label: null, notes: [] },
            ],
        });

        expect(writeMarkerEdl(bare)).toBeNull();
    });
});

describe("notesInNames", () => {
    it("adds the notes to the clip name after the label", () => {
        const named = buildReelTimeline({
            name: "Named",
            description: null,
            rate: { num: 25, den: 1 },
            sources: [source("a")],
            entries: [
                {
                    mediaId: "a",
                    startMs: 0,
                    endMs: 1_000,
                    speed: null,
                    label: null,
                    notes: [{ kind: "rating", text: "Rating: 3/5" }],
                },
            ],
            notesInNames: true,
        });

        expect(named.clips[0].name).toBe("a.mp4 · Rating: 3/5");
        expect(named.clips[0].label).toBeNull();
    });
});
