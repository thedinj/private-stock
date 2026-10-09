import { corsHeadersFor, requireMediaAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { openSized, toWebStream } from "@/lib/fileStream";
import { resolveArtifact } from "@/lib/services/artService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Serving generated imagery: covers, alternates, captures, previews, sprite sheets (§9).
 *
 * `<img>` cannot set an Authorization header, so this accepts the refresh cookie as well as
 * a Bearer token — the same concession the stream route makes for `<video>` — and a signed
 * media token in `?t=` (§12d), which is how a cast receiver fetches a poster.
 *
 * The grid keeps using the cookie rather than minting a token per tile. A token is part of
 * the cache key, so a fresh one per page load would give every tile a new URL and defeat the
 * year-long `immutable` cache below, which is the thing that stops a forty-tile grid
 * re-fetching its covers on every scroll.
 *
 * The route config above says "never cache this on the server", which is about Next's own
 * data cache: these bytes are per-user-authorised and must not be shared between requests by
 * the framework. The *browser* is told to cache aggressively, which is a different question
 * and the one that matters for a grid rendering forty tiles at once.
 */

export async function GET(
    request: Request,
    context: { params: Promise<{ id: string; name: string }> }
) {
    try {
        const { id, name } = await context.params;
        const { auth, via } = await requireMediaAuth(request, id);

        const version = new URL(request.url).searchParams.get("v");
        const artifact = await resolveArtifact(id, name, version, auth);

        return new Response(
            toWebStream(openSized(artifact.absolutePath, artifact.sizeBytes), request.signal),
            {
                status: 200,
                headers: {
                    ...corsHeadersFor(via),
                    "Content-Type": artifact.contentType,
                    "Content-Length": String(artifact.sizeBytes),
                    // `immutable` is honest only when the URL identifies these exact bytes. With
                    // a matching version token it does — a different cover is a different URL —
                    // so a year is safe and the grid stops re-requesting on every scroll. Without
                    // one (a hand-typed URL, or a token that has gone stale because the cover
                    // changed between the list response and this request) a short lifetime keeps
                    // it correct.
                    "Cache-Control": artifact.versioned
                        ? "private, max-age=31536000, immutable"
                        : "private, max-age=60, must-revalidate",
                },
            }
        );
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
