"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { LibraryCellar } from "@/components/library/LibraryCellar";
import { LibraryRoom } from "@/components/library/LibraryRoom";
import { needsShuffleSeed, newShuffleSeed, parseView, viewToParams } from "@/lib/libraryQuery";
import { useReturnCorrection } from "@/lib/useReturnCorrection";

/**
 * One address, two places (§14).
 *
 * `/` is the room — where you arrive, and are offered something. `/?root=…` and `/?view=grid`
 * are the cellar — the rack, paged and filtered, which is where you go to find one particular
 * thing among a few hundred thousand.
 *
 * They are separate components rather than one page with a branch in the middle of its JSX,
 * because they share a toolbar and nothing else: the room has no pager, no facets and no
 * sort, and the cellar has no hero. Held together they were five hundred lines carrying two
 * layouts, and every change to either had to be read against both.
 *
 * The route stays the same for both so that the view remains a URL — a library, a filter and
 * a page are all still shareable, reloadable addresses, and the back button out of a library
 * lands in the room rather than on a different route with its own history.
 */
const LibraryPage: React.FC = () => {
    const router = useRouter();
    const searchParams = useSearchParams();
    const search = searchParams.toString();
    const view = parseView(new URLSearchParams(search));
    const unseeded = needsShuffleSeed(view);

    useReturnCorrection();

    /**
     * A shuffle arrives without a seed from the sort menu, the room, the remembered Library link
     * and some saved filters -- and seedless means one fixed order, the same every visit. Dealt
     * here, the one place every way in passes through, and by `replace` so the seedless address
     * never becomes a history entry the back button could land on.
     *
     * Nothing renders until it is in place, or the grid would fetch the fixed order first and
     * then fetch again.
     */
    useEffect(() => {
        if (unseeded) {
            const params = viewToParams({
                ...parseView(new URLSearchParams(search)),
                seed: newShuffleSeed(),
            });

            router.replace(`/?${params.toString()}`, { scroll: false });
        }
    }, [router, search, unseeded]);

    if (unseeded) {
        return null;
    }

    return view.mode === "room" ? <LibraryRoom /> : <LibraryCellar />;
};

export default LibraryPage;
