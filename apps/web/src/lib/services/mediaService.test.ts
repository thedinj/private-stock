import { describe, expect, it, vi } from "vitest";

import type { mediaRepo as MediaRepoTypes } from "@private-stock/db";

vi.mock("@private-stock/db", () => ({}));

const { toListItem } = await import("./mediaService");

/**
 * Whether a tile says its item plays (§8b, §14g).
 *
 * The tasting skips a video on this flag without asking for the item's details, so the list
 * row's verdict has to be the item page's verdict: the same inputs, through the same function.
 */

const row = (over: Partial<MediaRepoTypes.MediaListRow> = {}): MediaRepoTypes.MediaListRow => ({
    id: "m1",
    kind: "video",
    title: "A film",
    durationMs: 60_000,
    width: 1920,
    height: 1080,
    addedAt: "2026-09-28T00:00:00.000Z",
    capturedAt: null,
    probedAt: "2026-09-28T00:00:00.000Z",
    sizeBytes: 1,
    relPath: "films/a.mp4",
    coverPath: null,
    coverGeneratedAt: null,
    previewPath: null,
    previewGeneratedAt: null,
    websafePath: null,
    websafeHeight: null,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    codec: "h264",
    videoProfile: "High",
    pixFmt: "yuv420p",
    audioCodec: "aac",
    rating: null,
    favorite: null,
    watchedAt: null,
    ...over,
});

describe("toListItem directPlay", () => {
    it("is true for an image, whatever its probe says", () => {
        expect(toListItem(row({ kind: "image", codec: "mjpeg", container: null })).directPlay).toBe(
            true
        );
    });

    it("is true for a video the browser plays as it is", () => {
        expect(toListItem(row()).directPlay).toBe(true);
    });

    it("is true for a video not yet probed, which is given the benefit of the doubt", () => {
        expect(toListItem(row({ probedAt: null, container: null, codec: null })).directPlay).toBe(
            true
        );
    });

    it("is false for a video that needs a rendition it does not have", () => {
        expect(
            toListItem(
                row({
                    relPath: "films/a.mov",
                    container: "mov,mp4,m4a,3gp,3g2,mj2",
                    codec: "prores",
                })
            ).directPlay
        ).toBe(false);
    });

    it("is true once a web-safe rendition is ready", () => {
        expect(
            toListItem(
                row({
                    relPath: "films/a.mov",
                    container: "mov,mp4,m4a,3gp,3g2,mj2",
                    codec: "prores",
                    websafePath: "variants/m1.mp4",
                })
            ).directPlay
        ).toBe(true);
    });
});
