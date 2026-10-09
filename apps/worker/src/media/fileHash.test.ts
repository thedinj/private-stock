import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contentHashFile, quickHashFile } from "./fileHash.js";

/**
 * File identity (§5).
 *
 * No ffmpeg involved, so this belongs in the fast suite even though it touches the disk —
 * writing a few megabytes to a temp directory is milliseconds.
 *
 * The case that matters is the truncated download. A partial copy shares its opening bytes
 * with the complete original, and on a large file it shares its closing bytes with nothing,
 * so a naive "first and last mebibyte" hash would be right by luck rather than by design.
 */

let workDir: string;

const at = (name: string): string => path.join(workDir, name);

/** Deterministic bytes, so failures reproduce exactly. */
const pattern = (size: number, seed = 1): Buffer => {
    const buffer = Buffer.allocUnsafe(size);

    for (let i = 0; i < size; i += 1) {
        buffer[i] = (i * 31 + seed * 17) & 0xff;
    }

    return buffer;
};

const MIB = 1024 * 1024;

beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "private-stock-filehash-"));

    const large = pattern(3 * MIB);

    await writeFile(at("large.bin"), large);
    await writeFile(at("large-copy.bin"), large);

    // Same opening mebibyte, different content after it.
    const variant = Buffer.from(large);
    variant.fill(0, 2 * MIB);
    await writeFile(at("large-variant.bin"), variant);

    // A truncated download: a prefix of the original, and so a different size.
    await writeFile(at("large-truncated.bin"), large.subarray(0, 2 * MIB));

    await writeFile(at("small.bin"), pattern(1024));
    await writeFile(at("small-copy.bin"), pattern(1024));
    await writeFile(at("small-different.bin"), pattern(1024, 2));
    await writeFile(at("empty.bin"), Buffer.alloc(0));
});

afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
});

describe("quickHashFile", () => {
    it("matches for identical files", async () => {
        expect(await quickHashFile(at("large.bin"))).toBe(
            await quickHashFile(at("large-copy.bin"))
        );
    });

    it("is deterministic", async () => {
        expect(await quickHashFile(at("large.bin"))).toBe(await quickHashFile(at("large.bin")));
    });

    it("differs when the middle of the file differs", async () => {
        // Both files share their first mebibyte, so anything reading only the head would
        // call these identical.
        expect(await quickHashFile(at("large.bin"))).not.toBe(
            await quickHashFile(at("large-variant.bin"))
        );
    });

    it("differs for a truncated copy", async () => {
        /**
         * The reason size is mixed into the hash. A truncated download is a byte-for-byte
         * prefix of the original — without the size, a file whose head and tail windows both
         * fell inside that prefix would hash identically to the complete file, and the app
         * would offer to delete the good copy.
         */
        expect(await quickHashFile(at("large.bin"))).not.toBe(
            await quickHashFile(at("large-truncated.bin"))
        );
    });

    it("handles a file smaller than the sample window", async () => {
        // The head window is then the whole file, and the tail read must not run off the end
        // or double-count what was already read.
        expect(await quickHashFile(at("small.bin"))).toBe(
            await quickHashFile(at("small-copy.bin"))
        );
        expect(await quickHashFile(at("small.bin"))).not.toBe(
            await quickHashFile(at("small-different.bin"))
        );
    });

    it("handles an empty file", async () => {
        expect(await quickHashFile(at("empty.bin"))).toMatch(/^[0-9a-f]{40}$/);
    });

    it("returns null for a file that is not there", async () => {
        // A file deleted between the scan and the job is ordinary, not an error: the next
        // scan marks it missing.
        expect(await quickHashFile(at("gone.bin"))).toBeNull();
    });
});

describe("contentHashFile", () => {
    it("matches for identical files and differs otherwise", async () => {
        expect(await contentHashFile(at("large.bin"))).toBe(
            await contentHashFile(at("large-copy.bin"))
        );
        expect(await contentHashFile(at("large.bin"))).not.toBe(
            await contentHashFile(at("large-variant.bin"))
        );
    });

    it("returns null rather than throwing for a missing file", async () => {
        expect(await contentHashFile(at("gone.bin"))).toBeNull();
    });

    it("is not the same value as the quick hash", async () => {
        // They must never be compared to each other by mistake; different inputs, different
        // meanings.
        expect(await contentHashFile(at("large.bin"))).not.toBe(
            await quickHashFile(at("large.bin"))
        );
    });
});
