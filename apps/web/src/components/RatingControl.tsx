"use client";

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
 * (`StageFlash`), and passes back what to show here, optimistic values included. A star that
 * waits for the server before filling in gets clicked twice, and the second click clears it.
 *
 * **The tooltips name the keys** (§14b), because nothing else on screen does: the number pad
 * rates and `h` favourites, and a shortcut nobody is told about is one only its author uses.
 * Slow to open on the stars, which are hovered on the way to clicking one.
 *
 * **Five stars and a new favourite burst from here too** (see `Burst`), however they were
 * given, for whoever is looking at this row rather than at the picture.
 */

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
                    // Clicking the star you already gave clears the rating, which is the only
                    // way to take one back — Mantine reports that as the same value, so it is
                    // translated to null here rather than written as a no-op. The number keys
                    // follow the identical rule, from the identical function.
                    onChange={(value) => onChange({ rating: ratingAfterPressing(value, rating) })}
                />
            </Tooltip>

            {/* Beside the stars rather than inside them: Mantine's Rating owns its children.
                Pulled back over the fifth star, which is where the praise came from. */}
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
