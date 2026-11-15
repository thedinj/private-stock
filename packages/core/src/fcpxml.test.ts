import { describe, expect, it } from "vitest";

import { escapeXml, writeFcpxml } from "./fcpxml.js";
import { buildReelTimeline, type TimelineSource } from "./timeline.js";

const source = (mediaId: string, overrides: Partial<TimelineSource> = {}): TimelineSource => ({
    mediaId,
    fileName: `${mediaId}.mp4`,
    path: `\\\\NAS\\Multimedia\\Holiday 2024\\${mediaId}.mp4`,
    durationMs: 60_000,
    width: 1920,
    height: 1080,
    rate: { num: 30000, den: 1001 },
    timecode: null,
    hasAudio: true,
    audioChannels: 2,
    ...overrides,
});

/** Mixed rates, a 2x and a 0.5x clip, a timecode, a UNC path with spaces, an awkward label. */
const fixture = () =>
    buildReelTimeline({
        name: 'Pool & "friends"',
        description: "Summer <2024>",
        rate: { num: 30000, den: 1001 },
        entries: [
            {
                mediaId: "phone",
                startMs: 2_000,
                endMs: 5_000,
                speed: null,
                label: `A&B <"jump">`,
                keywords: ["pool", "kids, small"],
            },
            {
                mediaId: "camera",
                startMs: 10_000,
                endMs: 12_000,
                speed: 2,
                label: null,
                keywords: [],
            },
            {
                mediaId: "phone",
                startMs: 30_000,
                endMs: 31_000,
                speed: 0.5,
                label: null,
                keywords: [],
            },
            {
                mediaId: "tc",
                startMs: 1_000,
                endMs: 2_000,
                speed: null,
                label: "Timecode",
                keywords: [],
            },
        ],
        sources: [
            source("phone"),
            source("camera", {
                rate: { num: 25, den: 1 },
                width: 3840,
                height: 2160,
                hasAudio: false,
            }),
            source("tc", { rate: { num: 25, den: 1 }, timecode: "01:00:00:00" }),
        ],
    });

describe("writeFcpxml", () => {
    it("writes the fixture reel", () => {
        expect(writeFcpxml([fixture()], fixture().name)).toMatchSnapshot();
    });

    it("places clips on whole frames of the sequence", () => {
        const xml = writeFcpxml([fixture()], "Reel");

        // Clip one: 3 s at 29.97 is 90 frames.
        expect(xml).toContain(
            'offset="0s" name="A&amp;B &lt;&quot;jump&quot;&gt;" start="1001/500s"'
        );
        // Clip two starts at frame 90.
        expect(xml).toContain('offset="3003/1000s"');
    });

    it("retimes a 2x clip with a time map and an in-point in clip time", () => {
        const xml = writeFcpxml([fixture()], "Reel");

        // 10 s into a 25 fps source at 2x is 5 s of clip time; the map covers all 60 s. The
        // 0.5x clip maps the 1798-frame phone asset (60 s at 29.97) across twice its length.
        expect(xml).toContain('name="camera.mp4" start="5s" duration="1001/1000s"');
        expect(xml).toContain('<timept time="30s" value="60s" interp="linear"/>');
        expect(xml).toContain(
            '<timept time="899899/7500s" value="899899/15000s" interp="linear"/>'
        );
    });

    it("starts a timecoded asset and its clips at the timecode", () => {
        const xml = writeFcpxml([fixture()], "Reel");

        expect(xml).toContain('name="tc.mp4" start="3600s"');
        expect(xml).toContain('name="Timecode" start="3601s"');
    });

    it("references files as file URLs on the share", () => {
        expect(writeFcpxml([fixture()], "Reel")).toContain(
            'src="file://NAS/Multimedia/Holiday%202024/phone.mp4"'
        );
    });

    it("comma-separates keywords and keeps a comma inside a tag from splitting it", () => {
        expect(writeFcpxml([fixture()], "Reel")).toContain('value="pool, kids  small"');
    });

    it("writes several timelines into one event, each source once", () => {
        const second = buildReelTimeline({
            name: "Second",
            description: null,
            rate: { num: 30000, den: 1001 },
            entries: [
                {
                    mediaId: "phone",
                    startMs: 50_000,
                    endMs: 70_000,
                    speed: null,
                    label: null,
                    keywords: [],
                },
            ],
            sources: [source("phone", { durationMs: 70_000 })],
        });
        const xml = writeFcpxml([fixture(), second], "Export");

        expect(xml.match(/<event /g)).toHaveLength(1);
        expect(xml).toContain('<event name="Export">');
        expect(xml.match(/<project /g)).toHaveLength(2);
        expect(xml.match(/<asset id=/g)).toHaveLength(3);
        // The first timeline's copy of "phone" says 60 s; the second reads to 70 s (2,098 frames).
        expect(xml).toContain('name="phone.mp4" start="0s" duration="1050049/15000s"');
    });
});

describe("escapeXml", () => {
    it("drops characters XML cannot carry at all", () => {
        expect(escapeXml("a\u0001b\tc")).toBe("ab\tc");
    });
});
