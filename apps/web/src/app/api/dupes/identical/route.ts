import { NextResponse } from "next/server";

import { identicalQuerySchema, identicalTrashRequestSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { listIdentical, trashIdentical } from "@/lib/services/dupeService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The identical groups, split by whether the rule decides them, with what trashing every
 * identical copy would do across the whole queue (§10e). Admin only, like the rest of the page.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const params = Object.fromEntries(new URL(request.url).searchParams);

        return NextResponse.json(listIdentical(identicalQuerySchema.parse(params), auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * One batch of trashing every identical copy (§10e): the page calls it until `cursor` comes
 * back null. Needs `admin` and `delete`, like resolving a page of groups by hand.
 */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        const body = identicalTrashRequestSchema.parse(await request.json());

        return NextResponse.json(await trashIdentical(body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
