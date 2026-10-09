import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { readStill } from "@/lib/services/tagPictureService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * One moment of an item, read from the original, for framing a tag's picture (§6 "A tag's
 * picture"). `?at=` in milliseconds for a video; nothing for a photograph.
 *
 * Drawn by `<img>`, so the refresh cookie is accepted. Kept briefly by the browser and nowhere
 * else: it is a preview, and the picture itself is cut from the original again when it is chosen.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request, { allowCookie: true });
        const { id } = await context.params;
        const at = new URL(request.url).searchParams.get("at");
        const atMs = at === null ? null : Math.max(0, Math.floor(Number(at)));

        if (atMs !== null && !Number.isFinite(atMs)) {
            return Response.json({ error: "?at= is milliseconds" }, { status: 400 });
        }

        const bytes = await readStill(id, atMs, auth);

        return new Response(new Uint8Array(bytes), {
            status: 200,
            headers: {
                "Content-Type": "image/webp",
                "Content-Length": String(bytes.length),
                "Cache-Control": "private, max-age=600",
            },
        });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
