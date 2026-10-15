import { NextResponse } from "next/server";
import { z } from "zod";

import { homeLayoutSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { getHome, resetHomeLayout, saveHomeLayout } from "@/lib/services/homeService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Every shelf, already filled, in one request (§6).
 *
 * One call rather than one per row: a home page that assembles itself in four stages looks
 * broken on a slow link, and each shelf is a capped indexed query anyway.
 *
 * `seed` names the visit, so its refetches deal a shuffled shelf the same items (`dealt`).
 */
const homeQuerySchema = z.object({ seed: z.coerce.number().int().nonnegative().optional() });

export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        const { seed } = homeQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(getHome(auth, seed));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Replaces this account's layout. The whole arrangement, because reordering is the edit. */
export async function PUT(request: Request) {
    try {
        const auth = await requireAuth(request);
        const layout = homeLayoutSchema.parse(await request.json());

        saveHomeLayout(layout, auth);

        return NextResponse.json(getHome(auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Goes back to the layout an admin set.
 *
 * Deleting the row rather than copying the default in, so the account keeps tracking that
 * default as it changes instead of freezing on today's version of it.
 */
export async function DELETE(request: Request) {
    try {
        const auth = await requireAuth(request);

        resetHomeLayout(auth);

        return NextResponse.json(getHome(auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
