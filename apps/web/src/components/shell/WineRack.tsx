"use client";

import { useEffect, useRef, useState } from "react";
import { UnstyledButton } from "@mantine/core";

import { RACK_DIGITS, vintageOf } from "@/lib/pinDigits";

import classes from "./WineRack.module.scss";

/** How long the lever takes to come down before the try is made: the hand, then the answer. */
const LEVER_MS = 260;

/** A drag across the rack this wide, in pixels, pushes every bottle back. */
const SWIPE_PX = 70;

interface WineRackProps {
    /** How many digits are in: one cork on the ledge for each. */
    count: number;
    onDigit: (digit: string) => void;
    onBack: () => void;
    onClear: () => void;
    onTry: () => void;
    disabled?: boolean;
    /** The one thing the rack ever says: the last-try warning, or that the server is away. */
    note?: string | null;
    label: string;
    /**
     * Hear the keyboard from anywhere on the page, not only while the rack has focus. For the
     * cellar's gate, which is the whole screen; a rack inside a form leaves it off.
     */
    captureKeys?: boolean;
    autoFocus?: boolean;
}

interface KeyActions {
    pull: (digit: string) => void;
    onBack: () => void;
    onClear: () => void;
    turnLever: () => void;
    disabled: boolean;
}

/** What a key does on the rack; false when it is not the rack's key. */
const actOnKey = (key: string, actions: KeyActions): boolean => {
    if (actions.disabled) return false;

    if (/^\d$/.test(key)) actions.pull(key);
    else if (key === "Backspace") actions.onBack();
    else if (key === "Escape") actions.onClear();
    else if (key === "Enter") actions.turnLever();
    else return false;

    return true;
};

/**
 * The cellar's wine rack (§21 "Getting into the cellar"): a PIN entered by pulling bottles.
 *
 * Laid out as the keypad is, three rows of three and the nought below, and each bottle's tag is a
 * vintage whose last figure is its digit. **A tugged bottle springs back.** A PIN can repeat a
 * digit, so a bottle cannot simply stay out; what records the entry is a cork on the ledge for
 * each digit, and the corks are all alike, so a look over the shoulder learns how many but not
 * which. Tap the ledge to take one back; swipe across the rack (or Escape) to push them all back.
 *
 * The lever under the rack tries the PIN, since four to eight digits means the rack cannot tell
 * on its own when you have finished. Digits, Backspace, Escape and Enter work from a keyboard.
 */
export const WineRack: React.FC<WineRackProps> = ({
    count,
    onDigit,
    onBack,
    onClear,
    onTry,
    disabled = false,
    note = null,
    label,
    captureKeys = false,
    autoFocus = false,
}) => {
    /** Tugs per bottle: the count keys the bottle, so each tug replays its animation. */
    const [tugs, setTugs] = useState<Record<string, number>>({});
    const [leverDown, setLeverDown] = useState(false);
    const rackRef = useRef<HTMLDivElement>(null);
    const swipeFrom = useRef<number | null>(null);
    const timers = useRef<number[]>([]);

    useEffect(() => {
        const pending = timers.current;

        return () => pending.forEach((timer) => window.clearTimeout(timer));
    }, []);

    useEffect(() => {
        if (autoFocus) rackRef.current?.focus();
    }, [autoFocus]);

    const pull = (digit: string) => {
        if (disabled) return;

        setTugs((current) => ({ ...current, [digit]: (current[digit] ?? 0) + 1 }));
        onDigit(digit);
    };

    const turnLever = () => {
        if (disabled || leverDown) return;

        setLeverDown(true);
        timers.current.push(
            window.setTimeout(onTry, LEVER_MS),
            window.setTimeout(() => setLeverDown(false), LEVER_MS * 2)
        );
    };

    // Held in a ref so the window listener is added once and still calls the latest props.
    const keyActions = useRef<KeyActions>({ pull, onBack, onClear, turnLever, disabled });
    keyActions.current = { pull, onBack, onClear, turnLever, disabled };

    useEffect(() => {
        if (!captureKeys) return;

        const listener = (event: KeyboardEvent) => {
            if (actOnKey(event.key, keyActions.current)) event.preventDefault();
        };

        window.addEventListener("keydown", listener, { capture: true });

        return () => window.removeEventListener("keydown", listener, { capture: true });
    }, [captureKeys]);

    return (
        <div
            ref={rackRef}
            className={classes.rack}
            role="group"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={
                captureKeys
                    ? undefined
                    : (event) => {
                          if (actOnKey(event.key, keyActions.current)) event.preventDefault();
                      }
            }
            onPointerDown={(event) => {
                swipeFrom.current = event.clientX;
            }}
            onPointerUp={(event) => {
                if (
                    swipeFrom.current !== null &&
                    Math.abs(event.clientX - swipeFrom.current) > SWIPE_PX
                ) {
                    onClear();
                }
                swipeFrom.current = null;
            }}
        >
            <div className={classes.cells}>
                {RACK_DIGITS.map((digit) => (
                    <UnstyledButton
                        key={digit}
                        className={classes.cubby}
                        data-zero={digit === "0" || undefined}
                        onClick={() => pull(digit)}
                        disabled={disabled}
                        aria-label={digit}
                    >
                        <span
                            key={tugs[digit] ?? 0}
                            className={classes.bottle}
                            data-tugged={tugs[digit] ? true : undefined}
                        />
                        <span className={classes.tag} aria-hidden>
                            {vintageOf(digit)}
                        </span>
                    </UnstyledButton>
                ))}
            </div>

            <UnstyledButton
                className={classes.ledge}
                onClick={onBack}
                disabled={disabled || count === 0}
                aria-label={`${count} ${count === 1 ? "cork" : "corks"}. Take one back`}
            >
                {Array.from({ length: count }, (_, index) => (
                    <span key={index} className={classes.cork} />
                ))}
            </UnstyledButton>

            <div className={classes.foot}>
                <UnstyledButton
                    className={classes.lever}
                    data-down={leverDown || undefined}
                    onClick={turnLever}
                    disabled={disabled}
                    aria-label="Try"
                />
            </div>

            <p className={classes.note} role="status">
                {note}
            </p>
        </div>
    );
};
