import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { getSetupToken, isPrivateRequest, needsSetup } from "@/lib/services/setupService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

export async function GET(request: Request) {
    try {
        const pending = needsSetup();
        const local = isPrivateRequest(request);

        // Generating it here is what puts it in the container log, where the setup page tells
        // people to look. The alternative -- generating it lazily on the first failed POST --
        // meant the token existed only after somebody had already been turned away without
        // being told what to type. Never returned in the response: the log is the one channel
        // that proves the reader can reach the server.
        if (pending && !local) {
            getSetupToken();
        }

        return NextResponse.json({
            needsSetup: pending,
            isLocalRequest: local,
        });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
