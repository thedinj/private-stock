import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";

import { BACKGROUND } from "./api/background";
import { mediaDetailQuery } from "./api/media";
import { navigationStarted } from "./navigationPending";

/**
 * Opening an item: the one way every tile, wall and stage goes to `/media/:id` (§14, "Waiting").
 *
 * The viewer needs two things before it can show anything -- the route's payload and the item's
 * details -- and the server answers both quickly. The time used to be lost here, in series: the
 * click froze the screen in a view transition, the route was fetched inside the freeze, and the
 * details only after the viewer had mounted, so for a second or two nothing on screen moved and
 * nothing said the click had been heard. Three rules replace that:
 *
 *  - **Warm on intent, not on release.** A press on an item, or a pointer resting on one, starts
 *    both requests for that one item (`useItemWarming`). Grids keep `prefetch={false}`: sixty
 *    route payloads for a page nobody opens is the cost this avoids.
 *  - **Acknowledge the press within a frame.** The pressed tile is marked `data-opening`, which
 *    the stylesheet draws as a candle carried round its edge, and the header's rail is told a
 *    navigation has started.
 *  - **Wait before freezing, not inside the freeze.** The navigation -- and the morph, when there
 *    is one -- starts once the details are in the cache, or after `WARM_CAP_MS` regardless. The
 *    morph then plays straight away and lands on a stage that already has its item.
 */

type Router = ReturnType<typeof useRouter>;

const ITEM_PATH = /^\/media\/([^/]+)$/;

/** How long a pointer rests on an item before it counts as interest. Mouse and pen only. */
const HOVER_INTENT_MS = 150;

/** The longest a press waits for the item before navigating anyway. */
const WARM_CAP_MS = 1500;

/** A navigation that never lands must not leave a tile lit for ever (as `navigationPending`). */
const LAPSE_MS = 15_000;

/** The item a same-origin address opens, or null when it is not an item's page. */
export const itemIdOf = (url: URL): string | null => {
    if (url.origin !== window.location.origin) return null;

    const match = ITEM_PATH.exec(url.pathname);

    return match ? decodeURIComponent(match[1]) : null;
};

/** A plain left click: anything modified is a new tab or window, and the browser's to make. */
export const isPlainClick = (
    event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">
): boolean =>
    event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * Both halves of what the viewer will ask for, started now.
 *
 * Repeats are cheap: a fresh entry is not fetched again (the client's `staleTime`), one in flight
 * is joined rather than duplicated, and the router keeps its own prefetches. `BACKGROUND`, because
 * a pointer resting on a tile is not somebody waiting -- once the tile is pressed they are, and
 * the press says so through `navigationStarted` instead.
 *
 * The route's prefetch cannot be awaited (`router.prefetch` returns nothing), so only the details
 * are. The route is usually ahead of them anyway, having started at the same moment and being a
 * few kilobytes, and whatever is left of it is what the view transition still waits for.
 */
const warm = (
    queryClient: QueryClient,
    router: Router,
    id: string,
    href: string
): Promise<void> => {
    router.prefetch(href);

    return queryClient.prefetchQuery({ ...mediaDetailQuery(id), meta: BACKGROUND });
};

/** The item an event's target belongs to: an item link, or a control naming its item. */
const itemTarget = (
    target: EventTarget | null
): { id: string; href: string; element: Element } | null => {
    if (!(target instanceof Element)) return null;

    const element = target.closest<HTMLElement>("a[href], [data-warm-item]");

    if (!element) return null;

    if (element instanceof HTMLAnchorElement) {
        const url = new URL(element.href, window.location.href);
        const id = itemIdOf(url);

        return id ? { id, href: url.pathname + url.search, element } : null;
    }

    const id = element.dataset.warmItem;

    return id ? { id, href: `/media/${encodeURIComponent(id)}`, element } : null;
};

/**
 * Warms an item on a press or a resting pointer, anywhere in the document.
 *
 * Delegated rather than wired into each tile, so every link to an item -- a tile, a filmstrip
 * frame, a title in the Duplicates list -- is covered without knowing it, and a control that is
 * not a link says which item it opens with `data-warm-item`. Listened for in the capture phase,
 * so a handler inside that stops a pointer event (the tasting's controls stop every one) does
 * not stop the warm. Mounted once per screen: by `PageTurn` in the shell, and by the showcase and
 * the tasting, which are outside it.
 */
export const useItemWarming = (): void => {
    const queryClient = useQueryClient();
    const router = useRouter();

    useEffect(() => {
        let hovered: Element | null = null;
        let timer: number | undefined;

        const onPointerDown = (event: PointerEvent) => {
            const item = itemTarget(event.target);

            if (item) void warm(queryClient, router, item.id, item.href);
        };

        // `pointerover` fires again for every child the pointer crosses inside the same tile, so
        // only a change of item restarts the wait. A finger has no hover to rest.
        const onPointerOver = (event: PointerEvent) => {
            if (event.pointerType === "touch") return;

            const item = itemTarget(event.target);

            if ((item?.element ?? null) === hovered) return;

            window.clearTimeout(timer);
            hovered = item?.element ?? null;

            if (item) {
                timer = window.setTimeout(
                    () => void warm(queryClient, router, item.id, item.href),
                    HOVER_INTENT_MS
                );
            }
        };

        const options = { capture: true, passive: true };

        document.addEventListener("pointerdown", onPointerDown, options);
        document.addEventListener("pointerover", onPointerOver, options);

        return () => {
            window.clearTimeout(timer);
            document.removeEventListener("pointerdown", onPointerDown, options);
            document.removeEventListener("pointerover", onPointerOver, options);
        };
    }, [queryClient, router]);
};

interface Opening {
    marker: HTMLElement | null;
    /** The navigation has been started; only now may the address changing end it. */
    launched: boolean;
    lapse?: number;
}

/** The one press being answered. A second press, anywhere, supersedes it. */
let opening: Opening | null = null;

/** The picture of the item last opened, for the viewer to show while its details arrive. */
let picture: { id: string; url: string } | null = null;

const release = (): void => {
    if (!opening) return;

    window.clearTimeout(opening.lapse);
    opening.marker?.removeAttribute("data-opening");
    opening = null;
};

/**
 * Called by `PageTurn` when the address changes: an opening that has navigated has arrived.
 *
 * One that is still warming is left alone, because the address also changes under a grid that
 * rewrites its own query while somebody presses a tile, and that is not the press being answered.
 */
export const openingSettled = (): void => {
    if (opening?.launched) release();
};

/** Called by `PageTurn` when some other navigation is started: that one wins. */
export const abandonOpening = (): void => release();

/**
 * The picture the item was opened from, if this is the item last opened.
 *
 * Kept after the opening has settled: the viewer reads it on every render until its details
 * arrive, and the address settles before they do when the warm ran out of time.
 */
export const openingPicture = (id: string): string | null =>
    picture?.id === id ? picture.url : null;

/** The cover a pressed tile is showing, already decoded and in the browser's cache. */
const pictureIn = (marker: HTMLElement | null): string | null => {
    const image = marker?.querySelector("img");

    return image ? image.currentSrc || image.src || null : null;
};

export interface OpenItemRequest {
    id: string;
    /** The item's address, with any `?at=`. */
    href: string;
    /**
     * The element that is lit while the item is on its way: a tile's frame, the tasting's stage.
     * It must be positioned, since the light is drawn in its `::after`. Null for a press with
     * nothing to light, which still has the header's rail.
     */
    marker: HTMLElement | null;
    /** The picture to stand on the stage meanwhile. By default, whatever `marker` is showing. */
    picture?: string | null;
    /** How to go once warmed: a morph or a page turn in the shell, `router.push` elsewhere. */
    navigate?: () => void;
}

/**
 * Opens an item: acknowledge now, warm, then navigate.
 *
 * The returned function is stable. Bookkeeping that belongs to the caller -- where to return
 * to, where a wall or a tasting was -- is done by the caller before calling it, exactly as it was
 * before the navigation was a separate step.
 */
export const useOpenItem = (): ((request: OpenItemRequest) => void) => {
    const queryClient = useQueryClient();
    const router = useRouter();

    return useCallback(
        ({ id, href, marker, picture: shown, navigate }: OpenItemRequest) => {
            release();

            const mine: Opening = { marker, launched: false };
            const url = shown === undefined ? pictureIn(marker) : shown;

            opening = mine;
            marker?.setAttribute("data-opening", "");
            picture = url ? { id, url } : null;
            navigationStarted();

            const capped = new Promise<void>((resolve) => window.setTimeout(resolve, WARM_CAP_MS));

            void Promise.race([warm(queryClient, router, id, href), capped]).then(() => {
                // Superseded by another press, or by a navigation somewhere else.
                if (opening !== mine) return;

                mine.launched = true;
                mine.lapse = window.setTimeout(() => {
                    if (opening === mine) release();
                }, LAPSE_MS);

                if (navigate) navigate();
                else router.push(href);
            });
        },
        [queryClient, router]
    );
};
