"use client";

import { useEffect, useRef, useState } from "react";
import { ActionIcon, Button, Group, Popover, Text, type ActionIconProps } from "@mantine/core";

import { Glyph } from "./media/Glyph";

import classes from "./SkipButton.module.scss";

/**
 * One of the player's two jumps, and the place its length is chosen (§14b).
 *
 * A press jumps. Holding it -- or right-clicking it -- raises a strip of lengths from the button
 * itself, and the one picked is what this button does from then on. On the button rather than in
 * a menu of its own because the bar is full on a phone, and because the thing being changed is
 * right there under the thumb; the cost is that it has to be known about, which the title says.
 */

/** Long enough that a deliberate press never trips it; short enough not to feel like waiting. */
const HOLD_MS = 500;

/**
 * An arrow turning around the number of seconds it jumps by.
 *
 * The number is centred on the arc's own circle, (12, 13.25), rather than on a baseline guessed
 * for "10" -- which is how the old glyph's digits sat half a unit right and low. The baseline is
 * the centre plus half a digit's height (about 0.36 em), set explicitly rather than with
 * `dominant-baseline`, which browsers do not agree on. One digit gets a slightly larger size,
 * which two would not fit.
 */
const CENTRE_Y = 13.25;
const fontSize = (seconds: number): number => (seconds < 10 ? 8.5 : 7.5);

const SkipGlyph: React.FC<{ direction: "back" | "forward"; seconds: number }> = ({
    direction,
    seconds,
}) => (
    <Glyph>
        {direction === "back" ? (
            <>
                <path d="M5.5 9.5A7.5 7.5 0 1 1 4.5 13" />
                <path d="M5.5 5v4.5H10" />
            </>
        ) : (
            <>
                <path d="M18.5 9.5A7.5 7.5 0 1 0 19.5 13" />
                <path d="M18.5 5v4.5H14" />
            </>
        )}
        <text
            x="12"
            y={CENTRE_Y + 0.36 * fontSize(seconds)}
            textAnchor="middle"
            fontSize={fontSize(seconds)}
            fontWeight="600"
            fill="currentColor"
            stroke="none"
        >
            {seconds}
        </text>
    </Glyph>
);

interface SkipButtonProps<T extends number> {
    direction: "back" | "forward";
    seconds: T;
    choices: readonly T[];
    onChoose: (seconds: T) => void;
    onSkip: () => void;
    /** The key that does the same jump, for the label. */
    hotkey: string;
    size: ActionIconProps["size"];
    coarse: boolean;
}

export const SkipButton = <T extends number>({
    direction,
    seconds,
    choices,
    onChoose,
    onSkip,
    hotkey,
    size,
    coarse,
}: SkipButtonProps<T>): React.ReactElement => {
    const [choosing, setChoosing] = useState(false);
    const holdRef = useRef<number | null>(null);
    /**
     * The press that opened the chooser, so letting go of it is not also a jump. Cleared on the
     * next press rather than by the click that follows, because a long-press on Android fires
     * `contextmenu` and then no click at all -- and a flag left standing would eat the next tap.
     */
    const heldRef = useRef(false);

    const cancelHold = () => {
        if (holdRef.current !== null) {
            window.clearTimeout(holdRef.current);
            holdRef.current = null;
        }
    };

    useEffect(() => cancelHold, []);

    const choose = () => {
        cancelHold();
        heldRef.current = true;
        setChoosing(true);
    };

    const word = direction === "back" ? "Back" : "Forward";
    const label = `${word} ${seconds} seconds (${hotkey}). Hold to change`;

    return (
        <Popover
            opened={choosing}
            onChange={setChoosing}
            position="top"
            withArrow
            withinPortal
            shadow="md"
        >
            <Popover.Target>
                <ActionIcon
                    variant="subtle"
                    color="brass"
                    size={size}
                    className={classes.skip}
                    onPointerDown={(event) => {
                        heldRef.current = false;
                        if (event.button !== 0) return;
                        cancelHold();
                        holdRef.current = window.setTimeout(choose, HOLD_MS);
                    }}
                    onPointerUp={cancelHold}
                    onPointerLeave={cancelHold}
                    onPointerCancel={cancelHold}
                    onContextMenu={(event) => {
                        event.preventDefault();
                        choose();
                    }}
                    onClick={() => {
                        if (heldRef.current) {
                            heldRef.current = false;

                            return;
                        }

                        onSkip();
                    }}
                    aria-label={label}
                    title={label}
                >
                    <SkipGlyph direction={direction} seconds={seconds} />
                </ActionIcon>
            </Popover.Target>
            <Popover.Dropdown p={6}>
                <Text size="xs" c="dimmed" px={4} pb={4}>
                    {word} by
                </Text>
                <Group gap={2} wrap="nowrap" role="radiogroup" aria-label={`${word} by`}>
                    {choices.map((choice) => (
                        <Button
                            key={choice}
                            role="radio"
                            aria-checked={choice === seconds}
                            variant={choice === seconds ? "filled" : "subtle"}
                            color="brass"
                            size="compact-sm"
                            h={coarse ? 44 : undefined}
                            miw={coarse ? 44 : 36}
                            px={6}
                            onClick={() => {
                                onChoose(choice);
                                setChoosing(false);
                            }}
                        >
                            {choice}s
                        </Button>
                    ))}
                </Group>
            </Popover.Dropdown>
        </Popover>
    );
};
