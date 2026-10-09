import { createReadStream, type ReadStream } from "node:fs";

import { STREAM_CHUNK_BYTES } from "./byteRange";

/**
 * A file the caller has already `stat`ed, opened to be read whole in reads sized to it (§20
 * "The web process's own memory").
 *
 * `createReadStream`'s default is a 64 KB buffer per read whatever the file's size, which two
 * things made expensive here. Every one sits below glibc's mmap threshold, so the art route's
 * buffers -- sixty covers and twelve previews per grid page -- came out of the main heap, where
 * they wait for a garbage collection to be freed and leave holes that heap never hands back. And
 * a 30 KB cover still allocated the full 64 KB and copied out what it read.
 *
 * Bounded by the size, a cover is one read of exactly its size and a preview or a sprite sheet
 * is one read of a few hundred KB -- above the pinned threshold (`entrypoint.sh`), so it is its
 * own mapping and goes back to the system the moment it is collected. A file that grew after the
 * `stat` is cut at the `Content-Length` already promised, rather than overrunning it.
 */
export const openSized = (absolutePath: string, sizeBytes: number): ReadStream =>
    // An empty file has no last byte to name; `end: -1` is a range error, not an empty read.
    sizeBytes > 0
        ? createReadStream(absolutePath, { end: sizeBytes - 1, highWaterMark: STREAM_CHUNK_BYTES })
        : createReadStream(absolutePath);

/**
 * Serving a file as a web stream that survives the client going away.
 *
 * `Readable.toWeb()` looks like the obvious answer and is a trap here. A viewer who seeks,
 * closes the tab, or drops off the wifi cancels the response *mid-read*, and the adapter then
 * calls `enqueue` or `close` on a controller the runtime has already closed. That throws
 * asynchronously, outside any request handler, so it arrives as an `uncaughtException` rather
 * than a failed request:
 *
 *     ⨯ uncaughtException: [TypeError: Invalid state: Controller is already closed]
 *
 * Nothing is wrong with the file, the range, or the response — the bytes were delivered. But
 * an unhandled exception in a Next server is a process-level event, and seeking a video is
 * the single most ordinary thing a person does here. So the adapter is written out by hand:
 * every controller call is guarded by a flag, and the cancel path destroys the file handle
 * rather than leaving it to be collected.
 *
 * Shared by the media route and the art route because both had the same hole, and a fix
 * applied to one of two identical call sites is a fix with a timer on it.
 */
/**
 * How a stream ended, for whoever is tracing it (`streamTrace.ts`). `aborted` is the reader
 * going away first: a seek, a closed tab, or a `<video>` that stopped wanting the bytes.
 */
export interface StreamSettlement {
    outcome: "ended" | "aborted" | "error";
    bytes: number;
    /** Milliseconds from the stream being built to the first chunk off the disk, or null. */
    firstChunkMs: number | null;
}

export const toWebStream = (
    stream: ReadStream,
    signal?: AbortSignal,
    onSettled?: (settlement: StreamSettlement) => void
): ReadableStream => {
    let closed = false;
    let bytes = 0;
    let firstChunkMs: number | null = null;
    const begun = performance.now();

    const settle = (outcome: StreamSettlement["outcome"]): void => {
        const report = onSettled;

        // Once: whichever of end, error and abandon comes first is the answer.
        onSettled = undefined;
        report?.({ outcome, bytes, firstChunkMs });
    };

    /** Destroy the file handle. A reader that has gone away is not going to read the rest. */
    const abandon = (): void => {
        closed = true;
        settle("aborted");

        if (!stream.destroyed) {
            stream.destroy();
        }
    };

    return new ReadableStream({
        start(controller) {
            stream.on("data", (chunk) => {
                if (closed) {
                    return;
                }

                firstChunkMs ??= performance.now() - begun;
                bytes += chunk.length;

                try {
                    /**
                     * Enqueued as it came off the disk, not copied.
                     *
                     * `new Uint8Array(buffer)` was a full copy of every byte served — on a
                     * 565 MB film, 565 MB of memcpy on the thread that also answers every
                     * request (§20). It bought nothing: `Buffer` *is* a `Uint8Array`, so the
                     * stream accepts it as it is. Only the string case needs converting, which
                     * a binary read never produces and an encoding-configured one always does.
                     */
                    controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
                } catch {
                    // The consumer closed between the read and the write. That is a
                    // disconnect, not an error worth reporting: the request is over.
                    abandon();

                    return;
                }

                // Backpressure. Without it a fast disk feeds a slow client until the whole
                // range is buffered in memory, which on a two-hour film is the difference
                // between a few megabytes and the whole file.
                if ((controller.desiredSize ?? 1) <= 0) {
                    stream.pause();
                }
            });

            stream.on("end", () => {
                if (closed) {
                    return;
                }

                closed = true;
                settle("ended");

                try {
                    controller.close();
                } catch {
                    // Already closed by the runtime.
                }
            });

            stream.on("error", (error) => {
                if (closed) {
                    return;
                }

                closed = true;
                settle("error");

                try {
                    controller.error(error);
                } catch {
                    // Nobody left to tell.
                }
            });

            // A disconnect usually arrives as a cancel on the stream, but an aborted request
            // can beat it — and then nothing else would ever close the file handle.
            signal?.addEventListener("abort", abandon);
        },

        pull() {
            stream.resume();
        },

        cancel() {
            abandon();
        },
    });
};
