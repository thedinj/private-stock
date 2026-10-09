import { NextResponse } from "next/server";

import { createInvitationSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { createInvitation, listInvitations } from "@/lib/services/invitationService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Invitations (§12c).
 *
 * The `admin` check is in the service rather than here, unlike the older admin routes that
 * call `requireScope` themselves. Both work; the service is the better place, because it is
 * also where the rule lives that an invitation cannot grant more than its maker holds — and
 * splitting one decision across two layers is how the half in the route gets forgotten.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json({ invitations: listInvitations(auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = createInvitationSchema.parse(await request.json());

        return NextResponse.json({ invitation: createInvitation(body, auth) }, { status: 201 });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
