"use client";

import { useLayoutEffect, useState } from "react";

import { DURATION } from "@/lib/motion";
import { takeSnuffArrival } from "@/lib/candleSnuff";

import classes from "./CandleArrival.module.scss";

/** The flame's breath plus the lift, after which the dark is taken out of the page. */
export const CANDLE_HELD_MS = 900 + DURATION.arrive;

/**
 * The dark with a candle in it, lifting after a breath. Also the cellar's way in: the gate goes
 * to black when the PIN is right and the room comes up out of this (§21).
 */
export const CandleDark: React.FC = () => (
    <div className={classes.dark} aria-hidden>
        <span className={classes.flame} />
    </div>
);

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
        const timer = window.setTimeout(() => setLit(false), CANDLE_HELD_MS);

        return () => window.clearTimeout(timer);
    }, []);

    if (!lit) return null;

    return <CandleDark />;
};
