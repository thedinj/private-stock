import { describe, expect, it } from "vitest";

import { fileEtag, isNotModified, lastModified, rangeStillValid } from "./httpValidators";

const ORIGINAL = { sizeBytes: 565_000_000, mtimeMs: 1_750_000_000_123.9, isVariant: false };
const VARIANT = { ...ORIGINAL, isVariant: true };

describe("fileEtag", () => {
    it("is a quoted strong tag", () => {
        expect(fileEtag(ORIGINAL)).toMatch(/^"[^"]+"$/);
    });

    it("tells the original from the variant even when size and mtime coincide", () => {
        expect(fileEtag(ORIGINAL)).not.toBe(fileEtag(VARIANT));
    });

    it("changes when the file is rewritten", () => {
        expect(fileEtag({ ...ORIGINAL, mtimeMs: ORIGINAL.mtimeMs + 1000 })).not.toBe(
            fileEtag(ORIGINAL)
        );
        expect(fileEtag({ ...ORIGINAL, sizeBytes: ORIGINAL.sizeBytes + 1 })).not.toBe(
            fileEtag(ORIGINAL)
        );
    });

    it("ignores sub-millisecond noise in mtime", () => {
        expect(fileEtag({ ...ORIGINAL, mtimeMs: 1_750_000_000_123.1 })).toBe(fileEtag(ORIGINAL));
    });
});

describe("isNotModified", () => {
    const etag = fileEtag(ORIGINAL);

    it("is false without the header", () => {
        expect(isNotModified(null, etag)).toBe(false);
    });

    it("matches the current tag, weakly, anywhere in a list", () => {
        expect(isNotModified(etag, etag)).toBe(true);
        expect(isNotModified(`W/${etag}`, etag)).toBe(true);
        expect(isNotModified(`"other", ${etag}`, etag)).toBe(true);
        expect(isNotModified("*", etag)).toBe(true);
    });

    it("does not match the other file behind the same URL", () => {
        expect(isNotModified(fileEtag(VARIANT), etag)).toBe(false);
    });
});

describe("rangeStillValid", () => {
    const etag = fileEtag(ORIGINAL);

    it("honours a range with no If-Range", () => {
        expect(rangeStillValid(null, etag, ORIGINAL.mtimeMs)).toBe(true);
    });

    it("honours a range only for the same file", () => {
        expect(rangeStillValid(etag, etag, ORIGINAL.mtimeMs)).toBe(true);
        expect(rangeStillValid(fileEtag(VARIANT), etag, ORIGINAL.mtimeMs)).toBe(false);
    });

    it("never honours a weak tag, which If-Range forbids", () => {
        expect(rangeStillValid(`W/${etag}`, etag, ORIGINAL.mtimeMs)).toBe(false);
    });

    it("accepts the exact Last-Modified date and nothing else", () => {
        expect(rangeStillValid(lastModified(ORIGINAL.mtimeMs), etag, ORIGINAL.mtimeMs)).toBe(true);
        expect(
            rangeStillValid(lastModified(ORIGINAL.mtimeMs - 60_000), etag, ORIGINAL.mtimeMs)
        ).toBe(false);
    });
});
