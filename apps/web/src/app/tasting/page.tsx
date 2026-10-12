"use client";

import { Suspense, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { TastingStage } from "@/components/tasting/TastingStage";
import { CandleArrival } from "@/components/shell/CandleArrival";
import { RequireAuth } from "@/lib/api/AuthProvider";
import { cameFromLibrary } from "@/lib/fullScreenEntry";
import { showcaseOriginHref, showcaseSet } from "@/lib/showcase/set";

/**
 * The tasting (§14g): the filtered library or a playlist, full screen, a few seconds of each
 * item in turn.
 *
 * Its own route and outside the app shell, as the showcase is, and for the same reasons: it
 * has no header, no nav and no pager, and it takes the library's filter from the same address,
 * so any library view can be tasted and any tasting closed back into the view it came from.
 */
const Tasting: React.FC = () => {
    const router = useRouter();
    const searchParams = useSearchParams();

    const address = searchParams.toString();
    // Rebuilt only when the address changes: the stage resets on a new set.
    const set = useMemo(() => showcaseSet(new URLSearchParams(address)), [address]);
    const libraryHref = showcaseOriginHref(new URLSearchParams(address));

    const onExit = useCallback(() => {
        if (document.fullscreenElement) {
            void document.exitFullscreen().catch(() => undefined);
        }

        // Back, when the library is what is behind us, so the history does not grow a second
        // copy of the view we left; otherwise straight to it.
        if (cameFromLibrary()) {
            router.back();
        } else {
            router.push(libraryHref);
        }
    }, [router, libraryHref]);

    return <TastingStage set={set} onExit={onExit} />;
};

const TastingPage: React.FC = () => (
    <>
        <RequireAuth>
            <Suspense>
                <Tasting />
            </Suspense>
        </RequireAuth>
        {/* Outside the auth gate, so the snuff's dark is taken over the moment the route
            mounts rather than once the session has been checked (§14, "Motion"). */}
        <CandleArrival />
    </>
);

export default TastingPage;
