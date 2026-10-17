import { describe, expect, it, vi } from "vitest";

import type { PlaybackBlockedRow } from "@private-stock/db";

vi.mock("@private-stock/db", () => ({ mediaRepo: {} }));

const { groupPlaybackCheck } = await import("./playbackCheckService");

const row = (id: string, overrides: Partial<PlaybackBlockedRow> = {}): PlaybackBlockedRow => ({
    id,
    title: null,
    relPath: `videos/${id}.mp4`,
    durationMs: 60_000,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    codec: "hevc",
    videoProfile: "Main",
    pixFmt: "yuv420p",
    audioCodec: "aac",
    probedAt: "2026-10-17 12:00:00",
    ...overrides,
});

describe("groupPlaybackCheck", () => {
    it("groups by kind, largest first, with the first two of each as samples", () => {
        const check = groupPlaybackCheck([
            row("a"),
            row("b"),
            row("c"),
            row("t1", { container: "mpegts", codec: "h264", relPath: "x/t1.mpg" }),
        ]);

        expect(check.total).toBe(4);
        expect(check.groups.map((group) => [group.kind, group.count])).toEqual([
            ["HEVC in MP4", 3],
            ["H.264 in MPEG-TS", 1],
        ]);
        // The same samples for every device that asks, so their answers compare.
        expect(check.groups[0]!.samples.map((sample) => sample.id)).toEqual(["a", "b"]);
    });

    it("names an untitled file from its path and notes a silent one", () => {
        const [group] = groupPlaybackCheck([row("quiet", { audioCodec: null })]).groups;

        expect(group!.samples[0]).toMatchObject({ title: expect.any(String), hasAudio: false });
        expect(group!.samples[0]!.title.length).toBeGreaterThan(0);
    });
});
