import { describe, expect, it } from "vitest";

import { mediaQuerySchema, parseLookFrame, withSortOverride } from "./media.js";
import { savedQuerySchema } from "./filters.js";

/** How a look is asked for in the library's address, and the order it imposes (§5e). */
describe("asking for a look", () => {
    it("reads a moment, or an item as a whole", () => {
        expect(parseLookFrame("abc-123@4500")).toEqual({ mediaId: "abc-123", atMs: 4500 });
        expect(parseLookFrame("abc-123")).toEqual({ mediaId: "abc-123", atMs: null });
    });

    it("refuses a moment that is not one", () => {
        expect(() => mediaQuerySchema.parse({ like: "abc@4.5" })).toThrow();
        expect(() => mediaQuerySchema.parse({ like: "../x" })).toThrow();
    });

    it("keeps the moment as written, so the query writes back into its address", () => {
        expect(mediaQuerySchema.parse({ like: "abc@4500" }).like).toBe("abc@4500");
    });

    it("orders by the look whatever sort was asked for", () => {
        const query = withSortOverride(mediaQuerySchema.parse({ lookText: "neon", sort: "title" }));

        expect(query.sort).toBe("look");
    });

    it("falls back to date added for a look order with no look", () => {
        expect(withSortOverride(mediaQuerySchema.parse({ sort: "look" })).sort).toBe("addedAt");
    });

    it("is not kept by a saved filter, yet", () => {
        const saved = savedQuerySchema.parse({ lookText: "neon", like: "abc@1", sort: "addedAt" });

        expect(saved).not.toHaveProperty("lookText");
        expect(saved).not.toHaveProperty("like");
    });
});
