import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listLabels } from "@/lib/services/clipService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Labels this person has used before, for the name field's suggestions.
 *
 * A label is a clip's title, so typing "be" offers "beach" and names stay consistent by reuse.
 * Searchable facets are tags (§14d "Tagging clips"); this is only the name.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json({ labels: listLabels(auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
