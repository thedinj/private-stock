import { describe, expect, it } from "vitest";

import type { KeepCandidate } from "@private-stock/core";

import { costOfKeeping, duplicateStanding, keepReason } from "./keepAdvice";

/**
 * The sentences that decide which copy survives (§10c).
 *
 * These are not decoration. The ordering has been right all along and the review screen still
 * lost to instinct, because a grid of numbers with one badge on it is an assertion and
 * "keep the bigger file" is a belief — and size is the rule the ordering deliberately puts
 * last. What is tested here is whether the words say the true thing: a card that claims a
 * disadvantage that does not exist would undermine every card that names a real one, and a
 * warning on the wrong copy is worse than no warning at all.
 */

const copy = (mediaId: string, fields: Partial<KeepCandidate> = {}): KeepCandidate => ({
    mediaId,
    width: 1280,
    height: 720,
    bitrate: 4_000_000,
    sizeBytes: 1_000_000,
    durationMs: 600_000,
    addedAt: "2026-01-01 00:00:00",
    ...fields,
});

/** The ranking tests are about which copy wins, not about what a purge would destroy. */
const NO_CLIPS = { mine: 0, total: 0, reels: [] };

describe("why the recommended copy won", () => {
    it("names the resolution when that is what separates them", () => {
        const best = copy("a", { width: 1920, height: 1080 });

        expect(keepReason(best, copy("b"))).toBe("Highest resolution — 1920×1080");
    });

    it("does not claim resolution when the resolutions match", () => {
        const best = copy("a", { bitrate: 8_000_000 });

        expect(keepReason(best, copy("b"))).toBe("Same resolution, highest bitrate");
    });

    it("says how much longer, when length is the reason", () => {
        const best = copy("a", { durationMs: 900_000 });

        expect(keepReason(best, copy("b"))).toBe("Longest by 5 minutes");
    });

    /** Age is a tiebreaker, not a quality signal, and the wording has to admit that. */
    it("admits when the copies are alike and age broke the tie", () => {
        const best = copy("a", { addedAt: "2025-01-01 00:00:00" });

        expect(keepReason(best, copy("b"))).toBe("Alike on every measure — in the library longest");
    });

    it("has something to say about a group with only one copy left", () => {
        expect(keepReason(copy("a"), undefined)).toBe("The only copy with a file");
    });
});

describe("what keeping a lesser copy would cost", () => {
    /**
     * The figure people underestimate most: halving each side quarters the picture. "Fewer
     * pixels" invites an argument, a percentage ends one.
     */
    it("puts a number on the pixels rather than calling them fewer", () => {
        const best = copy("a", { width: 1920, height: 1080 });

        expect(costOfKeeping(best, copy("b"))).toBe("1280×720 — 44% of the pixels");
    });

    it("measures how much of the item is missing", () => {
        const best = copy("a", { durationMs: 900_000 });

        expect(costOfKeeping(best, copy("b"))).toBe("5 minutes shorter");
    });

    it("says nothing about the recommended copy itself", () => {
        const best = copy("a");

        expect(costOfKeeping(best, best)).toBeNull();
    });

    /** A claimed disadvantage that does not exist would discredit every real one. */
    it("says nothing when the two copies are genuinely indistinguishable", () => {
        expect(costOfKeeping(copy("a"), copy("b", { addedAt: "2026-01-01 00:00:00" }))).toBeNull();
    });
});

describe("what to say at the moment one is deleted", () => {
    it("says nothing at all about an item with no duplicates", () => {
        expect(duplicateStanding("a", [copy("a")], NO_CLIPS)).toBeNull();
    });

    it("warns when the item being deleted is the best copy", () => {
        const standing = duplicateStanding(
            "a",
            [copy("a", { width: 1920, height: 1080 }), copy("b")],
            NO_CLIPS
        );

        expect(standing?.best).toBe(true);
        expect(standing?.copies).toBe(2);
        expect(standing?.advice).toContain("best of 2 copies");
        // What would be left, so the warning is a comparison rather than a scolding.
        expect(standing?.advice).toContain("1280×720");
    });

    /**
     * The other half, and it is not optional. A warning that only ever appeared would read as
     * a general discouragement from tidying up, which across a library this size costs more
     * than the mistake it prevents.
     */
    it("reassures when a better copy is the one staying", () => {
        const standing = duplicateStanding(
            "b",
            [copy("a", { width: 1920, height: 1080 }), copy("b")],
            NO_CLIPS
        );

        expect(standing?.best).toBe(false);
        expect(standing?.advice).toContain("44% of the pixels");
        expect(standing?.advice).toContain("The better copy stays");
    });

    it("counts the copies rather than the group's membership", () => {
        const standing = duplicateStanding("c", [copy("a"), copy("b"), copy("c")], NO_CLIPS);

        expect(standing?.copies).toBe(3);
    });

    it("says nothing about an item that is not among the copies it was given", () => {
        expect(duplicateStanding("z", [copy("a"), copy("b")], NO_CLIPS)).toBeNull();
    });
});
