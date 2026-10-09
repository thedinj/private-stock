import type { StreamSettlement } from "./fileStream";

/**
 * Following each media stream from request to finish (§8b, "Seeing it work").
 *
 * The question this answers is one a HAR cannot answer alone: when the next video stalls after
 * a swap, is its request queued in the browser behind other streams, slow off the NAS, or
 * starved by streams nobody is watching any more? The browser's side of that is in the HAR's
 * timings; this is the server's side, joined to it by a number.
 *
 * Two outputs:
 *
 * - **Response headers, for admins only.** `X-PS-Stream` numbers the stream,
 *   `X-PS-Active-Streams` says how many the server was already pumping when it began,
 *   `X-PS-Source` says whether the original or the web-safe rendition was served, and
 *   `Server-Timing` says how long the server took to decide what to send. They land in a HAR
 *   with nothing switched on. Admins only, because how busy the server is with other people's
 *   streams is not something to tell the internet (§12).
 * - **A log line per stream when it ends**, behind `PRIVATE_STOCK_STREAM_LOG=1`: bytes sent,
 *   for how long, and whether it ended or was abandoned. Off by default for the reason the
 *   request log is (`requestLog.ts`): a console that stops draining blocks the process writing
 *   to it.
 *
 * Module state, so it counts per process. That is the right scope: the streams that compete
 * are the ones this one thread is pumping.
 */

let nextStream = 1;
let active = 0;

const logging = (): boolean => {
    const value = process.env.PRIVATE_STOCK_STREAM_LOG;

    return value === "1" || value === "true";
};

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export interface StreamTrace {
    headers: Record<string, string>;
    /** Pass to `toWebStream`; called once, however the stream ends. */
    settled: (settlement: StreamSettlement) => void;
}

interface StreamDescription {
    mediaId: string;
    /** `bytes=a-b` as served, or null for the whole file. */
    range: { start: number; end: number } | null;
    sizeBytes: number;
    isVariant: boolean;
    /** When the handler began, from `performance.now()`. */
    receivedAt: number;
    /** Whether to put the trace in the response headers. */
    disclose: boolean;
}

export const traceStream = (description: StreamDescription): StreamTrace => {
    const id = nextStream++;
    const alreadyActive = active;
    const openedAt = performance.now();
    const decideMs = openedAt - description.receivedAt;

    active += 1;

    const headers: Record<string, string> = description.disclose
        ? {
              "X-PS-Stream": String(id),
              "X-PS-Active-Streams": String(alreadyActive),
              "X-PS-Source": description.isVariant ? "websafe" : "original",
              "Server-Timing": `decide;desc="auth, lookup, stat";dur=${decideMs.toFixed(1)}`,
          }
        : {};

    const settled = ({ outcome, bytes, firstChunkMs }: StreamSettlement): void => {
        active -= 1;

        if (!logging()) return;

        const { range } = description;
        const asked = range
            ? `${range.start}-${range.end} (${megabytes(range.end - range.start + 1)})`
            : `whole (${megabytes(description.sizeBytes)})`;
        const seconds = ((performance.now() - openedAt) / 1000).toFixed(1);

        console.warn(
            `[stream] #${id} ${description.mediaId.slice(0, 8)} ${asked} ` +
                `${description.isVariant ? "websafe" : "original"} · ` +
                `${outcome} after ${megabytes(bytes)} in ${seconds}s · ` +
                `first chunk ${firstChunkMs === null ? "never" : `${firstChunkMs.toFixed(0)}ms`} · ` +
                `${alreadyActive} other(s) active at start, ${active} now`
        );
    };

    return { headers, settled };
};
