import { NextResponse } from "next/server";

import { trashMediaRequestSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { trashWithCopies } from "@/lib/services/dupeService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Moves an item to the recycle bin (§10).
 *
 * Needs the `delete` scope and a root flagged writable. The item leaves the library
 * immediately; its bytes follow in a job, and both are recoverable until the retention window
 * closes.
 *
 * The body may name copies of the item to trash with it (§10d). It is optional -- a bare
 * DELETE is the single deletion it always was -- hence the empty object when there is none.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = trashMediaRequestSchema.parse(await request.json().catch(() => ({})));

        return NextResponse.json(await trashWithCopies(id, body.alsoTrash, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
