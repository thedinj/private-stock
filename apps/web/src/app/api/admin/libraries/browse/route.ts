import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth, requireScope } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { browseDirectories } from "@/lib/services/libraryService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

const querySchema = z.object({
    /** Omitted at the top, where the answer is the starting points rather than a listing. */
    path: z.string().trim().max(1024).optional(),
});

/**
 * Lists the directories inside a path, so an admin can pick one instead of typing it exactly.
 *
 * **Admin only, and directories only — never file names.** An administrator can already type
 * any path and learn from the resulting error whether it exists, so this grants no reach they
 * did not have; listing files would, and nothing here needs it.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        requireScope(auth, "admin");

        const { path } = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));

        return NextResponse.json(await browseDirectories(path));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
