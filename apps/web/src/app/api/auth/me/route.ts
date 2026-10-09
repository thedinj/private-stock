import { NextResponse } from "next/server";

import { updateProfileSchema } from "@private-stock/core";

import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { requireAuth } from "@/lib/auth/withAuth";
import { updateOwnProfile } from "@/lib/services/userAdminService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json({
            id: auth.userId,
            email: auth.email,
            displayName: auth.displayName,
            scopes: auth.scopes,
        });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Edit your own account (§12c): your name, and your sign-in address if you are an
 * administrator. Header-authenticated, as every write here is.
 */
export async function PATCH(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = updateProfileSchema.parse(await request.json());

        return NextResponse.json(updateOwnProfile(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
