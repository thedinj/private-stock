import { createReadStream } from "node:fs";

import { corsHeadersFor, requireMediaAuth, type MediaAuthVia } from "@/lib/auth/withAuth";
import { parseRange, STREAM_CHUNK_BYTES } from "@/lib/byteRange";
import { contentTypeFor, PLAYLIST_TYPE } from "@/lib/contentTypes";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { toWebStream } from "@/lib/fileStream";
import { fileEtag, isNotModified, lastModified, rangeStillValid } from "@/lib/httpValidators";
import { resolveMediaFile, type ResolvedFile } from "@/lib/services/mediaService";
import { segmentPlaylist } from "@/lib/services/segmentService";
import { traceStream } from "@/lib/streamTrace";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Byte-range streaming of original files — the direct-play path (§8).
 *
 * This is the endpoint that made a separate HTTP framework unnecessary: range handling over
 * `fs.createReadStream`, rather than Fastify and a second routing model.
 *
 * It was documented here as costing no CPU, and that was wrong in the way that mattered. The
 * *work* is cheap; the *pumping* is not, and it happens on the one thread that also serves
 * every page. Answering `bytes=0-` literally meant a single 206 carrying a whole 565 MB file
 * through that thread in 64 KB chunks, which on the NAS measured as multi-second response
 * times on unrelated endpoints and looked, from a browser, exactly like the app had hung
 * (§20). Two things keep it honest now, both in `lib/byteRange.ts`: an open-ended range is
 * bounded to a window, and what is left is read in megabyte chunks rather than 64 KB ones.
 *
 * `<video>` cannot set an Authorization header, so this accepts the refresh cookie as well
 * as a Bearer token — and a signed media token in `?t=`, which is the only one of the three a
 * device that is not this browser can carry (§12d).
 *
 * Every answer carries an `ETag` and `Last-Modified`, and the route honours `If-None-Match` and
 * `If-Range`. One URL serves more than one file over an item's life — see `httpValidators.ts`
 * — and the validators are what let a browser notice, rather than splice ranges of two files
 * together or re-download a whole one once its cached copy expires.
 *
 * **For an MPEG-TS file it answers with a playlist instead** (§8, "Playing an MPEG-TS file without
 * copying it"): HLS whose segments are byte ranges of the original, at `?raw=1` on this same
 * route. This address is "what this browser should play", which was already more than one file
 * -- the original or a rendition -- and the player keeps not knowing which. `?raw=1` is the
 * stored file's bytes whatever else exists, which is also what a player outside the browser wants.
 */

/**
 * The playlist for a file that plays as segments, or null to serve its bytes.
 *
 * Its segments are this route again with `raw=1`, relative so they resolve against wherever the
 * playlist was fetched from; a signed token rides along, since a device holding one has nothing
 * else to authenticate the segments with (§12d).
 */
const playlistFor = (
    request: Request,
    mediaId: string,
    file: ResolvedFile,
    via: MediaAuthVia
): Response | null => {
    if (!file.segments) {
        return null;
    }

    const token = via === "token" ? new URL(request.url).searchParams.get("t") : null;
    const playlist = segmentPlaylist(
        mediaId,
        file,
        token ? `stream?raw=1&t=${encodeURIComponent(token)}` : "stream?raw=1"
    );

    return playlist === null
        ? null
        : new Response(request.method === "HEAD" ? null : playlist, {
              status: 200,
              headers: {
                  ...corsHeadersFor(via),
                  "Content-Type": PLAYLIST_TYPE,
                  // Small, and rebuilt if the index is: revalidated rather than kept.
                  "Cache-Control": "private, no-cache",
              },
          });
};

/** The headers a 200, a 206, a 304 and a HEAD all share. */
const headersFor = (
    file: ResolvedFile,
    etag: string,
    via: MediaAuthVia
): Record<string, string> => ({
    ...corsHeadersFor(via),
    "Content-Type": contentTypeFor(file.relPath),
    // Without this a browser never issues a Range request, so seeking a two-hour video means
    // downloading it from the start.
    "Accept-Ranges": "bytes",
    // Private keeps it out of any shared proxy cache: the URL is behind auth. An hour, not
    // longer, because the file behind the URL can change; after that the browser revalidates
    // and gets a 304 rather than the file again.
    "Cache-Control": "private, max-age=3600",
    ETag: etag,
    "Last-Modified": lastModified(file.mtimeMs),
});

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    const receivedAt = performance.now();

    try {
        const { id } = await context.params;
        const { auth, via } = await requireMediaAuth(request, id);

        const file = resolveMediaFile(id, auth, {
            requireCastReady: via === "token",
            original: new URL(request.url).searchParams.get("raw") === "1",
        });
        const playlist = playlistFor(request, id, file, via);

        if (playlist) {
            return playlist;
        }

        const etag = fileEtag(file);
        const baseHeaders = headersFor(file, etag, via);
        const traceFor = (range: { start: number; end: number } | null) =>
            traceStream({
                mediaId: id,
                range,
                sizeBytes: file.sizeBytes,
                isVariant: file.isVariant,
                receivedAt,
                disclose: auth.scopes.includes("admin"),
            });

        // Before the range: a 304 answers a ranged request too — the browser is revalidating
        // ranges it already holds.
        if (isNotModified(request.headers.get("if-none-match"), etag)) {
            return new Response(null, { status: 304, headers: baseHeaders });
        }

        // A range of a file that has changed since the browser cached the rest of it is
        // answered as if no range were asked for: the whole current file, as a 200.
        const range = rangeStillValid(request.headers.get("if-range"), etag, file.mtimeMs)
            ? parseRange(request.headers.get("range"), file.sizeBytes)
            : null;

        if (range === "unsatisfiable") {
            return new Response(null, {
                status: 416,
                headers: { ...baseHeaders, "Content-Range": `bytes */${file.sizeBytes}` },
            });
        }

        if (!range) {
            const trace = traceFor(null);

            return new Response(
                toWebStream(
                    createReadStream(file.absolutePath, { highWaterMark: STREAM_CHUNK_BYTES }),
                    request.signal,
                    trace.settled
                ),
                {
                    status: 200,
                    headers: {
                        ...baseHeaders,
                        ...trace.headers,
                        "Content-Length": String(file.sizeBytes),
                    },
                }
            );
        }

        const stream = createReadStream(file.absolutePath, {
            start: range.start,
            end: range.end,
            highWaterMark: STREAM_CHUNK_BYTES,
        });

        const trace = traceFor(range);

        return new Response(toWebStream(stream, request.signal, trace.settled), {
            status: 206,
            headers: {
                ...baseHeaders,
                ...trace.headers,
                "Content-Range": `bytes ${range.start}-${range.end}/${file.sizeBytes}`,
                "Content-Length": String(range.end - range.start + 1),
            },
        });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Players issue HEAD to learn the size and whether ranges are supported before requesting
 * any bytes. Answering it avoids a wasted full GET on first open.
 */
export async function HEAD(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await context.params;
        const { auth, via } = await requireMediaAuth(request, id);
        const file = resolveMediaFile(id, auth, {
            requireCastReady: via === "token",
            original: new URL(request.url).searchParams.get("raw") === "1",
        });
        const playlist = playlistFor(request, id, file, via);

        if (playlist) {
            return playlist;
        }

        const etag = fileEtag(file);
        const headers = headersFor(file, etag, via);

        if (isNotModified(request.headers.get("if-none-match"), etag)) {
            return new Response(null, { status: 304, headers });
        }

        return new Response(null, {
            status: 200,
            headers: { ...headers, "Content-Length": String(file.sizeBytes) },
        });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * The preflight a cross-origin receiver sends before its first ranged GET.
 *
 * Answered without authenticating: a preflight carries no credential by definition, and
 * refusing it would stop the real request from ever being made. It reveals nothing — the
 * answer is the same for an id that exists and one that does not.
 */
export async function OPTIONS() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Range",
            "Access-Control-Max-Age": "86400",
        },
    });
}
