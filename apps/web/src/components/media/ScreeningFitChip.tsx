"use client";

import { useState } from "react";
import { Chip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import { readScreeningFit, useScreening, writeScreeningFit } from "@/lib/privateScreening";

/**
 * "This way up", on the player's bar during a private screening (§14h).
 *
 * Here rather than in a setting because this is where the bars down the sides are noticed. A
 * tap changes the room's choice and deals again under it, so the answer is seen at once; a
 * room whose videos are all one way up never gives anyone a reason to touch it.
 */
export const ScreeningFitChip: React.FC = () => {
    const deal = useScreening();
    const [fit, setFit] = useState(readScreeningFit);
    const coarse = useMediaQuery("(pointer: coarse)") ?? false;

    const toggle = () => {
        const next = !fit;

        setFit(next);
        writeScreeningFit(next);
        deal(next);
    };

    return (
        <Chip
            size="xs"
            color="brass"
            variant="outline"
            checked={fit}
            onChange={toggle}
            title={
                fit
                    ? "Only videos that fill the screen as it is held. Tap for all of them."
                    : "All videos. Tap for only those that fill the screen as it is held."
            }
            // A touch target at the size every other control on a phone's bar is.
            styles={coarse ? { label: { height: 44 } } : undefined}
        >
            This way up
        </Chip>
    );
};
