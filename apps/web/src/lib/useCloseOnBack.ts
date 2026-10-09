import { useEffect, useRef } from "react";

/**
 * Back closes an overlay rather than leaving the page under it (§14).
 *
 * On a phone a full-screen view *is* the page as far as anyone holding it can tell, and the
 * system Back gesture is how you leave a page -- so pressing it on an enlarged capture threw
 * away the list behind it as well, which is two steps for one press.
 *
 * While any overlay is open, one history entry is pushed at the same address, marked as ours.
 * Back pops it and every open overlay closes; nothing else moves, because the entry underneath
 * is the page as it was. Closed any other way -- its own button, Escape, a tap -- the entry is
 * taken back off with `history.back()` once no overlay is left open, so the history ends as it
 * began and the next Back leaves the page.
 *
 * **One entry for all of them**, not one each: one overlay often hands over to another in the
 * same render -- a face's closer look to the item played beside it, one face's look to the
 * next. An entry each would take the first off and push the second in one go, and the pending
 * `back()` would then pop the second's entry and close it the moment it opened. So taking the
 * entry off waits a tick, and an overlay that opened meanwhile keeps it.
 *
 * Only taken back off while it is still the current entry. A link followed from inside the
 * overlay has pushed a page on top of it by the time the overlay unmounts, and going back
 * then would undo the navigation; a link like that should `replace` instead (see
 * `FrameLightbox`), so the marker is what it overwrites.
 *
 * Next's App Router patches `pushState` to copy its own tree into the entry, so the marker is
 * a normal router entry and popping back off it is a traversal to the same tree -- no reload,
 * no refetch, no remount.
 */
const MARKER = "__psOverlay";

const onMarker = (): boolean =>
    typeof window !== "undefined" &&
    (window.history.state as Record<string, unknown> | null)?.[MARKER] === true;

/** The overlays open now, by how each is closed. */
const open = new Set<{ current: () => void }>();
/** Whether the marker entry is in the history, pushed by us and not yet taken off or popped. */
let pushed = false;

const onPopState = (): void => {
    if (!pushed || onMarker()) return;

    // Back took the marker off: every overlay closes, and none of them takes it off again.
    pushed = false;

    const closing = [...open];

    open.clear();
    window.removeEventListener("popstate", onPopState);
    for (const close of closing) close.current();
};

const register = (close: { current: () => void }): void => {
    open.add(close);

    if (!pushed) {
        window.history.pushState({ [MARKER]: true }, "");
        pushed = true;
        window.addEventListener("popstate", onPopState);
    }
};

const unregister = (close: { current: () => void }): void => {
    if (!open.delete(close)) return;

    // A tick later, so an overlay opening in the same render keeps the entry.
    window.setTimeout(() => {
        if (open.size > 0 || !pushed) return;

        pushed = false;
        window.removeEventListener("popstate", onPopState);
        if (onMarker()) window.history.back();
    }, 0);
};

/** The shared entry's bookkeeping, apart from React: a test seam. */
export const overlayHistory = { register, unregister };

export const useCloseOnBack = (opened: boolean, onClose: () => void): void => {
    // The latest `onClose` without making it a reason to register again.
    const close = useRef(onClose);

    close.current = onClose;

    useEffect(() => {
        if (!opened) return;

        const entry = close;

        register(entry);

        return () => unregister(entry);
    }, [opened]);
};
