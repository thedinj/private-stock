import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth, requireScope } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { checkLibraryPath, isMountWritable } from "@/lib/services/libraryService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

const inspectSchema = z.object({
    path: z.string().trim().max(1024),
    /** The library being moved, so it does not collide with where it already is. */
    excludeId: z.string().optional(),
});

/**
 * Whether a path could be a library, and why not if it could not.
 *
 * Called as someone types. It answers with the *same* check the write performs, which is the
 * point: a form that approves a path the server then rejects is worse than no live check at
 * all, because it teaches people to trust it.
 *
 * A POST rather than a GET despite reading nothing: the path goes in a body instead of a URL,
 * and filesystem paths have no business in request logs or browser history.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        requireScope(auth, "admin");

        const body = inspectSchema.parse(await request.json());

        if (body.path.length === 0) {
            return NextResponse.json({ ok: false, reason: null });
        }

        const checked = await checkLibraryPath(body.path, body.excludeId);

        if (!checked.ok) {
            return NextResponse.json({ ok: false, reason: checked.reason });
        }

        // So the dialog can say whether "Deletable" is on offer before anybody asks for it.
        return NextResponse.json({
            ok: true,
            path: checked.path,
            mountWritable: await isMountWritable(checked.path),
        });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
