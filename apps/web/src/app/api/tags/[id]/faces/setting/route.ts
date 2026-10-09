import { NextResponse } from "next/server";

import { noSingleFaceSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { setNoSingleFace } from "@/lib/services/faceService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** "No single face", said of a performer or taken back (§5f). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const input = noSingleFaceSchema.parse(await request.json());

        return NextResponse.json(setNoSingleFace(id, input, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
