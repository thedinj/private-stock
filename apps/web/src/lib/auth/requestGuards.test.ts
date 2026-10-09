import { describe, expect, it } from "vitest";

import { AuthorizationError, ValidationError } from "@private-stock/core";

import { readSmallJson, rejectCrossSite } from "./requestGuards";

const post = (body: BodyInit | null, headers: Record<string, string> = {}): Request =>
    new Request("http://nas:8842/api/auth/login", {
        method: "POST",
        body,
        headers,
        // Required by undici for a streamed body.
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);

describe("rejectCrossSite", () => {
    it("refuses a request another site's page made", () => {
        expect(() => rejectCrossSite(post("{}", { "sec-fetch-site": "cross-site" }))).toThrow(
            AuthorizationError
        );
    });

    it("lets the app's own requests through", () => {
        expect(() =>
            rejectCrossSite(post("{}", { "sec-fetch-site": "same-origin" }))
        ).not.toThrow();
    });

    /** curl and tests send no such header, and are not a browser being steered. */
    it("lets a client that says nothing through", () => {
        expect(() => rejectCrossSite(post("{}"))).not.toThrow();
    });
});

describe("readSmallJson", () => {
    it("parses a small body", async () => {
        await expect(readSmallJson(post('{"email":"a@b.c"}'))).resolves.toEqual({
            email: "a@b.c",
        });
    });

    it("refuses on the declared length alone", async () => {
        const request = post("{}", { "content-length": String(1024 * 1024) });

        await expect(readSmallJson(request, 1024)).rejects.toThrow(ValidationError);
    });

    /** Chunked encoding carries no length, so the stream itself has to be counted. */
    it("stops reading a stream that runs past the limit", async () => {
        let pulled = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull: (controller) => {
                pulled += 1;
                controller.enqueue(new Uint8Array(512).fill(0x20));
            },
        });

        await expect(readSmallJson(post(stream), 1024)).rejects.toThrow(/too large/);
        // An endless body, abandoned after a few chunks rather than read forever.
        expect(pulled).toBeLessThan(10);
    });

    it("answers malformed JSON as the caller's mistake", async () => {
        await expect(readSmallJson(post("{not json"))).rejects.toThrow(ValidationError);
        await expect(readSmallJson(post(null))).rejects.toThrow(ValidationError);
    });
});
