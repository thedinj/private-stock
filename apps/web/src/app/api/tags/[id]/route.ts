import { NextResponse } from "next/server";

import { tagProfileQuerySchema, updateTagSchema } from "@private-stock/core";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { deleteTag, getTagProfile, updateTag } from "@/lib/services/tagService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * One tag's page: its counts, a picture and three shelves (§6 "Tags"). Who else appears is
 * `companions/`, asked for separately so the page does not wait on it.
 *
 * `seed` is the client's, so the picture and the shuffled shelf match the filmstrip the tag
 * was opened from. A private tag is readable by its owner only, and is a 404 to anybody else.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const { seed } = tagProfileQuerySchema.parse(
            Object.fromEntries(new URL(request.url).searchParams)
        );

        return NextResponse.json(getTagProfile(id, seed, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/** Rename or restyle a tag. Admin-only — a rename changes what every item carrying it says. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = updateTagSchema.parse(await request.json());

        return NextResponse.json(updateTag(id, body, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Removes a tag and every assignment of it.
 *
 * Deliberately not behind the `delete` scope, which exists for deleting *files* (§18.1).
 * This deletes vocabulary; the media it described is untouched.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;

        // The count the screen reports, for the reason the merge route returns its own.
        return NextResponse.json(deleteTag(id, auth));
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
