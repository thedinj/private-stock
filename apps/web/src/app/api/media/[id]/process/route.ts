import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listProcessing, requestProcessing } from "@/lib/services/processingService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

const requestSchema = z.object({
    /**
     * The stage to run, by name.
     *
     * An open string rather than an enum: the whole point of the registry is that adding a
     * capability is one entry there, and a closed list here would make it two places — with
     * the second one easy to forget and silently reject a stage that exists.
     */
    stage: z.string().trim().min(1).max(40),
});

/** What has been done to this item, and how each attempt went (§7b). */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json({ stages: listProcessing(id, auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Runs a stage for this item now, whatever happened last time.
 *
 * The on-demand half of the pipeline. A stage can be runnable per item long before — or
 * without ever — being swept across the whole library, which is what makes an expensive
 * capability practical to offer at all.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = requestSchema.parse(await request.json());

        requestProcessing(id, body.stage, auth);

        return NextResponse.json({ queued: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
