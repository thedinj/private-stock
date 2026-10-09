"use client";

import { Suspense, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { ShowcaseStage } from "@/components/showcase/ShowcaseStage";
import { RequireAuth } from "@/lib/api/AuthProvider";
import { cameFromLibrary } from "@/lib/fullScreenEntry";
import { showcaseOriginHref, showcaseSet } from "@/lib/showcase/set";

/**
 * The showcase (§14f): the filtered library or a playlist, full screen, as a moving wall of
 * pictures.
 *
 * Its own route rather than a fourth library `mode`, and outside the app shell: it has no
 * header, no nav and no pager, and the one thing it shares with the cellar — the filter — is
 * carried in the address the same way, so any library view can be opened as a showcase and
 * any showcase closed back into the view it came from.
 */
const Showcase: React.FC = () => {
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

    return <ShowcaseStage set={set} onExit={onExit} />;
};

const ShowcasePage: React.FC = () => (
    <RequireAuth>
        <Suspense>
            <Showcase />
        </Suspense>
    </RequireAuth>
);

export default ShowcasePage;
