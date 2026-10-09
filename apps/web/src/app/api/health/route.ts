import { NextResponse } from "next/server";

import { db } from "@private-stock/db";

// Declared literally, never re-exported — Next reads these by static analysis and silently
// ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Liveness and readiness in one endpoint, used by Docker's HEALTHCHECK.
 *
 * It deliberately touches the database rather than just returning 200: a container whose
 * data volume failed to mount would otherwise report healthy while being useless, and
 * Container Station would never restart it.
 */
export async function GET() {
    const checks: Record<string, string> = {};
    let healthy = true;

    try {
        const row = db.prepare(`SELECT count(*) AS count FROM "_migrations"`).get() as {
            count: number;
        };
        checks.database = "ok";
        checks.migrations = String(row.count);
    } catch (error) {
        healthy = false;
        checks.database = `error: ${(error as Error).message}`;
    }

    return NextResponse.json(
        {
            status: healthy ? "ok" : "degraded",
            version: process.env.npm_package_version ?? "0.0.1",
            checks,
        },
        { status: healthy ? 200 : 503 }
    );
}
