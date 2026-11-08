import { NextResponse } from "next/server";

import { roomSwitchSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { enabledRooms, switchRoom } from "@/lib/services/roomService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The rooms that are on (§21 "Turning a room off"). Anyone signed in may read it, from any room:
 * it decides which room a tab may open in, so it is asked before the tab is settled in one.
 */
export async function GET(request: Request) {
    try {
        await requireAuth(request, { anyDomain: true });

        return NextResponse.json(enabledRooms());
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Turn one room on or off. Administrators only; the last room on cannot be turned off. */
export async function PUT(request: Request) {
    try {
        const auth = await requireAuth(request, { anyDomain: true });
        const input = roomSwitchSchema.parse(await request.json());

        return NextResponse.json(switchRoom(input, auth.scopes));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
