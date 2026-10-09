import { describe, expect, it } from "vitest";

import type { MediaListItem } from "@private-stock/core";

import { pickVoice, voiceLeaving, type VoiceCandidate } from "./voice";

const item = (id: string, over: Partial<MediaListItem> = {}): MediaListItem => ({
    id,
    kind: "video",
    title: id,
    durationMs: 60_000,
    width: null,
    height: null,
    addedAt: "2026-09-28T00:00:00.000Z",
    capturedAt: null,
    sizeBytes: null,
    coverUrl: null,
    previewUrl: null,
    rating: null,
    favorite: false,
    watchedAt: null,
    tags: [],
    tagCount: 0,
    performers: [],
    performerCount: 0,
    probed: true,
    directPlay: true,
    ...over,
});

const VIEWPORT = 1_000;
const HEIGHT = 200;

/** A tile whose centre sits at `centre` on a 1000px screen. */
const tile = (id: string, centre: number, over: Partial<MediaListItem> = {}): VoiceCandidate => ({
    key: `0:0:${id}`,
    item: item(id, over),
    top: centre - HEIGHT / 2,
    height: HEIGHT,
});

const still = {
    viewport: VIEWPORT,
    driftPxPerS: 0,
    leadMs: 0,
    clipMs: 10_000,
    exclude: new Set<string>(),
};

describe("pickVoice", () => {
    it("picks only films the browser can play", () => {
        const picked = pickVoice(
            [
                tile("photo", 500, { kind: "image" }),
                tile("blocked", 500, { directPlay: false }),
                tile("film", 500),
            ],
            { ...still, random: () => 0 }
        );

        expect(picked?.item.id).toBe("film");
    });

    it("returns nothing when nothing on screen can play", () => {
        expect(pickVoice([tile("photo", 500, { kind: "image" })], still)).toBeNull();
        expect(pickVoice([], still)).toBeNull();
    });

    it("leaves out excluded tiles and items", () => {
        const a = tile("a", 500);
        const b = tile("b", 500);

        expect(
            pickVoice([a, b], { ...still, exclude: new Set([a.key]), random: () => 0 })?.item.id
        ).toBe("b");
        expect(
            pickVoice([a, b], { ...still, exclude: new Set(["b"]), random: () => 0.99 })?.item.id
        ).toBe("a");
    });

    it("never picks a tile outside the middle band of a still wall", () => {
        expect(pickVoice([tile("top", 100), tile("bottom", 900)], still)).toBeNull();
    });

    it("leans towards the middle", () => {
        const counts = { middle: 0, edge: 0 };
        let seed = 0;
        // A deterministic spread of draws across [0, 1).
        const random = () => (seed = (seed + 0.618034) % 1);

        for (let i = 0; i < 200; i += 1) {
            const picked = pickVoice([tile("middle", 500), tile("edge", 250)], {
                ...still,
                random,
            });

            counts[picked!.item.id as "middle" | "edge"] += 1;
        }

        expect(counts.middle).toBeGreaterThan(counts.edge * 1.4);
    });

    it("prefers a low tile while drifting, so the clip finishes in view", () => {
        // 22 px/s over 10 s carries a tile 220px up: one at 300 would leave the band, one at
        // 700 would end up at 480 — right in the middle.
        const picked = pickVoice([tile("high", 300), tile("low", 700)], {
            ...still,
            driftPxPerS: 22,
            random: () => 0,
        });

        expect(picked?.item.id).toBe("low");
    });

    it("counts the lead before a cued tile plays", () => {
        // In five seconds a tile at 300 has drifted to 190, out of the band before it starts.
        const picked = pickVoice([tile("soon-gone", 300)], {
            ...still,
            driftPxPerS: 22,
            leadMs: 5_000,
        });

        expect(picked).toBeNull();
    });

    it("never picks a tile about to leave, even when it is the only one", () => {
        // At 22 px/s a tile centred at 300 has under five seconds before it crosses 200.
        expect(
            pickVoice([tile("leaving", 300)], { ...still, driftPxPerS: 22, clipMs: 60_000 })
        ).toBeNull();
    });

    it("never picks a tile that would start below the band", () => {
        expect(pickVoice([tile("low", 850)], { ...still, driftPxPerS: 22 })).toBeNull();
    });

    it("settles for a partial run when no tile can see a long clip through", () => {
        const picked = pickVoice([tile("only", 700)], {
            ...still,
            driftPxPerS: 22,
            clipMs: 60_000,
        });

        expect(picked?.item.id).toBe("only");
    });
});

describe("voiceLeaving", () => {
    it("holds a voice through the band and a little beyond it", () => {
        expect(voiceLeaving(400, HEIGHT, VIEWPORT)).toBe(false);
        // Centre at 150: out of the pick band, still inside the looser leave line.
        expect(voiceLeaving(50, HEIGHT, VIEWPORT)).toBe(false);
    });

    it("lets go once the centre passes either leave line", () => {
        expect(voiceLeaving(0, HEIGHT, VIEWPORT)).toBe(true);
        expect(voiceLeaving(800, HEIGHT, VIEWPORT)).toBe(true);
    });
});
