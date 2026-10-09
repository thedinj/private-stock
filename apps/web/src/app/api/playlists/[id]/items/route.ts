import { NextResponse } from "next/server";
import { z } from "zod";

import { addPlaylistItemsSchema, movePlaylistItemSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import {
    addPlaylistItems,
    listPlaylistItems,
    movePlaylistItem,
} from "@/lib/services/playlistService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * `seed` selects a shuffle of the playlist rather than its stored order (§14b).
 *
 * Absent means the stored order. It is a parameter rather than a mode because the seed *is*
 * the order — two different seeds are two different shuffles, and the client holds it in the
 * URL so that turning a page does not reshuffle.
 */
const pageSchema = z.object({
    page: z.coerce.number().int().min(0).default(0),
    seed: z.coerce.number().int().optional(),
});

/** One page of the playlist, in playlist order or in a shuffle of it. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const { page, seed } = pageSchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(listPlaylistItems(id, page, auth, seed ?? null));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Appends items. Already-present and invisible ids are skipped, not refused. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = addPlaylistItemsSchema.parse(await request.json());

        return NextResponse.json(addPlaylistItems(id, body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Moves one item to a new index.
 *
 * One item and a destination rather than the whole sequence, so a client holding a stale
 * copy of a long playlist cannot drop the members it has not loaded.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = movePlaylistItemSchema.parse(await request.json());

        movePlaylistItem(id, body, auth);

        return NextResponse.json({ ok: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
