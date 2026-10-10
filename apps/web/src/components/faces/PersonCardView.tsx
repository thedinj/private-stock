"use client";

import { useState } from "react";
import { Anchor, Box, Group, Paper, Popover, Stack, Text, UnstyledButton } from "@mantine/core";

import type { FaceReviewFace } from "@private-stock/core";

import { useCloseOnBack } from "@/lib/useCloseOnBack";

import { FaceCropView } from "./FaceCropView";
import { FacePeek } from "./FacePeek";
import type { TickState } from "./faceControls";

/**
 * One person in one item, as every face surface shows them (§5f "A person in a video"): their
 * clearest face, a mark saying what is being said of them, a caption, and "Look" — the frame and
 * their other moments, and "Play it here". A press on the face changes what is said; one already
 * saved shows what it became and takes no press. Fixed in size, so nothing around it moves.
 */

export interface CardMark {
    symbol: string;
    color: string;
    ink: string;
}

export const MARKS = {
    them: { symbol: "✓", color: "var(--mantine-color-brass-6)", ink: "var(--mantine-color-white)" },
    notThem: {
        symbol: "✕",
        color: "var(--mantine-color-dark-4)",
        ink: "var(--mantine-color-white)",
    },
    unsure: {
        symbol: "?",
        color: "var(--mantine-color-yellow-5)",
        ink: "var(--mantine-color-black)",
    },
    open: { symbol: "", color: "transparent", ink: "transparent" },
} satisfies Record<string, CardMark>;

export const PersonCardView: React.FC<{
    face: FaceReviewFace;
    others: FaceReviewFace[];
    size: number;
    mark: CardMark;
    /** How it is drawn: chosen (outlined), unsure (dashed), passed over (faded and grey). */
    look: "chosen" | "unsure" | "plain" | "faded";
    caption: string;
    label: string;
    /** What a press does; none once saved. */
    onPress?: () => void;
    /** The closer look's them / not them / unsure, where those are what is being said. */
    peekState?: { state: TickState; threeWay: boolean; onSet: (state: TickState) => void };
    onPlay: (face: FaceReviewFace) => void;
}> = ({ face, others, size, mark, look, caption, label, onPress, peekState, onPlay }) => {
    const [peeking, setPeeking] = useState(false);

    useCloseOnBack(peeking, () => setPeeking(false));

    return (
        <Paper withBorder radius="md" p={4} style={{ opacity: onPress ? 1 : 0.5 }}>
            <Stack gap={0} align="center">
                <UnstyledButton
                    disabled={!onPress}
                    onClick={onPress}
                    aria-label={label}
                    style={{
                        position: "relative",
                        borderRadius: 8,
                        padding: 2,
                        outline:
                            look === "chosen"
                                ? "2px solid var(--mantine-color-brass-6)"
                                : look === "unsure"
                                  ? "2px dashed var(--mantine-color-yellow-6)"
                                  : "2px solid transparent",
                        touchAction: "manipulation",
                    }}
                >
                    <Box
                        style={{
                            opacity: look === "faded" ? 0.3 : look === "unsure" ? 0.65 : 1,
                            filter: look === "faded" ? "grayscale(1)" : undefined,
                        }}
                    >
                        <FaceCropView crop={face.crop} size={size} />
                    </Box>
                    {mark.symbol && (
                        <Box
                            aria-hidden
                            style={{
                                position: "absolute",
                                right: 6,
                                top: 6,
                                width: 24,
                                height: 24,
                                borderRadius: 12,
                                display: "grid",
                                placeItems: "center",
                                fontSize: 13,
                                fontWeight: 700,
                                color: mark.ink,
                                background: mark.color,
                            }}
                        >
                            {mark.symbol}
                        </Box>
                    )}
                </UnstyledButton>
                <Group gap={4} justify="space-between" w="100%" px={4} h={44} wrap="nowrap">
                    <Text size="xs" c="dimmed" truncate>
                        {caption}
                    </Text>
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
                </Group>
            </Stack>
        </Paper>
    );
};
