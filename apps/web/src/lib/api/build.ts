"use client";

import { useQuery } from "@tanstack/react-query";

import type { BuildStamp } from "@private-stock/core";

import { useAuth } from "@/lib/api/AuthProvider";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { buildInfo } from "@/lib/buildInfo";

/**
 * Asked again whenever the page comes back into view, and every quarter hour while it is in
 * view. Returning to the app is the moment that matters: an installed app is resumed far more
 * often than it is opened, and a deploy usually happens while it is in the background.
 */
const INTERVAL_MS = 15 * 60_000;

/**
 * Whether the server has moved on from the build this page was loaded from (§14, "Installing").
 *
 * A page left open across a deploy keeps running the old JavaScript against the new server:
 * its API calls meet response shapes it was not written for, and a screen it has not opened yet
 * asks for code-split chunks the new image does not have. Next reloads on a mismatched
 * navigation, but not a page that is simply sitting open — which is what an installed app
 * mostly is, with no reload button to fix it by hand.
 *
 * Off in development, where the dev server replaces modules in place and the two stamps are
 * not meant to agree.
 */
export const useBuildCheck = (): { serverId: string; stale: boolean } | null => {
    const { user } = useAuth();

    const { data } = useQuery({
        queryKey: queryKeys.build(),
        queryFn: () => api<BuildStamp>("/api/build"),
        enabled: user !== null && process.env.NODE_ENV !== "development",
        staleTime: 0,
        // The app's default is off; this is the one query that exists for the focus event.
        refetchOnWindowFocus: "always",
        refetchInterval: INTERVAL_MS,
        refetchIntervalInBackground: false,
    });

    if (!data) return null;

    return { serverId: data.id, stale: data.id !== buildInfo.id };
};
