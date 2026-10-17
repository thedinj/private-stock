import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { segmentIndexRelPath, type SegmentIndex } from "@private-stock/core";

import type { ResolvedFile } from "./mediaService";

/**
 * Whether an MPEG-TS file is answered with a playlist (§8). Only when its index describes the
 * file being served: an index of other bytes would send the player to the wrong places in these.
 */

let dataDir = "";

vi.mock("@private-stock/core/server", () => ({ loadConfig: () => ({ dataDir }) }));

const { segmentPlaylist } = await import("./segmentService");

const MEDIA_ID = "ab123456-0000-0000-0000-000000000000";

const file: ResolvedFile = {
    absolutePath: "/media/show.mpg",
    sizeBytes: 10_000,
    mtimeMs: 1_750_000_000_123.5,
    relPath: "show.mpg",
    kind: "video",
    container: "mpegts",
    isVariant: false,
    segments: true,
};

const index: SegmentIndex = {
    version: 1,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    durationMs: 12_000,
    keyframes: [
        [1000, 564],
        [7000, 5000],
    ],
};

const writeIndex = (contents: unknown) => {
    const target = path.join(dataDir, segmentIndexRelPath(MEDIA_ID));

    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof contents === "string" ? contents : JSON.stringify(contents));
};

beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "segments-"));
});

afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe("segmentPlaylist", () => {
    it("builds the playlist from an index of this file", () => {
        writeIndex(index);

        const playlist = segmentPlaylist(MEDIA_ID, file, "stream?raw=1");

        expect(playlist).toContain("#EXT-X-BYTERANGE:5000@0");
        expect(playlist).toContain("#EXT-X-BYTERANGE:5000@5000");
        expect(playlist).toContain("stream?raw=1");
    });

    it("gives none before the stage has run", () => {
        expect(segmentPlaylist(MEDIA_ID, file, "x")).toBeNull();
    });

    it("gives none for an index of a file that has since been replaced", () => {
        writeIndex({ ...index, sizeBytes: 9_999 });
        expect(segmentPlaylist(MEDIA_ID, file, "x")).toBeNull();

        writeIndex({ ...index, mtimeMs: file.mtimeMs + 5_000 });
        expect(segmentPlaylist(MEDIA_ID, file, "x")).toBeNull();
    });

    it("gives none for an index it cannot read", () => {
        writeIndex("{not json");
        expect(segmentPlaylist(MEDIA_ID, file, "x")).toBeNull();

        writeIndex({ ...index, keyframes: [] });
        expect(segmentPlaylist(MEDIA_ID, file, "x")).toBeNull();
    });
});
