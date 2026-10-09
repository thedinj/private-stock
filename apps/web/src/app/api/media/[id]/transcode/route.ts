import { NextResponse } from "next/server";

import { NotFoundError } from "@private-stock/core";
import { db, jobRepo, mediaRepo } from "@private-stock/db";

import { requireAuth, requireScope } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Progress of the rendition for one item (§8).
 *
 * A separate endpoint from the detail response because it changes every few seconds while the
 * detail does not, and polling the whole detail — which joins artifacts, variants and the
 * user's own row — to read one number would be wasteful at exactly the moment the box is
 * already busy encoding.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        // The access check is the same one the detail uses, and for the same reason: a user
        // must not be able to learn that an item exists by asking about its transcode.
        if (!mediaRepo.findDetail(id, auth.userId, auth.accessibleRootIds)) {
            throw new NotFoundError("Media not found");
        }

        // The most recent job wins: a retry after a failure should report as running, not as
        // the failure it superseded.
        const row = db
            .prepare(
                `SELECT "state", "progress", "lastError" FROM "Job"
                  WHERE "kind" = 'transcode' AND "mediaId" = ?
                  ORDER BY CASE "state"
                             WHEN 'claimed' THEN 0
                             WHEN 'pending' THEN 1
                             ELSE 2
                           END,
                           "createdAt" DESC
                  LIMIT 1`
            )
            .get(id) as
            { state: string; progress: number | null; lastError: string | null } | undefined;

        return NextResponse.json(
            row
                ? { state: row.state, progress: row.progress, lastError: row.lastError }
                : { state: "none", progress: null, lastError: null }
        );
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Stop the rendition for one item (§18.7).
 *
 * Admin rather than the `delete` scope, and not merely the access check the GET uses: an
 * abandoned transcode leaves the item unplayable in the browsers that needed the rendition,
 * for everybody, so it is a decision about the library rather than about one person's view
 * of it.
 *
 * Only the queue row is touched. The worker owns the partial file and removes it as its
 * ffmpeg child dies; unlinking it from here would race an encoder still writing to it, and
 * the path would have to be recomputed by a second copy of the logic that chose it.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        requireScope(auth, "admin");

        const { id } = await context.params;

        // Same check, same reason as the GET: an admin of this instance may still not have
        // been granted the library, and must not learn the item exists by cancelling it.
        if (!mediaRepo.findDetail(id, auth.userId, auth.accessibleRootIds)) {
            throw new NotFoundError("Media not found");
        }

        // Zero when there was nothing to stop — it had already finished, or never ran. Not an
        // error: the caller asked for this item not to be transcoding, and it is not.
        return NextResponse.json({ cancelled: jobRepo.cancelTranscode(id) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
