import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listUsers } from "@/lib/services/userAdminService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Every account (§12c). Admin only, and the service says so. */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json({ users: listUsers(auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
