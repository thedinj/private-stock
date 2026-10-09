import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import {
    ValidationError,
    WEBSAFE_PROFILE,
    assessPlayback,
    transcodeEnabled,
    type TranscodeQueue,
    type TranscodeRequeueResult,
} from "@private-stock/core";
import { db, mediaRepo } from "@private-stock/db";

import { requireAuth, requireScope } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { clearProcessingCache } from "@/lib/services/pipelineService";
import { loadAdminSettings } from "@/lib/services/settingsService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The transcode queue (§8): how deep it is, and queuing what is still unplayable.
 *
 * The settings are not here. They are saved through the one settings contract (§12b), and this
 * route used to have a second `PUT` for the same key -- with no caller, and exactly the two-writer
 * shape §12b rules out.
 */

/** Queue depth, so the Transcoding tab can say what the box is actually doing. */
const readQueue = (): TranscodeQueue => {
    const rows = db
        .prepare(
            `SELECT "state", count(*) AS "n" FROM "Job" WHERE "kind" = 'transcode' GROUP BY "state"`
        )
        .all() as { state: string; n: number }[];

    const byState = Object.fromEntries(rows.map((row) => [row.state, row.n]));

    const running = db
        .prepare(
            `SELECT "mediaId", "progress" FROM "Job"
              WHERE "kind" = 'transcode' AND "state" = 'claimed'
              ORDER BY "startedAt" ASC`
        )
        .all() as { mediaId: string | null; progress: number | null }[];

    return {
        pending: byState.pending ?? 0,
        running: byState.claimed ?? 0,
        inFlight: running.map((row) => ({
            mediaId: row.mediaId,
            progress: row.progress ?? 0,
        })),
    };
};

export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        requireScope(auth, "admin");

        return NextResponse.json(readQueue());
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Re-queue everything that needs a rendition and has not got one.
 *
 * The worker's periodic backfill does this anyway; the button exists so that changing the
 * hardware acceleration setting can be tried immediately rather than at the next sweep.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        requireScope(auth, "admin");

        if (!transcodeEnabled(loadAdminSettings().stagePolicy)) {
            // The worker would drop each job at claim; saying so is better than a count.
            throw new ValidationError("Transcoding is switched off");
        }

        const candidates = mediaRepo.listTranscodeCandidates(WEBSAFE_PROFILE);

        /**
         * Only the ones a browser genuinely cannot play.
         *
         * The filter is the point of this endpoint. Queuing every probed video without a
         * variant would transcode the whole library - most of which already plays perfectly
         * well - and on a NAS that is days of CPU to produce worse copies of good files.
         */
        // KNOWN ISSUE: only the first 500 candidates, unordered -- see `listTranscodeCandidates`.
        const needy = candidates.filter((row) => !assessPlayback(row).directPlay);

        const insert = db.prepare(
            `INSERT INTO "Job"
                 ("id", "kind", "mediaId", "fileId", "priority", "mediaAddedAt", "updatedAt")
             -- The library's ordering key (§7d). This queues the whole unplayable backlog at
             -- once, so which end it starts from is the difference between the items someone
             -- is looking at becoming playable today and doing so last.
             VALUES (?, 'transcode', ?, ?, 200,
                     (SELECT "addedAt" FROM "Media" WHERE "id" = ?), CURRENT_TIMESTAMP)
             ON CONFLICT DO NOTHING`
        );

        // The partial unique index on live jobs makes this idempotent, so pressing the button
        // twice does not queue anything twice.
        const queued = db.transaction(() => {
            let count = 0;

            for (const row of needy) {
                count += insert.run(randomUUID(), row.id, row.fileId, row.id).changes;
            }

            return count;
        })();

        const result: TranscodeRequeueResult = { queued, examined: candidates.length };

        clearProcessingCache();

        return NextResponse.json(result);
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
