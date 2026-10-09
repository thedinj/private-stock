import { afterAll, describe, expect, it } from "vitest";

import { vectorSimilarity } from "@private-stock/core";
import { encodeLookText, stopTextEncoder } from "@private-stock/core/server";

/**
 * The web app's text encoder child, run for real (§5e "Search runs in two passes").
 *
 * Here beside the tokenizer's test because it needs the same pinned files (`pnpm models:fetch`)
 * and the compiled child, which is what the integration suite already has. What it guards is the
 * plumbing — the child is found, starts, answers and is stopped — and that what comes back is a
 * look vector at all: unit length, and nearer to the same idea in other words than to another.
 */
describe("text encoder", () => {
    afterAll(stopTextEncoder);

    it("turns words into a unit vector that means something", async () => {
        const [car, automobile, soup] = await Promise.all([
            encodeLookText("a red car"),
            encodeLookText("a crimson automobile"),
            encodeLookText("a bowl of soup"),
        ]);

        expect(car).toHaveLength(512);
        expect(Math.hypot(...car)).toBeCloseTo(1, 4);
        expect(vectorSimilarity(car, automobile)).toBeGreaterThan(vectorSimilarity(car, soup));
    });

    it("answers the same words the same way", async () => {
        const first = await encodeLookText("rain on a window");
        const second = await encodeLookText("rain on a window");

        expect(vectorSimilarity(first, second)).toBeCloseTo(1, 5);
    });
});
