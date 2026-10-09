import { NextResponse } from "next/server";

import { isTagPictureSize, setTagPictureSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { openSized, toWebStream } from "@/lib/fileStream";
import {
    clearTagPicture,
    resolveTagPicture,
    setTagPicture,
} from "@/lib/services/tagPictureService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * A tag's picture (§6 "A tag's picture"): its bytes, choosing it, and taking the choice back.
 *
 * GET is drawn by `<img>`, which cannot set a header, so it accepts the refresh cookie as the art
 * route does; the writes do not. `?size=small` is the rendering drawn at 72–88 pixels. A URL with
 * the picture's `?v=` is cached for a year: a new picture is a new URL.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request, { allowCookie: true });
        const { id } = await context.params;
        const params = new URL(request.url).searchParams;
        const size = params.get("size") ?? "large";

        if (!isTagPictureSize(size)) {
            return NextResponse.json({ error: "Unknown size" }, { status: 400 });
        }

        const picture = await resolveTagPicture(id, size, params.get("v"), auth);

        return new Response(
            toWebStream(openSized(picture.absolutePath, picture.sizeBytes), request.signal),
            {
                status: 200,
                headers: {
                    "Content-Type": "image/webp",
                    "Content-Length": String(picture.sizeBytes),
                    "Cache-Control": picture.versioned
                        ? "private, max-age=31536000, immutable"
                        : "private, max-age=60, must-revalidate",
                },
            }
        );
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Choose the picture: a moment of an item and the part of it to keep. */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = setTagPictureSchema.parse(await request.json());

        return NextResponse.json({ picture: await setTagPicture(id, body, auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Take the choice back; answers with the picture shown instead, if any. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        return NextResponse.json({ picture: await clearTagPicture(id, auth) });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
