import { describe, expect, it } from "vitest";

import { centreSquare, spriteCropStyle } from "./spriteCrop";

/** Cropping a look's matching frame out of a sprite sheet without stretching it (§5e). */
describe("sprite crops", () => {
    const sheet = { sheetWidth: 2000, sheetHeight: 3560 };

    it("takes the centre square of an upright frame", () => {
        expect(centreSquare({ x: 200, y: 356, width: 200, height: 356, ...sheet })).toEqual({
            x: 200,
            y: 434,
            width: 200,
            height: 200,
            ...sheet,
        });
    });

    it("takes the centre square of a wide frame", () => {
        expect(centreSquare({ x: 0, y: 0, width: 200, height: 112, ...sheet })).toMatchObject({
            x: 44,
            y: 0,
            width: 112,
            height: 112,
        });
    });

    it("scales a square evenly, so a square box shows it unstretched", () => {
        const style = spriteCropStyle(
            "s.jpg",
            centreSquare({ x: 200, y: 356, width: 200, height: 356, ...sheet })
        );

        // The sheet over the square's side on both axes: 2000/200 and 3560/200.
        expect(style.backgroundSize).toBe("1000% 1780%");
    });
});
