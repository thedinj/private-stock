import { describe, expect, it } from "vitest";

import {
    bulkClipTagSchema,
    calendarDaySchema,
    clipQuerySchema,
    createClipSchema,
} from "./clips.js";

/**
 * The clip tag contracts (§14d "Tagging clips"): the browser's two fields as the address spells
 * them, and the facet rules a clip's tags follow.
 */

describe("the clip browser's tag fields", () => {
    it("reads comma-separated ids out of the address", () => {
        const query = clipQuerySchema.parse({ videoTags: "pool,park", clipTags: "jumping" });

        expect(query.videoTags).toEqual(["pool", "park"]);
        expect(query.clipTags).toEqual(["jumping"]);
    });

    it("lets a clip-side pick widen to its video", () => {
        expect(clipQuerySchema.safeParse({ clipTags: "mia", orVideo: "mia" }).success).toBe(true);
        expect(clipQuerySchema.safeParse({ clipNotTags: "mia", orVideo: "mia" }).success).toBe(
            true
        );
    });

    it("refuses a widening for a tag that is not picked on the clip side", () => {
        expect(clipQuerySchema.safeParse({ videoTags: "mia", orVideo: "mia" }).success).toBe(false);
    });
});

describe("a clip's facets", () => {
    it("takes performers and keywords as it is saved", () => {
        const input = createClipSchema.parse({
            startMs: 0,
            endMs: 5_000,
            tags: [
                { kind: "performer", name: "Mia", scope: "public" },
                { kind: "tag", name: "funny", scope: "private" },
            ],
        });

        expect(input.tags).toHaveLength(2);
    });

    it("refuses a source, which is a fact about the whole video", () => {
        expect(
            bulkClipTagSchema.safeParse({
                clipIds: ["c1"],
                kind: "source",
                names: ["Camcorder"],
                scope: "public",
            }).success
        ).toBe(false);
    });

    it("refuses a private performer, as on an item", () => {
        expect(
            createClipSchema.safeParse({
                startMs: 0,
                endMs: 5_000,
                tags: [{ kind: "performer", name: "Mia", scope: "private" }],
            }).success
        ).toBe(false);
    });
});

/** The day both /clips and the library's date filters read (§14e "Dates"). */
describe("a calendar day", () => {
    it("takes a day as the date control writes it", () => {
        expect(calendarDaySchema.safeParse("2026-10-31").success).toBe(true);
        expect(clipQuerySchema.parse({ addedFrom: "2026-10-01" }).addedFrom).toBe("2026-10-01");
    });

    it("refuses a day that is not on the calendar, or not a day at all", () => {
        expect(calendarDaySchema.safeParse("2026-02-30").success).toBe(false);
        expect(calendarDaySchema.safeParse("2026-13-01").success).toBe(false);
        expect(calendarDaySchema.safeParse("31/10/2026").success).toBe(false);
        expect(clipQuerySchema.safeParse({ addedTo: "2026-02-29" }).success).toBe(false);
    });
});
