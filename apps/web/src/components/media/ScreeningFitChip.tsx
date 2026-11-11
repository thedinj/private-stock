"use client";

import { useState } from "react";
import { Button } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import { FitsGlyph } from "@/components/media/Glyph";
import { readScreeningFit, useScreening, writeScreeningFit } from "@/lib/privateScreening";

/**
 * "Fits", on the player's bar during a private screening (§14h).
 *
 * Here rather than in a setting because this is where the bars down the sides are noticed. A
 * tap changes the room's choice and deals again under it, so the answer is seen at once; a
 * room whose videos are all one way up never gives anyone a reason to touch it.
 *
 * The icon is the screen as it is held, so it says what "fits" is measured against without
 * the tooltip a phone cannot show.
 */
export const ScreeningFitChip: React.FC = () => {
    const deal = useScreening();
    const [fit, setFit] = useState(readScreeningFit);
    const coarse = useMediaQuery("(pointer: coarse)") ?? false;
    const portrait = useMediaQuery("(orientation: portrait)") ?? false;

    const toggle = () => {
        const next = !fit;

        setFit(next);
        writeScreeningFit(next);
        deal(next);
    };

    return (
        <Button
            variant={fit ? "light" : "subtle"}
            color={fit ? "brass" : "gray"}
            size="compact-sm"
            // A touch target at the size every other control on a phone's bar is.
            h={coarse ? 44 : undefined}
            leftSection={<FitsGlyph size={18} portrait={portrait} on={fit} />}
            onClick={toggle}
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
