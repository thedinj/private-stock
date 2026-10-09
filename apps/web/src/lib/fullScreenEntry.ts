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

/** Called from the library's click handler. Returns the address to navigate to. */
export const enterFullScreenMode = (path: string, libraryParams: URLSearchParams): string => {
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
