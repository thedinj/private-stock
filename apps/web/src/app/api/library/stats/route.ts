import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { libraryStats } from "@/lib/services/libraryService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Whether a scan is running, and the root counts (§20).
 *
 * The shell polls this, so it holds only what is cheap and the same for everyone. The item
 * counts it used to carry are `/api/library/roots`, which is cached per viewer and re-read when
 * the change feed says items came or went.
 */
export async function GET(request: Request) {
    try {
        // Signed in to ask, though the answer is not the viewer's: root counts are what an empty
        // grid uses to explain itself, and they say nothing about what is in any library.
        await requireAuth(request);

        return NextResponse.json(libraryStats());
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
