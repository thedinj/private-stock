import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { SETTING_KEYS } from "@private-stock/core";
import { db, mediaFileRepo, mediaRootRepo, scanRepo, settingRepo } from "@private-stock/db";

import { requireAuth, requireScope } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { availability, listCandidates, requireLibraryInRoom } from "@/lib/services/libraryService";
import { clearProcessingCache } from "@/lib/services/pipelineService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Scan settings are written through `/api/admin/settings`, not here.
 *
 * They are still read here because this endpoint is what the admin page loads for status, and
 * a second write path for the same two keys is how two screens end up disagreeing about which
 * value won.
 */
const readSettings = () => ({
    intervalMinutes: settingRepo.get(SETTING_KEYS.scanInterval, 60 * 24),
    watch: settingRepo.get(SETTING_KEYS.scanWatch, true),
});

export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request);
        requireScope(auth, "admin");

        const reachable = await availability();

        return NextResponse.json({
            settings: readSettings(),
            // This room's libraries only (§21). The others are managed from inside them, so
            // the admin page in one room never lists another room's paths.
            roots: mediaRootRepo
                .listRoots()
                .filter((root) => root.domain === auth.domain)
                .map((root) => ({
                    id: root.id,
                    label: root.label,
                    path: root.path,
                    networkPath: root.networkPath,
                    available: reachable.get(root.id) ?? false,
                    enabled: root.enabled === 1,
                    writable: root.writable === 1,
                    lastScanAt: root.lastScanAt,
                    fileCount: mediaFileRepo.countByRoot(root.id),
                    verifying: mediaFileRepo.countUnverifiedByRoot(root.id),
                })),
            candidates: await listCandidates(),
            scanning: auth.domain
                ? scanRepo.isRunningInDomain(auth.domain)
                : scanRepo.isAnyRunning(),
        });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

const triggerSchema = z.object({
    rootId: z.string().optional(),
    /** Re-examine unchanged files too, rather than taking the cheap skip path. */
    force: z.boolean().default(false),
});

/** "Scan now" — enqueues a job the worker picks up within seconds. */
export async function POST(request: Request) {
    try {
        const auth = await requireAuth(request);
        requireScope(auth, "admin");

        const body = triggerSchema.parse(await request.json().catch(() => ({})));

        // One library: this room's (§21). Without one, every library is walked -- a scan reads
        // the disk and shows nothing, so "scan now" stays one button for the house.
        if (body.rootId) requireLibraryInRoom(body.rootId, auth);

        const payload =
            body.rootId || body.force
                ? JSON.stringify({ rootId: body.rootId, force: body.force || undefined })
                : null;

        db.prepare(
            `INSERT INTO "Job" ("id", "kind", "payloadJson", "priority", "updatedAt")
             VALUES (?, 'scan', ?, 5, CURRENT_TIMESTAMP)
             ON CONFLICT DO NOTHING`
        ).run(randomUUID(), payload);

        clearProcessingCache();

        return NextResponse.json({ ok: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
