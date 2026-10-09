import { describe, expect, it } from "vitest";

import type { MediaListItem } from "@private-stock/core";

import { stageTargets } from "./targets";

const make = (id: string, kind: "video" | "image"): MediaListItem => ({
    id,
    kind,
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
});

const film = (id: string) => make(id, "video");
const still = (id: string) => make(id, "image");

describe("stageTargets", () => {
    it("warms a film after a film in the film layer's own second element", () => {
        const targets = stageTargets(film("a"), film("b"), true);

        expect(targets.video?.id).toBe("a");
        expect(targets.videoLive).toBe(true);
        expect(targets.videoPreload?.id).toBe("b");
        expect(targets.photo).toBeNull();
    });

    it("cues a photograph after a film in the picture layer", () => {
        const targets = stageTargets(film("a"), still("b"), true);

        expect(targets.videoPreload).toBeNull();
        expect(targets.photo?.id).toBe("b");
        expect(targets.photoLive).toBe(false);
    });

    it("cues a film after a photograph in the film layer, held for its turn", () => {
        const targets = stageTargets(still("a"), film("b"), true);

        expect(targets.photo?.id).toBe("a");
        expect(targets.photoLive).toBe(true);
        expect(targets.video?.id).toBe("b");
        expect(targets.videoLive).toBe(false);
    });

    it("warms a photograph after a photograph in the picture layer's second slot", () => {
        const targets = stageTargets(still("a"), still("b"), true);

        expect(targets.photoPreload?.id).toBe("b");
        expect(targets.video).toBeNull();
    });

    it("cues nothing across kinds where warming is refused", () => {
        expect(stageTargets(still("a"), film("b"), false).video).toBeNull();
        expect(stageTargets(film("a"), still("b"), false).photo).toBeNull();
        // Same-kind warming is the layer's own business, gated where it happens.
        expect(stageTargets(film("a"), film("b"), false).videoPreload?.id).toBe("b");
    });

    it("prepares nothing when the set comes round to the same item", () => {
        const targets = stageTargets(film("a"), film("a"), true);

        expect(targets.videoPreload).toBeNull();
        expect(targets.photo).toBeNull();
    });
});
