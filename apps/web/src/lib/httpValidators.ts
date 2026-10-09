/**
 * Validators and conditional requests for the direct-play route (§8).
 *
 * The stream URL is *not* a name for fixed bytes, whatever its comment used to say. The same
 * `/api/media/:id/stream` serves the original, then the web-safe variant once it is ready, then
 * the original again if the retention sweep clears the variant — and an original overwritten in
 * place keeps its row and its id. With a cache lifetime and no validator, a browser holding
 * ranges of one file had no way to notice it was being handed ranges of another, and no way
 * to revalidate once the lifetime ran out except by downloading everything again.
 *
 * Pure logic, under test, for the same reason as `byteRange.ts`: a wrong answer here is a
 * video that plays garbage rather than one that fails.
 */

export interface FileIdentity {
    sizeBytes: number;
    mtimeMs: number;
    isVariant: boolean;
}

/**
 * A strong entity tag for one file as served.
 *
 * Size and mtime are what the scanner already treats as identity (§7). `isVariant` is in it
 * because the two files behind one URL are unrelated, and it costs nothing to make sure that a
 * coincidence of size and mtime cannot make them look alike.
 */
export const fileEtag = ({ sizeBytes, mtimeMs, isVariant }: FileIdentity): string =>
    `"${isVariant ? "v" : "o"}-${sizeBytes.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`;

/** `Last-Modified`, which HTTP dates to the second. */
export const lastModified = (mtimeMs: number): string => new Date(mtimeMs).toUTCString();

const opaqueTag = (tag: string): string => tag.trim().replace(/^W\//, "");

/**
 * Whether `If-None-Match` names the current tag, and the answer should be a 304.
 *
 * Weak comparison, as RFC 9110 §13.1.2 requires for this header. Evaluated before `Range`,
 * because a 304 answers a ranged request too: the browser is revalidating ranges it already
 * holds and wants to keep.
 */
export const isNotModified = (ifNoneMatch: string | null, etag: string): boolean => {
    if (!ifNoneMatch) {
        return false;
    }

    if (ifNoneMatch.trim() === "*") {
        return true;
    }

    const current = opaqueTag(etag);

    return ifNoneMatch.split(",").some((candidate) => opaqueTag(candidate) === current);
};

/**
 * Whether a `Range` may be honoured under `If-Range` (RFC 9110 §13.1.5).
 *
 * This is the header that stops a browser splicing a cached prefix of one file onto the rest of
 * another: it asks for the range only if the file is still the one it cached, and a no is
 * answered with the whole current file instead. A tag compares strongly, so a weak one never
 * matches; a date must equal `Last-Modified` exactly.
 */
export const rangeStillValid = (ifRange: string | null, etag: string, mtimeMs: number): boolean => {
    if (!ifRange) {
        return true;
    }

    const value = ifRange.trim();

    if (value.startsWith('"') || value.startsWith("W/")) {
        return value === etag;
    }

    return value === lastModified(mtimeMs);
};
