import { NextResponse } from "next/server";

import { addReelItemsSchema, moveReelItemSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { addReelItems, listReelEntries, moveReelItem } from "@/lib/services/reelService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The whole reel, in order — never a page.
 *
 * A reel is played in one pass, so paging it would make the player ask a second question part
 * way through, which is the one moment it must not. `REEL_ITEM_LIMIT` bounds the answer, which
 * is what makes that promise affordable.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json(listReelEntries(id, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Appends spans. Refused outright if any belongs to somebody else (§14d's owner invariant). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = addReelItemsSchema.parse(await request.json());

        return NextResponse.json(addReelItems(id, body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Moves one entry. Named by `ReelItem.id`, because the same clip may sit at two positions. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = moveReelItemSchema.parse(await request.json());

        return NextResponse.json(moveReelItem(id, body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
