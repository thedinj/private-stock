"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useReviewPasses } from "@/lib/api/reviewPasses";
import { legacyReviewedParams } from "@/lib/libraryQuery";

/**
 * Rewrites a library address from before review passes (`reviewed=yes|no`) once this room's
 * passes are known (§14d): the bookmark asks its question of the "Reviewed" pass, or loses it
 * where there is none. Replaced rather than pushed, so Back does not return to the old spelling.
 */
export const useLegacyReviewedAddress = (): void => {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { data: passList } = useReviewPasses();

    useEffect(() => {
        if (!passList) return;

        const converted = legacyReviewedParams(
            new URLSearchParams(searchParams.toString()),
            passList.passes
        );

        if (converted) {
            const query = converted.toString();

            router.replace(query ? `${pathname}?${query}` : pathname);
        }
    }, [passList, pathname, router, searchParams]);
};
