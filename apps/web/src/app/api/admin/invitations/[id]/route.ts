import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { deleteInvitation, revokeInvitation } from "@/lib/services/invitationService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Withdraw an invitation, keeping the row (§12c).
 *
 * PATCH rather than DELETE because the row survives: revoking stamps a time, so "when did
 * this stop working" keeps an answer and the accounts that joined through it keep their
 * provenance.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json({ invitation: revokeInvitation(id, auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Remove an invitation nobody used.
 *
 * Refused with a Conflict once anybody has joined through it, which the UI pre-empts by
 * offering Withdraw instead — a control that cannot work is absent rather than disabled.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        deleteInvitation(id, auth);

        return NextResponse.json({ ok: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
