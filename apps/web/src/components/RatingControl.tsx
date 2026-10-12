"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Group, Kbd, Rating, Tooltip } from "@mantine/core";

import { FavoriteToggle } from "@/components/FavoriteToggle";
import { Burst } from "@/components/media/Burst";
import type { StageFlashMessage } from "@/components/media/StageFlash";
import { ratingAfterPressing, type UserMediaPatch } from "@/lib/api/userMedia";

import classes from "./RatingControl.module.scss";

/**
 * This viewer's rating and favourite mark for one item (§6).
 *
 * **Controlled: it says what was clicked, and the page does the rest.** It used to hold its own
 * mutation, beside the page's for the keys, so a click and a keypress were two paths that had to
 * be kept agreeing -- the optimistic display, the celebration over the picture, which request
 * was the latest. One path now: the page saves, shows the answer over the picture
 * (`StageFlash`), and passes back what to show here, optimistic values included. A glass that
 * waits for the server before filling in gets clicked twice, and the second click clears it.
 *
 * **The tooltips name the keys** (§14b), because nothing else on screen does: the number pad
 * rates and `h` favourites, and a shortcut nobody is told about is one only its author uses.
 * Slow to open on the glasses, which are hovered on the way to clicking one.
 *
 * **Five glasses and a new favourite burst from here too** (see `Burst`), however they were
 * given, for whoever is looking at this row rather than at the picture.
 *
 * **Glasses, not stars, and they pour** (§14, "Motion"). A cellar rates by the glass: choosing
 * four fills the first four in turn, from the one already full to the one you chose, and
 * lowering a rating simply leaves the rest empty. Mantine swaps a symbol in when it becomes
 * full -- on hover too, so pointing at the fourth glass pours a preview -- and the pour is a
 * CSS animation on that symbol's mount, so it plays once per glass filled and never again while
 * the pointer moves within one.
 */

/** How long after its neighbour each glass starts to fill. */
const POUR_STEP_MS = 110;

/**
 * One glass: bowl, stem and foot. The full one carries the wine, clipped to the bowl, which
 * rises into it on mount after `delayMs`. The clip's id is per value, since five full glasses
 * share a page with each other and nothing else draws one.
 */
const Glass: React.FC<{ full: boolean; value: number; delayMs?: number }> = ({
    full,
    value,
    delayMs = 0,
}) => (
    <svg
        className={full ? classes.glassFull : classes.glassEmpty}
        viewBox="0 0 24 24"
        aria-hidden
        focusable="false"
    >
        {full && (
            <>
                <defs>
                    <clipPath id={`rating-bowl-${value}`}>
                        <path d="M6 3h12c0 5.6-2.7 9.2-6 9.2S6 8.6 6 3Z" />
                    </clipPath>
                </defs>
                <g clipPath={`url(#rating-bowl-${value})`}>
                    <rect
                        className={classes.wine}
                        x="5"
                        y="6.2"
                        width="14"
                        height="7"
                        style={{ animationDelay: `${delayMs}ms` }}
                    />
                </g>
            </>
        )}
        <path
            className={classes.outline}
            d="M6 3h12c0 5.6-2.7 9.2-6 9.2S6 8.6 6 3Z M12 12.2V20 M8 20.8h8"
        />
    </svg>
);

interface RatingControlProps {
    /** What to show: the page's optimistic values, not merely what is stored. */
    rating: number | null;
    favorite: boolean;
    onChange: (patch: UserMediaPatch) => void;
    /** The celebration in progress, if any; a new `key` plays it again. */
    celebration: StageFlashMessage | null;
}

export const RatingControl: React.FC<RatingControlProps> = ({
    rating,
    favorite,
    onChange,
    celebration,
}) => {
    const starBurst = celebration?.subject === "rating" ? celebration.key : null;
    const heartBurst = celebration?.subject === "favorite" ? celebration.key : null;

    /**
     * Where the pour starts: the level the glasses showed before this render, hovered or
     * given. A glass that becomes full waits one step for each glass between it and that
     * level, so pointing from three to four fills the fourth at once rather than after three
     * steps of nothing.
     */
    const [hovered, setHovered] = useState(-1);
    const shown = hovered > 0 ? hovered : (rating ?? 0);
    const shownBefore = useRef(shown);
    const pourFrom = shownBefore.current;
    useEffect(() => {
        shownBefore.current = shown;
    }, [shown]);

    return (
        <Group gap="xs" wrap="nowrap">
            <Tooltip
                label={
                    <>
                        <Kbd size="xs">Numpad 1</Kbd>–<Kbd size="xs">5</Kbd> · the same again clears
                        it
                    </>
                }
                openDelay={600}
            >
                <Rating
                    value={rating ?? 0}
                    color="brass"
                    emptySymbol={(value) => <Glass full={false} value={value} />}
                    fullSymbol={(value) => (
                        <Glass
                            full
                            value={value}
                            delayMs={Math.max(0, value - pourFrom - 1) * POUR_STEP_MS}
                        />
                    )}
                    onHover={setHovered}
                    // Clicking the glass you already gave clears the rating, which is the only
                    // way to take one back — Mantine reports that as the same value, so it is
                    // translated to null here rather than written as a no-op. The number keys
                    // follow the identical rule, from the identical function.
                    onChange={(value) => onChange({ rating: ratingAfterPressing(value, rating) })}
                />
            </Tooltip>

            {/* Beside the glasses rather than inside them: Mantine's Rating owns its children.
                Pulled back over the fifth glass, which is where the praise came from. */}
            {starBurst !== null && (
                <Box component="span" className={classes.starAnchor}>
                    <Burst key={starBurst} glyph="★" reach="2.75rem" />
                </Box>
            )}

            <FavoriteToggle
                favorite={favorite}
                onToggle={() => onChange({ favorite: !favorite })}
                burstKey={heartBurst}
                shortcut
            />
        </Group>
    );
};
