import { describe, expect, it } from "vitest";

import { pictureFits } from "./privateScreening";

describe("pictureFits", () => {
    it("fits a picture the same way up as the screen", () => {
        expect(pictureFits({ width: 1920, height: 1080 }, "landscape")).toBe(true);
        expect(pictureFits({ width: 1080, height: 1920 }, "portrait")).toBe(true);
    });

    it("does not fit a picture the other way up", () => {
        expect(pictureFits({ width: 1920, height: 1080 }, "portrait")).toBe(false);
        expect(pictureFits({ width: 1080, height: 1920 }, "landscape")).toBe(false);
    });

    it("fits a square picture either way, as the server's filter does", () => {
        expect(pictureFits({ width: 720, height: 720 }, "portrait")).toBe(true);
        expect(pictureFits({ width: 720, height: 720 }, "landscape")).toBe(true);
    });

    it("gives a picture of unknown size the benefit, rather than stopping it", () => {
        expect(pictureFits({ width: null, height: null }, "portrait")).toBe(true);
        expect(pictureFits({ width: 1920, height: null }, "portrait")).toBe(true);
    });
});
