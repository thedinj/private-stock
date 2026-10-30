import { NextResponse } from "next/server";

import { setPinSchema } from "@private-stock/core";

import { checkPasswordChangeRate } from "@/lib/auth/sessionRateLimit";
import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { getPinStatus, setPin } from "@/lib/services/pinService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Whether your account has a screen-lock PIN (§12c). */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json(getPinStatus(auth.userId));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Set, change or remove your PIN. Header-authenticated, and the password is checked first.
 *
 * Metered with the password change, whose budget exists for the same reason: this verifies the
 * password with bcrypt at cost 12 before it refuses anything.
 */
export async function PUT(request: Request) {
    try {
        const auth = await requireAuth(request);

        checkPasswordChangeRate(auth.userId);

        const body = setPinSchema.parse(await request.json());

        return NextResponse.json(await setPin(auth.userId, body));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
