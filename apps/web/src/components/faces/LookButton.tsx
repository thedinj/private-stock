"use client";

import { useState } from "react";
import { Anchor, Popover, UnstyledButton } from "@mantine/core";

import type { FaceReviewFace } from "@private-stock/core";

import { useCloseOnBack } from "@/lib/useCloseOnBack";

import { FacePeek } from "./FacePeek";
import type { TickState } from "./faceControls";

/**
 * "Look" (§5f "A person in a video"): the frame a face was found in, its file, the same person's
 * other moments, the performer they may be from other items, and "Play it here", in a popover over the list. Back closes it; so does a tap anywhere
 * in it but a control.
 */
export const LookButton: React.FC<{
    face: FaceReviewFace;
    others: FaceReviewFace[];
    /** The closer look's them / not them / unsure, where those are what is being said. */
    peekState?: { state: TickState; threeWay: boolean; onSet: (state: TickState) => void };
    onPlay: (face: FaceReviewFace) => void;
    /** The performer it may be: their face from other items is shown to compare. */
    compare?: { tagId: string; name: string };
    /** What opens it, where that is more than the word: a whole card of search results. */
    children?: React.ReactNode;
    label?: string;
}> = ({ face, others, peekState, onPlay, compare, children, label = "Look" }) => {
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
                {children ? (
                    <UnstyledButton
                        aria-label={label}
                        onClick={() => setPeeking((open) => !open)}
                        style={{ minWidth: 0, width: "100%" }}
                    >
                        {children}
                    </UnstyledButton>
                ) : (
                    <Anchor
                        component="button"
                        type="button"
                        size="xs"
                        c="dimmed"
                        onClick={() => setPeeking((open) => !open)}
                        style={{ minHeight: 44, minWidth: 44 }}
                    >
                        {label}
                    </Anchor>
                )}
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
                    compare={compare}
                    onPlay={() => {
                        setPeeking(false);
                        onPlay(face);
                    }}
                />
            </Popover.Dropdown>
        </Popover>
    );
};
