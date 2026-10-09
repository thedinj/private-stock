import { describe, expect, it } from "vitest";

import type { MediaCopy, MediaDetail } from "@private-stock/core";

import { planTrash, tickedByDefault } from "./trashCopies";

/**
 * What the delete confirmation does with an item's copies (§10d): which start ticked, and
 * when it warns that the best copy is going or says that nothing stays.
 */

const copy = (id: string, fields: Partial<MediaCopy> = {}): MediaCopy => ({
    id,
    kind: "video",
    title: id,
    durationMs: 600_000,
    width: 1920,
    height: 1080,
    addedAt: "2026-01-01T00:00:00Z",
    capturedAt: null,
    sizeBytes: 1_000,
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
    directPlay: false,
    relPath: `${id}.mp4`,
    rootLabel: "Films",
    deletable: true,
    bitrate: null,
    codec: null,
    costOfKeeping: null,
    clipCount: 0,
    identical: false,
    best: false,
    caution: null,
    ...fields,
});

const standing = (
    fields: Partial<NonNullable<MediaDetail["duplicate"]>> = {}
): NonNullable<MediaDetail["duplicate"]> => ({
    copies: 3,
    best: false,
    advice: "",
    clipsAtRisk: { mine: 0, total: 0, reels: [] },
    ...fields,
});

describe("which copies start ticked", () => {
    it("ticks an identical copy", () => {
        expect(tickedByDefault(copy("twin", { identical: true }))).toBe(true);
    });

    it("leaves a near duplicate for a person to look at", () => {
        expect(tickedByDefault(copy("near"))).toBe(false);
    });

    it("leaves an identical copy with clips on it unticked", () => {
        expect(tickedByDefault(copy("twin", { identical: true, clipCount: 2 }))).toBe(false);
    });

    it("leaves an identical copy on a read-only root unticked", () => {
        expect(tickedByDefault(copy("twin", { identical: true, deletable: false }))).toBe(false);
    });
});

describe("what the confirmation says will stay", () => {
    it("says nothing stays when every copy is ticked", () => {
        const plan = planTrash(
            standing({ copies: 3, best: true }),
            [copy("a"), copy("b")],
            new Set(["a", "b"])
        );

        expect(plan.noneLeft).toBe(true);
        // There is no copy to keep, so there is no mistake to warn about.
        expect(plan.bestGoing).toBe(false);
    });

    it("never counts a read-only copy as going, whatever is ticked", () => {
        const plan = planTrash(
            standing({ copies: 2 }),
            [copy("ro", { deletable: false })],
            new Set(["ro"])
        );

        expect(plan.alsoTrash).toEqual([]);
        expect(plan.noneLeft).toBe(false);
    });

    it("does not claim nothing stays while a copy in an unseen library remains", () => {
        // Three copies in all; the viewer sees one of the other two.
        const plan = planTrash(standing({ copies: 3 }), [copy("a")], new Set(["a"]));

        expect(plan.noneLeft).toBe(false);
    });

    it("warns when the item is the best copy and another stays", () => {
        const plan = planTrash(standing({ copies: 2, best: true }), [copy("a")], new Set());

        expect(plan.bestGoing).toBe(true);
    });

    it("warns when the best copy is ticked and a worse one stays", () => {
        const plan = planTrash(
            standing({ copies: 3 }),
            [copy("best", { best: true }), copy("worse")],
            new Set(["best"])
        );

        expect(plan.bestGoing).toBe(true);
    });

    it("adds up the clips on the ticked copies", () => {
        const plan = planTrash(
            standing({ copies: 3 }),
            [copy("a", { clipCount: 2 }), copy("b", { clipCount: 5 })],
            new Set(["a"])
        );

        expect(plan.clipsOnCopies).toBe(2);
    });
});
