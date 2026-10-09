import { NextResponse } from "next/server";

import { updateUserSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { deleteUser, updateUser } from "@/lib/services/userAdminService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Change what an account may do, or whether it may do anything (§12c).
 *
 * Scopes and `disabled` travel together because the service has to judge the whole intended
 * end state at once — two requests would each pass a "last administrator" check and still
 * arrive somewhere neither was allowed to reach.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = updateUserSchema.parse(await request.json());

        return NextResponse.json({ user: updateUser(id, body, auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Remove an account and everything that was only ever theirs. Irreversible. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        deleteUser(id, auth);

        return NextResponse.json({ ok: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
