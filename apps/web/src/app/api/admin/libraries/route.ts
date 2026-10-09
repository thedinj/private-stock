import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth, requireScope } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { addLibrary } from "@/lib/services/libraryService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

const addSchema = z.object({
    path: z.string().trim().min(1).max(1024),
    label: z.string().trim().min(1).max(100).optional(),
    /** Allow deletion from the start. Refused unless the directory is mounted writable. */
    writable: z.boolean().optional(),
});

/**
 * Adds a library (§12b).
 *
 * The path is checked before anything is stored, so a directory that does not exist or cannot
 * be read is refused here rather than becoming a library that quietly never finds anything.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        requireScope(auth, "admin");

        const body = addSchema.parse(await request.json());

        return NextResponse.json({ root: await addLibrary(body.path, body.label, body.writable) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
