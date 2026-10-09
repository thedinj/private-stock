import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { STREAM_CHUNK_BYTES } from "./byteRange";
import { openSized, toWebStream } from "./fileStream";

/**
 * Serving bytes to someone who stops listening (§8).
 *
 * The case that matters is not the happy one. `Readable.toWeb()` passed every test anyone
 * would think to write and still took the server down in ordinary use: a viewer seeking a
 * video cancels the response mid-read, the adapter calls `enqueue` on a controller the
 * runtime has already closed, and the throw lands outside any request handler as an
 * `uncaughtException`. Nothing was wrong with the file or the range.
 *
 * So these tests are mostly about disconnects, and they assert the absence of a throw — which
 * is worth stating plainly because it looks like a test that checks nothing.
 */

let workDir: string;
let filePath: string;

const CONTENT = Buffer.alloc(512 * 1024, "x");

beforeAll(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "ps-stream-"));
    filePath = path.join(workDir, "bytes.bin");
    writeFileSync(filePath, CONTENT);
});

afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
});

/** Collect a whole web stream, as a client that reads to the end would. */
const drain = async (stream: ReadableStream): Promise<number> => {
    const reader = stream.getReader();
    let total = 0;

    for (;;) {
        const { done, value } = await reader.read();

        if (done) {
            return total;
        }

        total += (value as Uint8Array).length;
    }
};

describe("serving a file", () => {
    it("delivers every byte", async () => {
        expect(await drain(toWebStream(createReadStream(filePath)))).toBe(CONTENT.length);
    });

    it("delivers a byte range and nothing more", async () => {
        const stream = toWebStream(createReadStream(filePath, { start: 100, end: 199 }));

        expect(await drain(stream)).toBe(100);
    });

    it("reports a file that is not there, rather than hanging", async () => {
        const stream = toWebStream(createReadStream(path.join(workDir, "absent.bin")));

        await expect(drain(stream)).rejects.toThrow();
    });
});

describe("when the client goes away", () => {
    it("closes the file handle instead of reading on", async () => {
        const file = createReadStream(filePath);
        const stream = toWebStream(file);
        const reader = stream.getReader();

        await reader.read();
        await reader.cancel();

        // A reader that has gone is not going to read the rest. Left open, one handle per
        // abandoned seek is a file descriptor leak on the box the library lives on.
        expect(file.destroyed).toBe(true);
    });

    it("does not throw when the source keeps going after a cancel", async () => {
        const file = createReadStream(filePath, { highWaterMark: 1024 });
        const stream = toWebStream(file);
        const reader = stream.getReader();

        await reader.read();
        await reader.cancel();

        // The exact shape of the production failure: chunks already in flight arrive after
        // the controller is closed. Every one of them must be dropped silently, because there
        // is no handler left to catch what they would throw -- it surfaces as an
        // uncaughtException and takes the process with it.
        file.emit("data", Buffer.alloc(16));
        file.emit("end");

        await new Promise((resolve) => setImmediate(resolve));
    });

    it("lets an aborted request close the handle even if nothing cancels the stream", async () => {
        const controller = new AbortController();
        const file = createReadStream(filePath);

        toWebStream(file, controller.signal);
        controller.abort();

        // A disconnect usually arrives as a cancel, but an abort can beat it -- and then
        // nothing else would ever close the file.
        expect(file.destroyed).toBe(true);
    });

    it("survives an error arriving after the reader has gone", async () => {
        const file = createReadStream(filePath);
        const stream = toWebStream(file);
        const reader = stream.getReader();

        await reader.read();
        await reader.cancel();

        file.emit("error", new Error("disk went away mid-seek"));

        await new Promise((resolve) => setImmediate(resolve));
    });
});

/**
 * How a stream ended, for the stream trace (`streamTrace.ts`). An element that stops reading is
 * the case being looked for: a `<video>` nobody is watching any more, holding a connection.
 */
describe("saying how a stream ended", () => {
    it("reports every byte of a stream read to the end", async () => {
        const settlements: { outcome: string; bytes: number }[] = [];

        await drain(
            toWebStream(createReadStream(filePath), undefined, (settlement) =>
                settlements.push(settlement)
            )
        );

        expect(settlements).toEqual([
            expect.objectContaining({ outcome: "ended", bytes: CONTENT.length }),
        ]);
    });

    it("reports a reader that went away, once", async () => {
        const settlements: { outcome: string }[] = [];
        const stream = toWebStream(createReadStream(filePath), undefined, (settlement) =>
            settlements.push(settlement)
        );

        await stream.getReader().cancel();

        expect(settlements).toEqual([expect.objectContaining({ outcome: "aborted" })]);
    });
});

/** The size of every chunk a read stream produces, in order. */
const chunkSizes = async (stream: NodeJS.ReadableStream): Promise<number[]> => {
    const sizes: number[] = [];

    for await (const chunk of stream) {
        sizes.push((chunk as Buffer).length);
    }

    return sizes;
};

describe("opening a file to be read whole (§20)", () => {
    it("reads a small file in one read of exactly its size", async () => {
        const small = path.join(workDir, "cover.webp");
        writeFileSync(small, Buffer.alloc(30_000, "c"));

        const stream = openSized(small, 30_000);
        const sizes = await chunkSizes(stream);

        expect(sizes).toEqual([30_000]);
        // The read was sized to the file rather than to the default 64 KB buffer and copied out.
        expect(stream.readableHighWaterMark).toBe(STREAM_CHUNK_BYTES);
    });

    it("reads a file larger than one chunk in chunks, every byte once", async () => {
        const large = path.join(workDir, "sprite.webp");
        const size = STREAM_CHUNK_BYTES + 12_345;
        writeFileSync(large, Buffer.alloc(size, "s"));

        expect(await chunkSizes(openSized(large, size))).toEqual([STREAM_CHUNK_BYTES, 12_345]);
    });

    it("stops at the size it was given when the file has grown since", async () => {
        expect(await drain(toWebStream(openSized(filePath, 1000)))).toBe(1000);
    });

    it("reads an empty file as an empty body rather than throwing", async () => {
        const empty = path.join(workDir, "empty.vtt");
        writeFileSync(empty, "");

        expect(await drain(toWebStream(openSized(empty, 0)))).toBe(0);
    });
});
