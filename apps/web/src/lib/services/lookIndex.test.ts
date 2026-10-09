import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { EMBED_DIMS, encodeRepresentatives, quantize, type VectorFile } from "@private-stock/core";

import { currentLookIndex } from "./lookIndex";

/**
 * The web process's index of representatives (§5e "Search runs in two passes"), kept current from the worker's
 * append-only log by reading only what was added -- including a record caught half written.
 */

const dir = mkdtempSync(path.join(tmpdir(), "ps-lookindex-"));
const log = path.join(dir, "reps.log");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const record = (mediaId: string, count: number): Uint8Array => {
    const file: VectorFile = {
        model: "clip-b32-vision-uint8",
        stageVersion: 1,
        dims: EMBED_DIMS,
        vectors: Array.from({ length: count }, (_, i) => ({
            atMs: i * 1000,
            square: 0,
            vector: quantize(new Float32Array(EMBED_DIMS).fill(1 / Math.sqrt(EMBED_DIMS))),
        })),
        representatives: Array.from({ length: count }, (_, i) => i),
    };

    return encodeRepresentatives(mediaId, file);
};

const join = (...parts: Uint8Array[]): Uint8Array => {
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;

    for (const part of parts) {
        bytes.set(part, at);
        at += part.length;
    }

    return bytes;
};

describe("the look index", () => {
    const a = record("a", 2);
    const b = record("b", 1);
    const a2 = record("a", 3);

    it("reads a record caught half written once it is whole, and not before", () => {
        writeFileSync(log, join(a, b.subarray(0, 100)));

        const first = currentLookIndex(log);

        expect(first.entries.map((entry) => entry.mediaId)).toEqual(["a"]);

        const version = first.version;

        writeFileSync(log, join(a, b));

        const second = currentLookIndex(log);

        expect(second.entries.map((entry) => entry.mediaId)).toEqual(["a", "b"]);
        expect(second.version).toBeGreaterThan(version);
    });

    it("lets an item's last record win, in its old place", () => {
        writeFileSync(log, join(a, b, a2));

        const index = currentLookIndex(log);

        expect(index.entries.map((entry) => entry.mediaId)).toEqual(["a", "b"]);
        expect(index.entries[0].scales).toHaveLength(3);
        expect(Array.from(index.entries[0].atMs)).toEqual([0, 1000, 2000]);
    });

    it("starts again from a log that was replaced by a shorter one", () => {
        writeFileSync(log, b);

        expect(currentLookIndex(log).entries.map((entry) => entry.mediaId)).toEqual(["b"]);
    });

    it("is empty, not broken, before anything has been embedded", () => {
        expect(currentLookIndex(path.join(dir, "missing.log")).entries).toEqual([]);
    });
});
