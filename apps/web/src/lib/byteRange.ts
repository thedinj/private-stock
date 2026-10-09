/**
 * Byte ranges for the direct-play path, and the window that bounds them (§8, §8b).
 *
 * Pure logic, in its own file and under test, because the range arithmetic is the part of the
 * media route that can be wrong in ways nobody notices: an off-by-one in `Content-Range` is a
 * video that plays and stutters, and a missing bound is a route that works perfectly in
 * development and freezes a NAS.
 */

/**
 * How many bytes an open-ended range is answered with.
 *
 * **This is the bound that was missing, and it belongs on the server.** A `<video>` opens with
 * `Range: bytes=0-`, meaning "everything you have", and this route used to take it literally:
 * one 206 carrying a 565 MB file, pumped through the web process in 64 KB chunks for ten
 * minutes. Node serves on one thread, so for those ten minutes every other request — a rating,
 * a progress save, a page — queued behind the pumping. A 131-byte stats read measured 2.6 s of
 * server time, an 11-byte progress save took 5.5 s to deliver its body, and a delete looked
 * like the app had locked up (§20).
 *
 * Worse, the file being drained was usually not the one being watched: the warming element
 * preloads the *next* item with `preload="auto"` (§8b), and "the browser decides how much"
 * meant it decided on all of it.
 *
 * Eight megabytes is chosen from both ends. It is far more than a player needs before it can
 * start — the moov atom and several seconds of video — so first frames are unaffected; and at
 * NAS throughput it is a fraction of a second of pumping, so nothing else waits on it. The
 * browser simply asks again as it buffers, which over HTTP/2 costs one multiplexed request
 * rather than a connection.
 */
export const RANGE_WINDOW_BYTES = 8 * 1024 * 1024;

/** How much of the file to read at a time. Sixteen times `createReadStream`'s default. */
export const STREAM_CHUNK_BYTES = 1024 * 1024;

export interface ByteRange {
    start: number;
    end: number;
}

/**
 * Parse a single-range `Range` header, bounded by the window.
 *
 * Returns null when there is no range to honour, which the caller answers with a 200 and the
 * whole file — the only correct answer to a request that did not ask for part of one.
 *
 * Multi-range requests are parsed as no range for the same reason they always were: no video
 * element asks for them, and `multipart/byteranges` for a case that never occurs is a
 * liability rather than completeness.
 */
export const parseRange = (
    header: string | null,
    size: number
): ByteRange | "unsatisfiable" | null => {
    if (!header) {
        return null;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());

    if (!match) {
        return null;
    }

    const [, rawStart, rawEnd] = match;

    if (rawStart === "" && rawEnd === "") {
        return null;
    }

    let start: number;
    let end: number;

    if (rawStart === "") {
        // "bytes=-500" means the final 500 bytes — how players read a trailing moov atom.
        const suffixLength = Number(rawEnd);

        if (suffixLength <= 0) {
            return "unsatisfiable";
        }

        start = Math.max(0, size - suffixLength);
        end = size - 1;
    } else {
        start = Number(rawStart);
        end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        return "unsatisfiable";
    }

    /**
     * The window, applied to what the client asked for rather than to what it gets.
     *
     * An explicit end is honoured as given — a client that named its last byte has a reason,
     * and shortening a 2 MB request would only make it ask twice. It is the *open* end that
     * needs bounding, because "to the end of the file" is the one request whose cost has no
     * relation to what the player is about to play.
     *
     * A suffix range (`bytes=-500`) is left alone too: it is bounded by construction, and it
     * is how a player finds the index it needs before it can ask for anything else.
     */
    const open = rawStart !== "" && rawEnd === "";
    const limit = start + RANGE_WINDOW_BYTES - 1;

    return { start, end: open ? Math.min(end, limit) : end };
};
