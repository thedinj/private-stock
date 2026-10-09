import { pathOf, requestReturnCorrection } from "./returnTo";
import { saveShowcasePosition } from "./showcase/restore";
import {
    SHOWCASE_PATH,
    TASTING_PATH,
    showcaseAddressPage,
    showcaseSet,
    showcaseSetKey,
} from "./showcase/set";
import { saveTastingPosition } from "./tasting/restore";

/**
 * Leaving the viewer for the place it was opened from, at the place it has got to (§14b).
 *
 * The way back is `history.back()` whenever there is history to go back through, because that
 * restores the list exactly — scroll position included — and leaves one history entry for it
 * rather than two. What it restores is the list as it was *left*, though, and the viewer may
 * have stepped several pages on since. So before going, the viewer says where it is now, in
 * the form the receiving page understands:
 *
 *  - a library or playlist page replaces its address with the one reached, on arrival
 *  - the showcase centres the item the viewer was last on
 *  - the tasting carries on from it (§14g)
 *
 * A tab with nothing behind it — the item opened in a new tab, which copies this tab's
 * storage and so its recorded address — has no history to go back through, and `back()` there
 * would do nothing or leave the app. It navigates to the address instead.
 */
export const leaveViewer = (
    returnTo: string,
    itemId: string,
    page: number | null,
    navigate: { back: () => void; push: (href: string) => void }
): void => {
    const path = pathOf(returnTo);

    if (path === SHOWCASE_PATH || path === TASTING_PATH) {
        const query = new URLSearchParams(returnTo.slice(returnTo.indexOf("?") + 1));
        const position = {
            filter: showcaseSetKey(showcaseSet(query)),
            page: page ?? showcaseAddressPage(query),
            itemId,
        };

        if (path === SHOWCASE_PATH) {
            saveShowcasePosition({ ...position, fraction: 0 });
        } else {
            saveTastingPosition(position);
        }
    } else {
        requestReturnCorrection(returnTo);
    }

    if (window.history.length > 1) {
        navigate.back();
    } else {
        navigate.push(returnTo);
    }
};
