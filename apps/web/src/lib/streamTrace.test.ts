import { describe, expect, it } from "vitest";

import { traceStream } from "./streamTrace";

const describeStream = (disclose: boolean) => ({
    mediaId: "3f9a0c12-0000-0000-0000-000000000000",
    range: { start: 0, end: 1023 },
    sizeBytes: 4096,
    isVariant: false,
    receivedAt: performance.now(),
    disclose,
});

const ended = { outcome: "ended" as const, bytes: 1024, firstChunkMs: 1 };

describe("tracing a stream", () => {
    /** How busy the server is with other people's streams is not for the internet (§12). */
    it("tells nobody but an admin", () => {
        const trace = traceStream(describeStream(false));

        expect(trace.headers).toEqual({});
        trace.settled(ended);
    });

    it("numbers streams and counts the ones already running", () => {
        const first = traceStream(describeStream(true));
        const second = traceStream(describeStream(true));

        expect(Number(second.headers["X-PS-Stream"])).toBe(
            Number(first.headers["X-PS-Stream"]) + 1
        );
        expect(Number(second.headers["X-PS-Active-Streams"])).toBe(
            Number(first.headers["X-PS-Active-Streams"]) + 1
        );
        expect(second.headers["X-PS-Source"]).toBe("original");
        expect(second.headers["Server-Timing"]).toMatch(/^decide;desc="[^"]+";dur=\d/);

        first.settled(ended);

        const third = traceStream(describeStream(true));

        // The first has ended, so only the second is still running.
        expect(third.headers["X-PS-Active-Streams"]).toBe(second.headers["X-PS-Active-Streams"]);

        second.settled(ended);
        third.settled(ended);
    });
});
