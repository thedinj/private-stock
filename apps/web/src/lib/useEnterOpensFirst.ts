import { useEffect } from "react";

/**
 * Enter on a library page, with nothing focused, opens the first item of what is shown (§14
 * "Hotkeys"; §14d "Reviewing recordings for a reel").
 *
 * The keyboard's way into a set: "To review" lands on the grid, and the first tile is sixty Tabs
 * away behind the sidebar and the filters. From the item on, the viewer's own keys carry the
 * pass -- n, p and d walk the same set the grid shows.
 *
 * It clicks the tile's own link rather than navigating itself, so the tile's handlers run as
 * they would for a click: the view being left is recorded, and the item knows its set.
 * Only when nothing has focus -- Enter on a focused control is that control's.
 */
export const useEnterOpensFirst = (): void => {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Enter" || event.repeat) return;
            if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
            if (event.target !== document.body && event.target !== document.documentElement) {
                return;
            }

            const first = document.querySelector<HTMLAnchorElement>("main a[data-media-id]");

            if (!first) return;

            event.preventDefault();
            first.click();
        };

        document.addEventListener("keydown", onKeyDown);

        return () => document.removeEventListener("keydown", onKeyDown);
    }, []);
};
