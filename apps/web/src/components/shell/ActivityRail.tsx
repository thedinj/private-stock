"use client";

import { useEffect, useRef, useState } from "react";
import { useIsFetching, useIsMutating } from "@tanstack/react-query";

import { useNavigationPending } from "@/lib/navigationPending";

import classes from "./ActivityRail.module.scss";

/** A quicker answer than this is simply shown: a light that flashes and goes says nothing. */
const SHOW_AFTER_MS = 250;

/** Once lit, held at least this long, so one pass of the light can be seen to happen. */
const HOLD_MS = 700;

/**
 * A light carried along the bottom edge of the header while the app is waiting on the server
 * (§14, "Waiting").
 *
 * The seal's cork ring says the *worker* is busy; this says *you* are waiting for an answer.
 * Waiting means: a page you followed a link to has not rendered, something you did has not
 * been answered, or a query with nothing to show yet is fetching -- a first load, or a filter
 * or sort whose list is still showing the previous answer. A refetch of something already on
 * screen is not waiting, which is what keeps every poll in the app from lighting it, and a
 * query that only reads ahead says so with `BACKGROUND`.
 *
 * Decoration over state the page shows too (a loader, a settling list, a busy button), so it is
 * hidden from assistive technology.
 */
export const ActivityRail: React.FC = () => {
    const fetching = useIsFetching({
        predicate: (query) => query.state.data === undefined && !query.meta?.background,
    });
    const mutating = useIsMutating();
    const navigating = useNavigationPending();
    const waiting = fetching > 0 || mutating > 0 || navigating;

    const [shown, setShown] = useState(false);
    const shownAt = useRef(0);

    useEffect(() => {
        if (waiting === shown) return;

        const delay = waiting
            ? SHOW_AFTER_MS
            : Math.max(0, HOLD_MS - (performance.now() - shownAt.current));
        const timer = window.setTimeout(() => {
            shownAt.current = performance.now();
            setShown(waiting);
        }, delay);

        return () => window.clearTimeout(timer);
    }, [waiting, shown]);

    return (
        <div className={`${classes.rail} ${shown ? classes.shown : ""}`} aria-hidden>
            <div className={classes.light} />
        </div>
    );
};
