import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { countQueue } from "@/lib/services/ocrMatchService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Items waiting for a performer or source decision, for the review nav. Admin only. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json(countQueue(auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
