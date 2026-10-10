"use client";

import { useState } from "react";
import { Anchor, Popover } from "@mantine/core";

import type { FaceReviewFace } from "@private-stock/core";

import { useCloseOnBack } from "@/lib/useCloseOnBack";

import { FacePeek } from "./FacePeek";
import type { TickState } from "./faceControls";

/**
 * "Look" (§5f "A person in a video"): the frame a face was found in, the same person's other
 * moments, and "Play it here", in a popover over the list. Back closes it; so does a tap anywhere
 * in it but a control.
 */
export const LookButton: React.FC<{
    face: FaceReviewFace;
    others: FaceReviewFace[];
    /** The closer look's them / not them / unsure, where those are what is being said. */
    peekState?: { state: TickState; threeWay: boolean; onSet: (state: TickState) => void };
    onPlay: (face: FaceReviewFace) => void;
}> = ({ face, others, peekState, onPlay }) => {
    const [peeking, setPeeking] = useState(false);

    useCloseOnBack(peeking, () => setPeeking(false));

    return (
        <Popover
            opened={peeking}
            onChange={setPeeking}
            position="bottom"
            withArrow
            shadow="md"
            withinPortal
        >
            <Popover.Target>
                <Anchor
                    component="button"
                    type="button"
                    size="xs"
                    c="dimmed"
                    onClick={() => setPeeking((open) => !open)}
                    style={{ minHeight: 44, minWidth: 44 }}
                >
                    Look
                </Anchor>
            </Popover.Target>
            <Popover.Dropdown
                onClick={(event) => {
                    // A tap on the picture, or anywhere but a control, closes it.
                    if (
                        !(event.target as Element).closest(
                            "button, a, input, label, [role='radiogroup']"
                        )
                    ) {
                        setPeeking(false);
                    }
                }}
            >
                <FacePeek
                    others={others}
                    face={face}
                    state={peekState?.state}
                    threeWay={peekState?.threeWay ?? false}
                    onSet={peekState?.onSet}
                    onPlay={() => {
                        setPeeking(false);
                        onPlay(face);
                    }}
                />
            </Popover.Dropdown>
        </Popover>
    );
};
