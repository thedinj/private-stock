import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@mantine/core";
import { useWindowVirtualizer, type Virtualizer } from "@tanstack/react-virtual";

import classes from "./OcrReview.module.scss";

interface VirtualFeedProps<T> {
    items: T[];
    keyOf: (item: T) => string;
    /** A typical row's height. Rows are measured once drawn; this only places the unseen ones. */
    estimate: number;
    render: (item: T, index: number) => React.ReactNode;
    hasMore: boolean;
    loadingMore: boolean;
    onLoadMore: () => void;
    /** Receives the virtualizer, so a keyboard cursor can scroll a row into view. */
    virtualizerRef?: React.MutableRefObject<Virtualizer<Window, Element> | null>;
}

/** How close to the end of what is loaded the next page is asked for, in rows. */
const LOAD_AHEAD = 10;

/**
 * A long list that loads as it is scrolled, and draws only the rows near the screen.
 *
 * Both halves matter at the review page's scale (§5d). Loading by cursor means a list of a
 * hundred thousand strings costs a page per screenful rather than a count and an offset; drawing
 * only what is near the screen means an hour of scrolling does not leave tens of thousands of
 * rows — and their thumbnails — in the document.
 *
 * The page scrolls, not a box inside it, so the browser's own scrolling, find-in-page and the
 * sticky selection bar all behave as they do everywhere else. Rows are measured as they are
 * drawn, because a row that has been opened is taller than one that has not.
 *
 * A "Load more" button stays at the end regardless: an observer that never fires — a tall
 * screen with a short first page, a browser that throttles — must not strand the list.
 */
export const VirtualFeed = <T,>({
    items,
    keyOf,
    estimate,
    render,
    hasMore,
    loadingMore,
    onLoadMore,
    virtualizerRef,
}: VirtualFeedProps<T>): React.ReactElement => {
    const listRef = useRef<HTMLDivElement>(null);
    const [scrollMargin, setScrollMargin] = useState(0);

    // Where the list starts on the page, which moves when anything above it changes height.
    useLayoutEffect(() => {
        const list = listRef.current;

        if (!list) return;

        const measure = (): void =>
            setScrollMargin(list.getBoundingClientRect().top + window.scrollY);

        measure();

        const observer = new ResizeObserver(measure);
        observer.observe(document.body);

        return () => observer.disconnect();
    }, []);

    const virtualizer = useWindowVirtualizer({
        count: items.length,
        estimateSize: () => estimate,
        overscan: 6,
        scrollMargin,
        getItemKey: (index) => keyOf(items[index]),
    });

    if (virtualizerRef) {
        virtualizerRef.current = virtualizer;
    }

    const rows = virtualizer.getVirtualItems();
    const lastDrawn = rows[rows.length - 1]?.index ?? -1;

    // Paging, not fetching: TanStack does the fetch, this only says the reader is near the end.
    useEffect(() => {
        if (hasMore && !loadingMore && lastDrawn >= items.length - LOAD_AHEAD) {
            onLoadMore();
        }
    }, [hasMore, loadingMore, lastDrawn, items.length, onLoadMore]);

    return (
        <>
            <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {rows.map((row) => (
                    <div
                        key={row.key}
                        data-index={row.index}
                        ref={virtualizer.measureElement}
                        style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
                        }}
                    >
                        {render(items[row.index], row.index)}
                    </div>
                ))}
            </div>

            {hasMore && (
                <div className={classes.more}>
                    <Button variant="subtle" loading={loadingMore} onClick={onLoadMore}>
                        Load more
                    </Button>
                </div>
            )}
        </>
    );
};
