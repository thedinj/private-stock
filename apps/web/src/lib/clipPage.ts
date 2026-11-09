"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { clipRunQuery } from "@/lib/api/libraryTabs";
import { viewToParams, type LibraryView } from "@/lib/libraryQuery";
import { rememberReturn } from "@/lib/returnTo";

/**
 * A clip's page (§14e "Playing the small kinds"): `/clips/:id`, with the Clips tab's query it
 * was opened from in the address -- the run it carries on through. `run=1` is Play from the top,
 * which rolls on whatever the viewer's "Autoplay next" says.
 */
export const clipHref = (clipId: string, view: LibraryView, fromTop = false): string => {
    const params = viewToParams({ ...view, kind: "clip", page: 0 });

    if (fromTop) params.set("run", "1");

    return `/clips/${encodeURIComponent(clipId)}?${params.toString()}`;
};

/** Open a clip on its page, from a grid or a shelf whose address is the way back. */
export const useOpenClip = (): ((clipId: string, view: LibraryView) => void) => {
    const router = useRouter();

    return (clipId, view) => {
        rememberReturn();
        router.push(clipHref(clipId, view));
    };
};

/**
 * Play the Clips tab from the top: its first clip's page, rolling on. The run is fetched here
 * under the page's own key, so the page arrives to a cache hit.
 */
export const usePlayClipsFromTop = (): ((view: LibraryView) => Promise<void>) => {
    const router = useRouter();
    const queryClient = useQueryClient();

    return async (view) => {
        const run = await queryClient.fetchQuery({ ...clipRunQuery(view), staleTime: 30_000 });
        const first = run.items[0];

        if (!first) return;

        rememberReturn();
        router.push(clipHref(first.clip.id, view, true));
    };
};
