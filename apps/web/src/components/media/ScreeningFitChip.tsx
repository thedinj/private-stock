"use client";

import { Button } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import { FitsGlyph } from "@/components/media/Glyph";

interface Props {
    /** Whether the room's screenings keep to what fits (`useScreeningFit`). */
    fit: boolean;
    onToggle: () => void;
}

/**
 * "Fits", on the player's bar during a private screening (§14h).
 *
 * Here rather than in a setting because this is where the bars down the sides are noticed. A
 * tap changes the room's choice and puts the matching set behind the video on screen -- which
 * plays on if it suits the new set, and is moved on from only if it is the wrong way up for it.
 *
 * The icon is the screen as it is held, so it says what "fits" is measured against without
 * the tooltip a phone cannot show.
 */
export const ScreeningFitChip: React.FC<Props> = ({ fit, onToggle }) => {
    const coarse = useMediaQuery("(pointer: coarse)") ?? false;
    const portrait = useMediaQuery("(orientation: portrait)") ?? false;

    return (
        <Button
            variant={fit ? "light" : "subtle"}
            color={fit ? "brass" : "gray"}
            size="compact-sm"
            // A touch target at the size every other control on a phone's bar is.
            h={coarse ? 44 : undefined}
            leftSection={<FitsGlyph size={18} portrait={portrait} on={fit} />}
            onClick={onToggle}
            aria-pressed={fit}
            title={
                fit
                    ? "Only videos that fill the screen as it is held. Tap for all of them."
                    : "All videos. Tap for only those that fill the screen as it is held."
            }
        >
            Fits
        </Button>
    );
};
