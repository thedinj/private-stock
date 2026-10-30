import { queryOptions, useMutation } from "@tanstack/react-query";

import type { MediaDetail, MediaToken, MediaTokens } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * One item's details, as the viewer reads them -- the key and the request, stated once.
 *
 * Several things ask for the same item: the viewer, its read-ahead of the next item, a tile
 * being pressed (`lib/openItem.ts`), and a few dialogs that need one field of it. A warm is only
 * worth anything if it lands in the entry the viewer will read, and two call sites that each
 * spell the request are two chances for one of them to fetch something the other never finds.
 * Callers spread this and add only what is theirs: a poll, a `staleTime`, `meta`.
 */
export const mediaDetailQuery = (mediaId: string) =>
    queryOptions({
        queryKey: queryKeys.media.detail(mediaId),
        queryFn: () => api<MediaDetail>(`/api/media/${encodeURIComponent(mediaId)}`),
    });

/**
 * A link to an item's original for a player outside the browser (§8, "Open in another app").
 *
 * A mutation, not a query: it mints a credential, which is never cached, prefetched or shared.
 * Nothing is invalidated by it.
 */
export const useOriginalLink = (mediaId: string) =>
    useMutation({
        mutationFn: () =>
            api<MediaToken>(`/api/media/${encodeURIComponent(mediaId)}/token`, {
                method: "POST",
                body: JSON.stringify({ original: true }),
            }),
    });

/**
 * Links a TV can play, for an item and the ones after it (§11, casting).
 *
 * A mutation for the reason `useOriginalLink` is one: each call mints credentials. The answer
 * leaves out whatever cannot be cast, in the order asked, so the first link is the item asked
 * for only if that item can be cast at all.
 */
export const useCastLinks = () =>
    useMutation({
        mutationFn: (ids: string[]) =>
            api<MediaTokens>("/api/media/tokens", {
                method: "POST",
                body: JSON.stringify({ ids }),
            }),
    });
