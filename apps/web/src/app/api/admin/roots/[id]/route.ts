import { NextResponse } from "next/server";
import { z } from "zod";

import { networkPathSchema } from "@private-stock/core";
import { mediaRootRepo } from "@private-stock/db";

import { forgetAuth } from "@/lib/auth/authCache";
import { requireAuth, requireScope } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import {
    clearLibraryCaches,
    removeLibrary,
    repointLibrary,
    requireLibraryInRoom,
    setLibraryWritable,
} from "@/lib/services/libraryService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

const updateSchema = z.object({
    enabled: z.boolean().optional(),
    writable: z.boolean().optional(),
    label: z.string().trim().min(1).max(100).optional(),
    /**
     * Where the library now lives.
     *
     * Moving content is a repoint: file paths are stored relative to their library, so the
     * catalogue — tags, ratings, duplicate groups, processing history — survives the move
     * intact.
     */
    path: z.string().trim().min(1).max(1024).optional(),
    /**
     * Where the PC running Resolve finds this folder (§14d "Editor export"). Empty clears it.
     * Checked for shape only: the server cannot reach a Windows share, and never needs to.
     */
    networkPath: z
        .string()
        .trim()
        .transform((value) => value || null)
        .pipe(networkPathSchema.nullable())
        .nullish(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        requireScope(auth, "admin");

        const { id } = await context.params;

        // Another room's library is not found from here (§21).
        requireLibraryInRoom(id, auth);

        const body = updateSchema.parse(await request.json());

        if (body.enabled !== undefined) {
            mediaRootRepo.setEnabled(id, body.enabled);
            // Enabled roots are every user's accessible roots, which are cached (§20).
            forgetAuth();
        }
        // Writable gates deletion and nothing else (§18.1). It cannot make the mount itself
        // writable, so switching it on is refused while the volume is mounted :ro.
        if (body.writable !== undefined) await setLibraryWritable(id, body.writable);
        if (body.label !== undefined) mediaRootRepo.setLabel(id, body.label);
        if (body.networkPath !== undefined) mediaRootRepo.setNetworkPath(id, body.networkPath);
        // Last, and validated: an unreadable path is rejected before anything is stored, so a
        // typo cannot leave a library pointing nowhere.
        if (body.path !== undefined) await repointLibrary(id, body.path);

        // `rootsEnabled` and every viewer's per-library counts are cached, and enabling a
        // library is exactly the moment somebody is watching those numbers.
        clearLibraryCaches();

        return NextResponse.json({ ok: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}

/**
 * Forgets a library and everything catalogued from it.
 *
 * The files on disk are untouched: this discards the catalogue's memory, not the content. It
 * exists so a mistyped library is not permanent — and it is the only way a library row ever
 * disappears, because nothing removes one for being unreachable.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        requireScope(auth, "admin");

        const { id } = await context.params;

        requireLibraryInRoom(id, auth);
        removeLibrary(id);

        return NextResponse.json({ ok: true });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
