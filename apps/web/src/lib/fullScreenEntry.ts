import { snuffThen } from "./candleSnuff";

/**
 * Opening a full-screen mode from a library view, and knowing on the way out whether that is
 * where we came from (§14f, §14g).
 *
 * The showcase and the tasting both take the library's own address and both leave the shell,
 * so they enter and leave the same way.
 *
 * Full screen is requested here, in the click, because browsers grant it only in answer to a
 * gesture — by the time the mode has mounted, the gesture is gone.
 */

const KEY = "ps:fullScreenFrom";

/** The address to navigate to, with full screen asked for on the way. */
const enterFullScreenMode = (path: string, libraryParams: URLSearchParams): string => {
    const params = new URLSearchParams(libraryParams);

    params.delete("page");

    try {
        sessionStorage.setItem(KEY, "1");
    } catch {
        // Closing falls back to a fresh navigation, which lands in the same view.
    }

    if (!document.fullscreenElement) {
        void document.documentElement.requestFullscreen?.().catch(() => undefined);
    }

    return `${path}?${params.toString()}`;
};

/**
 * Called from the library's click handler: full screen is asked for at once, inside the
 * gesture, then the room is snuffed (§14, "Motion") and `navigate` opens the mode.
 */
export const openFullScreenMode = (
    path: string,
    libraryParams: URLSearchParams,
    navigate: (href: string) => void
): void => {
    const href = enterFullScreenMode(path, libraryParams);

    snuffThen(() => navigate(href));
};

/**
 * Whether the library is behind us in this tab's history.
 *
 * Consumed as it is read: a mode opened later from a shared link must not step back into
 * whatever page this tab showed before it.
 */
export const cameFromLibrary = (): boolean => {
    try {
        const value = sessionStorage.getItem(KEY);

        sessionStorage.removeItem(KEY);

        return value === "1";
    } catch {
        return false;
    }
};
