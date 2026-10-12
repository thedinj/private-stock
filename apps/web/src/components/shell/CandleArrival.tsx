"use client";

import { useLayoutEffect, useState } from "react";

import { DURATION } from "@/lib/motion";
import { takeSnuffArrival } from "@/lib/candleSnuff";

import classes from "./CandleArrival.module.scss";

/** The flame's breath plus the lift, after which the dark is taken out of the page. */
const HELD_MS = 900 + DURATION.arrive;

/**
 * The other half of the snuff (§14, "Motion"): a tasting or the showcase opening out of the dark.
 *
 * Mounted by the mode's page. When the mode was opened by a snuff it holds the black for a
 * breath with a candle flame in it, then lifts it off the stage; opened any other way -- a
 * shared link, the viewer's way back -- it renders nothing. Either way it clears whatever dark
 * the snuff left over the screen.
 */
export const CandleArrival: React.FC = () => {
    const [lit, setLit] = useState(false);

    // Before paint, so the snuff's dark is swapped for this one with no frame of stage between.
    useLayoutEffect(() => {
        if (!takeSnuffArrival()) return;

        setLit(true);
        const timer = window.setTimeout(() => setLit(false), HELD_MS);

        return () => window.clearTimeout(timer);
    }, []);

    if (!lit) return null;

    return (
        <div className={classes.dark} aria-hidden>
            <span className={classes.flame} />
        </div>
    );
};
