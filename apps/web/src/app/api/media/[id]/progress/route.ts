import { NextResponse } from "next/server";
import { z } from "zod";

import { db, isBusyError, userMediaRepo, withBusyTimeout } from "@private-stock/db";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

const progressSchema = z
    .object({
        /** Played to the end: counts a view. */
        finished: z.boolean().default(false),
        /**
         * The viewer has now watched enough of this to count (§14b).
         *
         * Only ever true. The rule is "thirty seconds of uninterrupted playback", which the
         * player is the only thing in a position to judge; `false` would mean "I have not seen
         * enough yet", which is not news and must never clear a mark somebody set by hand.
         */
        watched: z.literal(true).optional(),
    })
    // A ping that says neither is a position from a tab opened before resume points went; there
    // is nothing left to store it in.
    .refine((body) => body.finished || body.watched, "Nothing to record");

/**
 * A view that counted: the watched threshold reached, or the end (§14b). At most two per arrival
 * at an item, and a still sends one when its dwell runs out.
 *
 * There is no playback position any more. This used to carry one on every pause, every exit and
 * once a minute, which made it the write that took the site down (§20); nothing here is long
 * enough to resume across sittings, so the position stays in the page for the length of a visit
 * and the server hears only what it keeps.
 *
 * Contention is still answered rather than raised. `saved: false` is the honest report — nobody
 * is waiting on it — where a 503 would cost an unrelated page load its response time to deliver
 * news about a watched mark.
 */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = progressSchema.parse(await request.json());

        try {
            /**
             * A quarter of a second, and then give up — this is the one write in the app that
             * has earned it. Waiting here is not this request being slow, it is every request
             * in the process being stopped (§4), and what is being protected is a "last viewed"
             * time and a view count.
             *
             * One transaction, taken `immediate`. Unwrapped, a ping was two or three commits —
             * each repo call ensures the row exists first — and every commit is another turn
             * waiting for the lock and another chance to be the one that runs the WAL
             * checkpoint (§4). `immediate` takes the write lock at `BEGIN`, where the busy
             * timeout applies, rather than upgrading midway, where it may not.
             */
            withBusyTimeout(250, () => {
                db.transaction(() => {
                    userMediaRepo.recordView(auth.userId, id, body.finished);

                    if (body.watched) {
                        // Sets only when unset, so a rewatch cannot move the timestamp and a
                        // repeated announcement across a reload costs nothing.
                        userMediaRepo.markWatched(auth.userId, id);
                    }
                }).immediate();
            });
        } catch (error) {
            if (!isBusyError(error)) {
                throw error;
            }

            return NextResponse.json({ ok: true, saved: false });
        }

        return NextResponse.json({ ok: true, saved: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
