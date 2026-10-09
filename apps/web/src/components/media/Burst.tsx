"use client";

import { Box } from "@mantine/core";

import classes from "./Burst.module.scss";

/**
 * A spray of glyphs from the centre of whatever it is mounted in (§14b).
 *
 * For the two verdicts worth making a fuss of: five stars, and a new favourite. Everything
 * else a person tells the library is recorded quietly; those two are the ones somebody would
 * say out loud, and the page should say it back.
 *
 * Pure CSS and fire-and-forget: mount it (keyed, so a repeat remounts) and it plays once and
 * leaves nothing that takes the pointer. The spread is a fixed table rather than random, so
 * it renders the same on the server and the client and every burst reads as one gesture
 * rather than noise. Under reduced motion it renders nothing at all.
 */

/** Degrees, distance as a multiple of `--burst-reach`, delay in ms, scale. */
const SPARKS: [number, number, number, number][] = [
    [-90, 1, 0, 1.1],
    [-58, 0.8, 40, 0.8],
    [-22, 1.05, 10, 1],
    [12, 0.75, 60, 0.7],
    [40, 0.95, 20, 0.9],
    [74, 0.7, 70, 0.75],
    [106, 0.9, 30, 0.85],
    [140, 0.75, 50, 0.7],
    [172, 1, 15, 1],
    [204, 0.8, 65, 0.8],
    [236, 1.05, 5, 0.95],
    [266, 0.7, 45, 0.75],
];

interface BurstProps {
    glyph: "★" | "♥";
    /** How far the sparks fly. The stage's burst is wider than a button's. */
    reach?: string;
}

export const Burst: React.FC<BurstProps> = ({ glyph, reach = "3rem" }) => (
    <Box
        component="span"
        className={classes.burst}
        data-glyph={glyph === "♥" ? "heart" : "star"}
        __vars={{ "--burst-reach": reach }}
        aria-hidden
    >
        {SPARKS.map(([angle, distance, delay, scale]) => (
            <Box
                key={angle}
                component="span"
                className={classes.spark}
                __vars={{
                    "--spark-angle": `${angle}deg`,
                    "--spark-distance": String(distance),
                    "--spark-delay": `${delay}ms`,
                    "--spark-scale": String(scale),
                }}
            >
                {glyph}
            </Box>
        ))}
    </Box>
);
