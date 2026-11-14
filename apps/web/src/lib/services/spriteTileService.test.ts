import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NotFoundError } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";
import type { SpriteTileFile } from "./spriteThumb";

/**
 * One sprite tile cut out of its sheet (§5e): the square at its centre, inside the sheet however
 * the tile height rounds, and versioned by the sheet it came from.
 *
 * A real sheet in a temporary directory, cut by sharp; the sprite rows and the art route's checks
 * are stood in for.
 */

const dir = mkdtempSync(path.join(tmpdir(), "ps-tile-"));
const sheetPath = path.join(dir, "sprite-0.webp");

/** 10×10 tiles of 200 × 112.5: the height a 16:9 frame scaled to 200 px wide really has. */
const SHEET = { width: 2000, height: 1125 };

let tile: SpriteTileFile | null = null;

vi.mock("./spriteThumb", () => ({ spriteTileAtIndex: () => tile }));
vi.mock("./artService", () => ({
    resolveArtifact: async () => ({
        absolutePath: sheetPath,
        sizeBytes: 0,
        contentType: "image/webp",
        versioned: false,
    }),
}));
vi.mock("@private-stock/core/server", async (original) => ({
    ...(await original<typeof import("@private-stock/core/server")>()),
    artifactVersion: (relPath: string, generatedAt: string | null) => `${relPath}@${generatedAt}`,
}));

const { tileImage } = await import("./spriteTileService");

const auth = { userId: "u1", scopes: [], accessibleRootIds: ["r1"] } as unknown as AuthContext;

/** The tile at `index`, with the rectangle `spriteThumb` computes for it. */
const tileAt = (index: number): SpriteTileFile => {
    const height = Math.round(SHEET.height / 10);

    return {
        index,
        ordinal: 0,
        relPath: "art/ab/m1/sprite-0.webp",
        generatedAt: "2026-11-13",
        intervalMs: 2000,
        rect: {
            x: (index % 10) * 200,
            y: Math.floor(index / 10) * height,
            width: 200,
            height,
            sheetWidth: SHEET.width,
            sheetHeight: SHEET.height,
        },
    };
};

beforeAll(async () => {
    await sharp({
        create: { ...SHEET, channels: 3, background: { r: 120, g: 30, b: 40 } },
    })
        .webp()
        .toFile(sheetPath);
});

beforeEach(() => {
    tile = null;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("tileImage", () => {
    it("cuts the square at the centre of the tile", async () => {
        tile = tileAt(0);

        const { bytes } = await tileImage("m1", 0, "square", null, auth);
        const meta = await sharp(bytes).metadata();

        expect(meta.format).toBe("webp");
        expect([meta.width, meta.height]).toEqual([113, 113]);
    });

    it("stays inside the sheet on the last row, where the rounded height overruns it", async () => {
        tile = tileAt(99);

        const { bytes } = await tileImage("m1", 99, "square", null, auth);
        const meta = await sharp(bytes).metadata();

        // 9 × 113 = 1017, and 1125 − 1017 leaves 108 rows of the sheet.
        expect(meta.height).toBe(108);
    });

    it("is versioned only when the URL names the sheet it was cut from", async () => {
        tile = tileAt(5);

        const current = await tileImage("m1", 5, "square", tile.relPath + "@2026-11-13", auth);
        const stale = await tileImage("m1", 5, "square", "something older", auth);

        expect(current.versioned).toBe(true);
        expect(stale.versioned).toBe(false);
    });

    it("answers as for an item it cannot see when there is no sprite", async () => {
        await expect(tileImage("m1", 0, "square", null, auth)).rejects.toBeInstanceOf(
            NotFoundError
        );
    });
});
