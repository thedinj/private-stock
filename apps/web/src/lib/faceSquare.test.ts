import { describe, expect, it } from "vitest";

import { faceSquare } from "./faceSquare";

describe("a square around a face on a picture", () => {
    it("is centred on the face, with room around it", () => {
        expect(faceSquare({ x: 0.45, y: 0.4, w: 0.1, h: 0.2 }, 1000, 500)).toEqual({
            x: 430,
            y: 180,
            width: 140,
            height: 140,
            sheetWidth: 1000,
            sheetHeight: 500,
        });
    });

    it("stays inside the picture at its edges", () => {
        const square = faceSquare({ x: 0, y: 0.9, w: 0.1, h: 0.1 }, 1000, 1000);

        expect(square.x).toBe(0);
        expect(square.y + square.height).toBe(1000);
    });

    it("is never larger than the picture's shorter side", () => {
        expect(faceSquare({ x: 0, y: 0, w: 1, h: 1 }, 800, 600).width).toBe(600);
    });
});
