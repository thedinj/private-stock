"use client";

import { ActionIcon, Box, Kbd, Tooltip, type ActionIconProps } from "@mantine/core";

import { Burst } from "@/components/media/Burst";

import classes from "./FavoriteToggle.module.scss";

/**
 * The heart: one person's favourite mark, on an item or a tag (§6, §6 "Favourite tags").
 *
 * One component so the two cannot drift into two hearts. Oxblood rather than brass for
 * `MediaTile`'s reason -- a brass mark reads as a rating -- and a glyph rather than an icon,
 * like every other mark in the cellar.
 *
 * **Controlled**, as `RatingControl` is: it says what was clicked, and the caller saves and
 * passes back what to show, optimistic value included. `burstKey` plays the celebration; a new
 * key plays it again.
 */

interface FavoriteToggleProps {
    /** What to show: the caller's optimistic value, not merely what is stored. */
    favorite: boolean;
    onToggle: () => void;
    /** The celebration in progress, if any. */
    burstKey: number | null;
    /** Names the `H` key in the tooltip -- only where the page actually binds it. */
    shortcut?: boolean;
    size?: ActionIconProps["size"];
    /** What is being favourited, for a screen reader on a page of many hearts. */
    subject?: string;
}

export const FavoriteToggle: React.FC<FavoriteToggleProps> = ({
    favorite,
    onToggle,
    burstKey,
    shortcut = false,
    size = "input-sm",
    subject,
}) => {
    const action = favorite ? "Remove from favourites" : "Add to favourites";
    const label = subject ? `${action}: ${subject}` : action;

    return (
        // A wrapper for the burst, because the icon clips what overflows it.
        <Box component="span" className={classes.anchor}>
            <Tooltip
                label={
                    <>
                        {action}
                        {shortcut && (
                            <>
                                {" "}
                                <Kbd size="xs">H</Kbd>
                            </>
                        )}
                    </>
                }
            >
                <ActionIcon
                    variant="subtle"
                    color={favorite ? "oxblood" : "gray"}
                    size={size}
                    aria-label={label}
                    aria-pressed={favorite}
                    aria-keyshortcuts={shortcut ? "h" : undefined}
                    onClick={onToggle}
                >
                    {/* Keyed by the celebration so a new favourite beats again rather than
                        reusing the span. */}
                    <span
                        key={burstKey ?? "still"}
                        className={burstKey !== null ? classes.beat : undefined}
                    >
                        {favorite ? "♥" : "♡"}
                    </span>
                </ActionIcon>
            </Tooltip>
            {burstKey !== null && <Burst key={burstKey} glyph="♥" reach="2.5rem" />}
        </Box>
    );
};
