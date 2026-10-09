import { NextResponse } from "next/server";
import { z } from "zod";

import { NOTE_MAX_LENGTH, NotFoundError } from "@private-stock/core";
import { mediaRepo, userMediaRepo } from "@private-stock/db";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { clearLibraryCaches } from "@/lib/services/libraryService";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * This viewer's own opinion of one item (§6).
 *
 * Nothing subjective lives on `Media`, so this is a separate endpoint rather than a PATCH of
 * the item: rating something is not editing the library, and two users rating the same file
 * must not race each other through one resource.
 *
 * Every field is optional and absent means "leave it alone". Only `rating` is nullable, and
 * that nullability is meaningful — null clears the rating, which is different from not
 * mentioning it. `favorite` and `hidden` take a plain boolean because "not a favourite" and
 * "no opinion" are the same state.
 */
const userMediaSchema = z
    .object({
        rating: z.number().int().min(1).max(5).nullable().optional(),
        favorite: z.boolean().optional(),
        hidden: z.boolean().optional(),
        /**
         * Says so by hand, either way (§14b).
         *
         * The reason `watchedAt` is a stored column at all: the automatic rule is a good
         * guess and a guess has to be correctable. Being unable to say "yes, I have seen
         * this" -- or "no, that was a mistaken click" -- is the failure that made the two
         * derived definitions unusable.
         */
        watched: z.boolean().optional(),
        /**
         * A private note on the item (§6, §14b).
         *
         * Nullable like `rating` and for the same reason: null clears it, which is a real
         * intention and is different from not mentioning it. `""` clears it too -- the repo
         * stores empty as NULL -- so a text box that has been emptied needs no special case
         * on the way out.
         *
         * The cap matches the column's CHECK, so an over-long note is a 400 explaining
         * itself rather than a constraint failure from three layers down.
         */
        note: z.string().max(NOTE_MAX_LENGTH).nullable().optional(),
    })
    .refine((body) => Object.keys(body).length > 0, {
        message: "Supply at least one of rating, favorite, hidden, watched or note",
    });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const auth = await requireAuth(request);
        const { id } = await context.params;
        const body = userMediaSchema.parse(await request.json());

        // The same visibility check the library uses. Without it, rating an id would confirm
        // that the id exists — and would attach this user's opinion to an item in a root they
        // were never granted.
        if (!mediaRepo.findDetail(id, auth.userId, auth.accessibleRootIds)) {
            throw new NotFoundError("Media not found");
        }

        if (body.rating !== undefined) {
            userMediaRepo.setRating(auth.userId, id, body.rating);
        }

        if (body.favorite !== undefined) {
            userMediaRepo.setFavorite(auth.userId, id, body.favorite);
        }

        if (body.hidden !== undefined) {
            userMediaRepo.setHidden(auth.userId, id, body.hidden);
            // A hidden item leaves this viewer's counts, which are cached (§20).
            clearLibraryCaches();
        }

        if (body.watched !== undefined) {
            userMediaRepo.setWatched(auth.userId, id, body.watched);
        }

        if (body.note !== undefined) {
            userMediaRepo.setNote(auth.userId, id, body.note);
        }

        // Deliberately no ChangeLog row. This is one viewer's private state, and broadcasting
        // it would push another user's rating into every open grid (§13b) — a live update
        // that is not just useless to other viewers but wrong for them.
        const row = mediaRepo.findDetail(id, auth.userId, auth.accessibleRootIds);

        return NextResponse.json({
            rating: row?.rating ?? null,
            favorite: row?.favorite === 1,
            hidden: row?.hidden === 1,
            // Read back rather than echoed: the repo trims, and empty becomes null. A client
            // that showed what it sent would disagree with the next page load.
            note: row?.note ?? null,
        });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
