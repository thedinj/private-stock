import { NextResponse } from "next/server";
import { z } from "zod";

import { userPrefRepo } from "@private-stock/db";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Small per-user UI preferences (§6).
 *
 * No service layer, because there is no business logic and no authorization question beyond
 * "these are yours": the repo is scoped by `userId` and there is nothing else to decide. A
 * service here would be a file that forwarded two calls.
 *
 * The keys are deliberately not enumerated. These are the app's least consequential state —
 * gallery density, autoplay — and a vocabulary would have to be maintained in lockstep with
 * a UI that is allowed to change its mind. The limits below are what actually matters: a
 * preference cannot become a place to store data.
 */
const patchSchema = z
    .record(
        z.string().trim().min(1).max(100),
        // Null clears the key, so a preference returns to its default rather than being
        // pinned to whatever the default was on the day it was cleared.
        z.string().max(2000).nullable()
    )
    .refine((value) => Object.keys(value).length <= 100, { message: "Too many preferences" });

export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);

        return NextResponse.json({ prefs: userPrefRepo.all(auth.userId) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

export async function PATCH(request: Request) {
    try {
        const auth = await requireAuth(request);
        const patch = patchSchema.parse(await request.json());

        userPrefRepo.setMany(auth.userId, patch);

        return NextResponse.json({ prefs: userPrefRepo.all(auth.userId) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
