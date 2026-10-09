"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Which thumbnails the tag pages show (§6 "Tags").
 *
 * **Today's, unless somebody asked for others.** A fresh shuffle on every visit sounds livelier
 * and behaves worse: Back from a person's page lands on a wall that has rearranged itself, and
 * the art cache never gets a second hit. So the default is the day -- the same strips all day,
 * new ones tomorrow -- and reshuffle puts an explicit `?seed=` in the address, where Back and a
 * reload both keep it.
 *
 * Local days rather than UTC, so the change happens overnight wherever the household is rather
 * than at teatime.
 */
const today = (): number => {
    const now = new Date();

    return Math.floor((now.getTime() - now.getTimezoneOffset() * 60_000) / 86_400_000);
};

/** The seed the address names, or today's; and a way to roll a new one. */
export const useTagSeed = (): { seed: number; reshuffle: () => void } => {
    const params = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();

    const named = Number.parseInt(params.get("seed") ?? "", 10);
    const seed = Number.isFinite(named) && named >= 0 ? named : today();

    const reshuffle = useCallback(() => {
        const next = new URLSearchParams(params.toString());

        next.set("seed", String(Math.floor(Math.random() * 1_000_000_000)));
        // Replace rather than push: a reshuffle is not somewhere to come back to, and ten
        // presses should not take ten presses of Back to leave.
        router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    }, [params, pathname, router]);

    return { seed, reshuffle };
};
