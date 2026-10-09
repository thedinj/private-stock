import { describe, expect, it } from "vitest";

import {
    RESUME_EDGE_MS,
    openingTarget,
    parseAtParam,
    rememberPosition,
    resumeTarget,
    visitPosition,
} from "./resumePoint";

/**
 * The rule the player seeks by and the page warms by.
 *
 * Worth its own test precisely because the two callers cannot be allowed to drift: a warm to an
 * offset the player will not seek to is bandwidth spent on the wrong part of a file, and it
 * fails silently — it looks exactly like no warm at all.
 */

describe("where an item opens", () => {
    it("returns the recorded position when it is a real one", () => {
        expect(resumeTarget(272_000, 3_600_000)).toBe(272_000);
    });

    it("has nothing to return when nothing was recorded", () => {
        expect(resumeTarget(null, 3_600_000)).toBeNull();
        expect(resumeTarget(undefined, 3_600_000)).toBeNull();
        expect(resumeTarget(0, 3_600_000)).toBeNull();
    });

    it("ignores a position inside the opening edge", () => {
        expect(resumeTarget(RESUME_EDGE_MS - 1, 3_600_000)).toBeNull();
        expect(resumeTarget(RESUME_EDGE_MS, 3_600_000)).toBe(RESUME_EDGE_MS);
    });

    it("ignores a position at the end, which is a finished item and not a place", () => {
        expect(resumeTarget(3_599_000, 3_600_000)).toBeNull();
        expect(resumeTarget(3_596_000, 3_600_000)).toBeNull();
        // The boundary is "further than the edge", so the edge itself is still a place.
        expect(resumeTarget(3_595_000, 3_600_000)).toBe(3_595_000);
    });

    it("keeps a real position when the duration is unknown", () => {
        // An item the probe could not measure still resumes: the end-of-item guard is the only
        // thing the duration was for, and refusing without it would lose the position entirely.
        expect(resumeTarget(272_000, null)).toBe(272_000);
    });

    it("distinguishes the beginning from a seek to zero", () => {
        // The distinction the warming path needs. Zero as a *target* would tell a preloading
        // element to seek, which is the one thing it must not do when the item starts at its
        // beginning and has already buffered from there.
        expect(resumeTarget(0, 1_000)).toBeNull();
    });
});

describe("parseAtParam", () => {
    it("reads whole milliseconds and refuses anything else", () => {
        expect(parseAtParam("83000")).toBe(83_000);
        expect(parseAtParam("1234.7")).toBe(1234);
        expect(parseAtParam("0")).toBe(0);
        expect(parseAtParam(null)).toBeNull();
        expect(parseAtParam("")).toBeNull();
        expect(parseAtParam("abc")).toBeNull();
        expect(parseAtParam("-5")).toBeNull();
        expect(parseAtParam("1e9")).toBeNull();
    });
});

describe("openingTarget", () => {
    it("prefers a moment the address names over the resume point", () => {
        expect(openingTarget(83_000, 272_000, 3_600_000)).toBe(83_000);
    });

    it("keeps a moment inside the edges, because somebody chose it", () => {
        // A capture two seconds in is a real moment; the edge rule is for recorded noise.
        expect(openingTarget(2_000, null, 3_600_000)).toBe(2_000);
        expect(openingTarget(0, 272_000, 3_600_000)).toBe(0);
    });

    it("clamps a moment past the end to the end", () => {
        expect(openingTarget(9_000_000, null, 3_600_000)).toBe(3_600_000);
        expect(openingTarget(9_000_000, null, null)).toBe(9_000_000);
    });

    it("falls back to the resume rule when the address names nothing", () => {
        expect(openingTarget(null, 272_000, 3_600_000)).toBe(272_000);
        expect(openingTarget(undefined, RESUME_EDGE_MS - 1, 3_600_000)).toBeNull();
    });
});

describe("a position kept for the visit", () => {
    it("is per item, and the latest one left wins", () => {
        expect(visitPosition("never-opened")).toBeNull();

        rememberPosition("a", 40_000);
        rememberPosition("b", 90_000);
        rememberPosition("a", 61_000);

        expect(visitPosition("a")).toBe(61_000);
        expect(visitPosition("b")).toBe(90_000);
    });

    it("goes through the edges, so an item left at its end opens at its beginning", () => {
        rememberPosition("ended", 3_600_000);

        expect(resumeTarget(visitPosition("ended"), 3_600_000)).toBeNull();
    });
});
