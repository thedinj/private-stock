import { NextResponse } from "next/server";

import { bulkClipUntagSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { bulkUntagClips } from "@/lib/services/clipService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Takes tags, by id, off a selection of your clips (§14d "Tagging clips"). */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = bulkClipUntagSchema.parse(await request.json());

        return NextResponse.json(bulkUntagClips(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
