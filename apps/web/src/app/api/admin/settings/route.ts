import { NextResponse } from "next/server";

import { adminSettingsPatchSchema, stageSettings, type AdminSettings } from "@private-stock/core";
import { stageRepo } from "@private-stock/db";

import { requireAuth, requireScope } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { loadAdminSettings, saveAdminSettings } from "@/lib/services/settingsService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The stage rows, with the outstanding count for anything switched off (§7b).
 *
 * `stageSettings` decides *which* stages are worth counting -- it is the one that knows a
 * running stage has no decision left to make -- and this supplies the number. Counting is a
 * scan of the matching set (§20), so handing it the repo rather than a precomputed map is
 * what keeps it to the one or two rows where somebody is actually being asked something.
 */
const stagesFor = (settings: AdminSettings) =>
    stageSettings(settings.stagePolicy, stageRepo.countMediaNeedingStage);

/**
 * Everything an admin can change, in one response (§12b).
 *
 * The stage list is derived from the registry rather than stored, so a capability added in
 * code appears here without a migration and without a second list to remember to update.
 */
export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        requireScope(auth, "admin");

        const settings = loadAdminSettings();

        return NextResponse.json({ settings, stages: stagesFor(settings) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Applies one card's worth of changes; anything absent is left alone. */
export async function PUT(request: Request) {
    try {
        const auth = await requireAuth(request);
        const patch = adminSettingsPatchSchema.parse(await request.json());
        const settings = saveAdminSettings(patch, auth.scopes);

        return NextResponse.json({ settings, stages: stagesFor(settings) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
