"use client";

import { useQuery } from "@tanstack/react-query";

import { parseSpriteVtt, type SpriteCue } from "@private-stock/core";

import { queryKeys } from "@/lib/api/queryKeys";

/**
 * A video's sprite track as cues (§9), or none while it has no sprite.
 *
 * Same-origin `fetch` rather than `api()`: the track is served by the art route, which reads the
 * HttpOnly cookie, and it is text rather than JSON. The URL carries a version token, so the
 * answer never goes stale.
 */
export const useSpriteCues = (vttUrl: string | null) =>
    useQuery({
        queryKey: queryKeys.spriteCues(vttUrl ?? ""),
        queryFn: async (): Promise<SpriteCue[]> => {
            const response = await fetch(vttUrl!, { credentials: "same-origin" });

            return response.ok ? parseSpriteVtt(await response.text()) : [];
        },
        enabled: vttUrl !== null,
        staleTime: Infinity,
    });
