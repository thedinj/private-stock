import { describe, expect, it } from "vitest";

import { bulkClipTagSchema, clipQuerySchema, createClipSchema } from "./clips.js";

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
