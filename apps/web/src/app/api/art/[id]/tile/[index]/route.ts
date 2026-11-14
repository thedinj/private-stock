import { z } from "zod";

import { tileCropSchema } from "@private-stock/core";

import { corsHeadersFor, requireMediaAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { tileImage } from "@/lib/services/spriteTileService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * One sprite tile on its own, cut to a shape: a look's matching moment (§5e).
 *
 * `/api/art/:id/tile/:index?crop=square&v=…`, where the index counts tiles across the item's
 * sheets and `v` is the sheet's version. Authorised as the art route is -- cookie, Bearer or a
 * signed media token -- because an `<img>` asks for it.
 */

const paramsSchema = z.object({
    index: z.coerce.number().int().min(0).max(100_000),
    crop: tileCropSchema,
});

export async function GET(
    request: Request,
    context: { params: Promise<{ id: string; index: string }> }
) {
    try {
        const { id, index: rawIndex } = await context.params;
        const { auth, via } = await requireMediaAuth(request, id);
        const searchParams = new URL(request.url).searchParams;
        const { index, crop } = paramsSchema.parse({
            index: rawIndex,
            crop: searchParams.get("crop"),
        });

        const tile = await tileImage(id, index, crop, searchParams.get("v"), auth);

        return new Response(new Uint8Array(tile.bytes), {
            status: 200,
            headers: {
                ...corsHeadersFor(via),
                "Content-Type": "image/webp",
                "Content-Length": String(tile.bytes.byteLength),
                // The browser is the only cache (`spriteTileService`), so it keeps a versioned
                // tile for good, as the art route keeps a versioned sheet.
                "Cache-Control": tile.versioned
                    ? "private, max-age=31536000, immutable"
                    : "private, max-age=60, must-revalidate",
            },
        });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
