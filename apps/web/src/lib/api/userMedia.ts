"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { MediaDetail } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * This viewer's opinion of one item, and everything that goes stale with it (§6).
 *
 * A hook rather than a mutation written at each call site, because the *cascade* is the part
 * worth stating once. A rating is not only a property of an item, it is a membership test:
 * "Unrated only" stops matching the moment a star is given, "Favourites" starts, a
 * minimum-rating filter can go either way, and the room's shelves are filtered lists by
 * another name. Two controls set a rating -- the stars and the number keys -- and a second
 * copy of that reasoning would be a second chance to get it wrong in one of them.
 *
 * See `docs/CACHE_KEYS.md` §2.
 */

export interface UserMediaPatch {
    rating?: number | null;
    favorite?: boolean;
}

export interface UserMediaResult {
    rating: number | null;
    favorite: boolean;
}

export const useUserMedia = (mediaId: string) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (patch: UserMediaPatch) =>
            api<UserMediaResult>(`/api/media/${mediaId}/user`, {
                method: "PATCH",
                body: JSON.stringify(patch),
            }),
        onSuccess: (result) => {
            /**
             * The item's own answer, written in before anything refetches.
             *
             * The controls show the sent value only while the request is in flight, and the
             * refetch below lands a round trip after it ends -- so in between they showed the
             * old value again, and a heart pressed with `h` visibly un-pressed itself for a
             * moment before coming back. The response is the stored truth; nothing is
             * guessed by using it.
             */
            queryClient.setQueryData<MediaDetail>(queryKeys.media.detail(mediaId), (current) =>
                current ? { ...current, ...result } : current
            );

            /**
             * The whole media cache, not just this item.
             *
             * `invalidateQueries` refetches *mounted* queries and merely marks the rest
             * stale, and the list, the count and the home shelves are all unmounted while an
             * item is open — so rating a dozen items in a row spends one refetch when you
             * return, not a dozen while you work.
             */
            void queryClient.invalidateQueries({ queryKey: queryKeys.media.all() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.home() });
        },
    });
};

/**
 * What to show while a patch is in flight.
 *
 * `variables?.rating ?? stored` looks like the same thing and is not, because **null is a
 * value here rather than an absence**: clearing a rating sends `{ rating: null }`, `??` reads
 * that as "nothing was sent" and falls back to the rating being cleared. So pressing the star
 * you already gave left the stars unchanged for the length of the round trip — on a NAS, long
 * enough to conclude that clearing a rating is not possible.
 *
 * Which is the whole failure: the write was always correct and only the display disagreed,
 * and a control that does the right thing while showing the wrong thing is indistinguishable
 * from one that does nothing.
 *
 * `favorite` needs no equivalent: `false` is not nullish, so `??` never swallowed it.
 */
export const ratingWhilePending = (
    stored: number | null,
    pending: UserMediaPatch | undefined
): number | null => (pending && "rating" in pending ? (pending.rating ?? null) : stored);

/**
 * What pressing a number means, given what is already stored.
 *
 * Pressing the rating you already gave takes it back, which is exactly what clicking the
 * star you already gave does — the only way to return to unrated, and a rule people find by
 * trying it rather than by being told. Shared so the two controls cannot disagree about it.
 */
export const ratingAfterPressing = (pressed: number, current: number | null): number | null =>
    pressed === current ? null : pressed;
