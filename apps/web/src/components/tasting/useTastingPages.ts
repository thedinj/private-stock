"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { fetchShowcasePage } from "@/lib/showcase/pages";
import { type ShowcaseSet, showcaseSetKey } from "@/lib/showcase/set";
import type { Pages, TastingPage } from "@/lib/tasting/sequence";

/**
 * The tasting's pages, fetched as the walk reaches them (§14g).
 *
 * The showcase's keys, deliberately: the viewer opened from the tasting walks this same set and
 * finds its page already cached, and so does a showcase opened on the same view. A playlist's
 * pages are the playlist page's own, for the same reason.
 *
 * **The first answer for a page is kept.** A live update that refetched a page under the show
 * would move every index after the change, and the item the show is on would silently become a
 * different one. The set is the one the tasting was opened on until it is closed.
 *
 * Pages far from the one on show are let go -- a show left running overnight walks the whole
 * library -- except the last, which is what lets a step back from the first item wrap round.
 */

/** How many pages either side of the current one are kept. */
const KEEP_PAGES = 2;

export interface TastingPages {
    pages: Pages;
    /** Fetch a page if it is not here and not on its way. */
    ensure: (page: number) => void;
    /** Let go of pages far from this one. */
    release: (around: number) => void;
    /** The page whose fetch failed, if one did, until `retry`. */
    errorPage: number | null;
    retry: () => void;
}

export const useTastingPages = (set: ShowcaseSet): TastingPages => {
    const filter = showcaseSetKey(set);
    const queryClient = useQueryClient();
    const [pages, setPages] = useState<ReadonlyMap<number, TastingPage>>(() => new Map());
    const [errorPage, setErrorPage] = useState<number | null>(null);

    // Read by `ensure` at the moment it is called, so it does not change identity with them.
    const pagesRef = useRef(pages);
    const inflight = useRef(new Set<number>());
    const filterRef = useRef(filter);

    pagesRef.current = pages;
    filterRef.current = filter;

    // A different set entirely: nothing from the last one applies.
    useEffect(() => {
        setPages(new Map());
        setErrorPage(null);
        inflight.current.clear();
    }, [filter]);

    const ensure = useCallback(
        (page: number) => {
            if (page < 0 || pagesRef.current.has(page) || inflight.current.has(page)) {
                return;
            }

            inflight.current.add(page);

            void fetchShowcasePage(queryClient, set, page)
                .then((response) => {
                    inflight.current.delete(page);

                    // A different filter was chosen while this was in flight.
                    if (filterRef.current !== filter) return;

                    setPages((current) => {
                        if (current.has(page)) return current;

                        const next = new Map(current);

                        next.set(page, {
                            items: response.items,
                            hasMore: response.hasMore,
                            moments:
                                response.moments &&
                                Object.fromEntries(
                                    Object.entries(response.moments).map(([id, moment]) => [
                                        id,
                                        moment.atMs,
                                    ])
                                ),
                        });

                        return next;
                    });
                })
                .catch(() => {
                    inflight.current.delete(page);

                    if (filterRef.current === filter) setErrorPage(page);
                });
        },
        [filter, queryClient, set]
    );

    const release = useCallback((around: number) => {
        setPages((current) => {
            const keep = [...current].filter(
                ([page, data]) => Math.abs(page - around) <= KEEP_PAGES || !data.hasMore
            );

            return keep.length === current.size ? current : new Map(keep);
        });
    }, []);

    const retry = useCallback(() => {
        const page = errorPage;

        setErrorPage(null);

        if (page !== null) ensure(page);
    }, [errorPage, ensure]);

    return { pages, ensure, release, errorPage, retry };
};
