"use client";

import { useEffect, useId, useRef, useState } from "react";
import { UnstyledButton } from "@mantine/core";

import { prefersReducedMotion } from "@/lib/motion";
import { vintageOf } from "@/lib/pinDigits";

import classes from "./WineRack.module.scss";
import { BOTTLE_SIZE, BOTTLES, RACK_SIZE, TAGS } from "./wineRackLayout";

/** How long the ring takes to press home: long enough to be a deliberate act, not a tap. */
const HOLD_MS = 650;

/** How long a released ring takes to lift off again, from fully pressed. */
const LIFT_MS = 260;

/** How long a pressed seal stays before the wax smooths, once nothing is waiting on the answer. */
const SET_MS = 700;

/** A drag across the rack this wide, in pixels, pushes every bottle back. */
const SWIPE_PX = 70;

/**
 * A damped spring's push and return, sampled: out toward you, a little past home, settling.
 *
 * The Web Animations API has no spring easing, so the curve is the keyframes. Normalised to a peak
 * of 1, and computed once: every bottle springs the same way, which is what a spring does.
 */
const SPRING = (() => {
    const samples = 36;
    const seconds = 0.9;
    const w = 2 * Math.PI * 1.5;
    const damping = 0.36;
    const wd = w * Math.sqrt(1 - damping * damping);
    const raw = Array.from({ length: samples + 1 }, (_, i) => {
        const t = (i / samples) * seconds;

        return Math.exp(-damping * w * t) * Math.sin(wd * t);
    });
    const peak = Math.max(...raw);

    return raw.map((v) => v / peak);
})();

const tug = (bottle: HTMLElement | null) => {
    if (!bottle || prefersReducedMotion() || typeof bottle.animate !== "function") return;

    bottle.animate(
        SPRING.map((v) => ({
            transform: `translateY(${-v * 3}px) scale(${1 + v * 0.14})`,
            filter: `drop-shadow(0 ${2 + v * 10}px ${3 + v * 9}px rgba(0, 0, 0, ${0.55 + v * 0.3}))`,
        })),
        { duration: 900, easing: "linear" }
    );
};

/** Pressing, pressed and waiting for the answer, smoothing back, or opened. */
type SealState = "idle" | "set" | "smoothing" | "open";

interface WineRackProps {
    /** How many digits are in: one cork on the ledge for each. */
    count: number;
    onDigit: (digit: string) => void;
    onBack: () => void;
    onClear: () => void;
    /** The seal was pressed home. */
    onTry: () => void;
    /** The PIN was right: the seal splits. Until then a pressed seal smooths back once free. */
    opened?: boolean;
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
    pressSeal: () => void;
    disabled: boolean;
}

/** What a key does on the rack; false when it is not the rack's key. */
const actOnKey = (key: string, actions: KeyActions): boolean => {
    if (actions.disabled) return false;

    if (/^\d$/.test(key)) actions.pull(key);
    else if (key === "Backspace") actions.onBack();
    else if (key === "Escape") actions.onClear();
    else if (key === "Enter") actions.pressSeal();
    else return false;

    return true;
};

/**
 * The cellar's wine rack (§21 "Getting into the cellar"): a PIN entered by pulling bottles, and
 * tried by pressing a seal.
 *
 * Oak cubbies in the keypad's layout with the bottles lying neck out, each tagged with a vintage
 * whose last figure is its digit. The rack and its bottles are pictures (`public/cellar/`, drawn
 * by `scripts/wineRackArt.html`): matte oak with its grain, foil and wax capsules at a bottle's
 * true scale, dust on what faces up -- CSS gradients made it a shiny, geometric diagram of a rack.
 *
 * **A tugged bottle springs back**, since a PIN can repeat a digit; a cork on the ledge records
 * each digit, and the corks are all alike, so a look over the shoulder learns how many but not
 * which. Tap the ledge to take one back; swipe across the rack (or Escape) to push them all back.
 *
 * **Hold the signet ring into the wax to try** -- four to eight digits means the rack cannot tell
 * on its own when you have finished, and a hold is not something a stray tap does. Let go early
 * and the ring lifts away. Pressed home, the seal holds its impression until the answer: a right
 * PIN splits it (`opened`), anything else smooths the wax flat again. Enter presses it.
 */
export const WineRack: React.FC<WineRackProps> = ({
    count,
    onDigit,
    onBack,
    onClear,
    onTry,
    opened = false,
    disabled = false,
    note = null,
    label,
    captureKeys = false,
    autoFocus = false,
}) => {
    const rackRef = useRef<HTMLDivElement>(null);
    const bottleRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const swipeFrom = useRef<number | null>(null);

    // SVG ids are document-wide, and `useId`'s colons are not welcome in `url(#…)`.
    const svgId = useId().replace(/:/g, "");
    const sealRef = useRef<HTMLButtonElement>(null);
    const poolRef = useRef<SVGCircleElement>(null);
    const progress = useRef(0);
    const holding = useRef(false);
    const frame = useRef<number | null>(null);
    const [seal, setSeal] = useState<SealState>("idle");
    // The press finishes frames after it started, by which time the digits -- and so the
    // parent's `onTry` -- may have moved on; it calls whichever is current.
    const tryRef = useRef(onTry);
    tryRef.current = onTry;

    useEffect(() => {
        if (autoFocus) rackRef.current?.focus();
    }, [autoFocus]);

    const pull = (digit: string) => {
        if (disabled) return;

        tug(bottleRefs.current[digit] ?? null);
        onDigit(digit);
    };

    /** The ring's height and the wax's spread, straight onto the elements: no render a frame. */
    const paint = () => {
        sealRef.current?.style.setProperty("--press", String(progress.current));
        poolRef.current?.setAttribute("r", String(30 + progress.current * 12));
    };

    const pressedHome = () => {
        holding.current = false;
        frame.current = null;
        setSeal("set");
        tryRef.current();
    };

    const run = () => {
        if (frame.current !== null) return;

        let last = performance.now();
        const reduced = prefersReducedMotion();

        const step = (now: number) => {
            const dt = now - last;
            last = now;
            const delta = holding.current
                ? reduced
                    ? 1
                    : dt / HOLD_MS
                : -(reduced ? 1 : dt / LIFT_MS);
            progress.current = Math.min(1, Math.max(0, progress.current + delta));
            paint();

            if (holding.current && progress.current >= 1) return pressedHome();
            if (!holding.current && progress.current <= 0) {
                frame.current = null;
                return;
            }

            frame.current = requestAnimationFrame(step);
        };

        frame.current = requestAnimationFrame(step);
    };

    const startHold = () => {
        if (disabled || seal !== "idle") return;

        holding.current = true;
        run();
    };

    const endHold = () => {
        if (!holding.current) return;

        holding.current = false;
        run();
    };

    /** Enter: the whole press, as a hold that lasts exactly long enough. */
    const pressSeal = () => {
        startHold();
        window.setTimeout(endHold, HOLD_MS + 80);
    };

    useEffect(
        () => () => {
            if (frame.current !== null) cancelAnimationFrame(frame.current);
        },
        []
    );

    // After the press: split if it opened; otherwise, once nothing is waiting on the answer, let
    // the wax smooth and the ring come back up for another go.
    useEffect(() => {
        if (seal === "set" && opened) {
            setSeal("open");
            return;
        }

        if (seal === "set" && !disabled) {
            const timer = window.setTimeout(() => setSeal("smoothing"), SET_MS);

            return () => window.clearTimeout(timer);
        }

        if (seal === "smoothing") {
            const timer = window.setTimeout(
                () => {
                    progress.current = 1;
                    setSeal("idle");
                    run();
                },
                prefersReducedMotion() ? 0 : 600
            );

            return () => window.clearTimeout(timer);
        }
        // `run` reads refs only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [seal, opened, disabled]);

    // Held in a ref so the window listener is added once and still calls the latest props.
    const keyActions = useRef<KeyActions>({ pull, onBack, onClear, pressSeal, disabled });
    keyActions.current = { pull, onBack, onClear, pressSeal, disabled };

    useEffect(() => {
        if (!captureKeys) return;

        // The rack is the whole screen, so the key is its alone: nothing listening later on
        // `window` (the viewer's Space plays) hears it. `inert` stops focus, not listeners.
        const listener = (event: KeyboardEvent) => {
            event.stopImmediatePropagation();

            if (event.repeat && event.key === "Enter") return;
            if (actOnKey(event.key, keyActions.current)) event.preventDefault();
        };

        window.addEventListener("keydown", listener, { capture: true });

        return () => window.removeEventListener("keydown", listener, { capture: true });
    }, [captureKeys]);

    const pressed = seal === "set" || seal === "open";

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
                          if (event.target !== event.currentTarget && event.key === "Enter") return;
                          if (actOnKey(event.key, keyActions.current)) event.preventDefault();
                      }
            }
        >
            <div
                className={classes.cells}
                style={{ aspectRatio: `${RACK_SIZE.width} / ${RACK_SIZE.height}` }}
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
                {BOTTLES.map((bottle) => (
                    <UnstyledButton
                        key={bottle.digit}
                        ref={(element) => {
                            bottleRefs.current[bottle.digit] = element;
                        }}
                        className={classes.bottle}
                        style={{
                            left: `${bottle.left}%`,
                            top: `${bottle.top}%`,
                            width: `${BOTTLE_SIZE.width}%`,
                            height: `${BOTTLE_SIZE.height}%`,
                            backgroundImage: `url(/cellar/bottle-${bottle.digit}.webp)`,
                        }}
                        onClick={() => pull(bottle.digit)}
                        disabled={disabled}
                        aria-label={bottle.digit}
                    />
                ))}

                {TAGS.map((tag) => (
                    <span key={tag.digit} aria-hidden>
                        <span
                            className={classes.string}
                            style={{
                                left: `${tag.stringLeft}%`,
                                top: `${tag.stringTop}%`,
                                transform: `rotate(${tag.stringTilt}deg)`,
                            }}
                        />
                        <span
                            className={classes.tag}
                            style={{
                                left: `${tag.left}%`,
                                top: `${tag.top}%`,
                                transform: `rotate(${tag.tilt}deg)`,
                            }}
                        >
                            {vintageOf(tag.digit)}
                        </span>
                    </span>
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

            <UnstyledButton
                ref={sealRef}
                className={classes.seal}
                data-state={seal}
                disabled={disabled && seal === "idle"}
                aria-label="Hold to press the seal and try"
                onPointerDown={(event) => {
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    startHold();
                }}
                onPointerUp={endHold}
                onPointerCancel={endHold}
                onKeyDown={(event) => {
                    if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
                        event.preventDefault();
                        event.stopPropagation();
                        startHold();
                    }
                }}
                onKeyUp={(event) => {
                    if (event.key === "Enter" || event.key === " ") endHold();
                }}
                onContextMenu={(event) => event.preventDefault()}
            >
                <svg viewBox="0 0 112 112" aria-hidden className={classes.wax}>
                    <defs>
                        <filter id={`${svgId}-edge`} x="-20%" y="-20%" width="140%" height="140%">
                            <feTurbulence
                                type="fractalNoise"
                                baseFrequency="0.06"
                                numOctaves={2}
                                seed={7}
                            />
                            <feDisplacementMap in="SourceGraphic" scale={7} />
                        </filter>
                        <radialGradient id={`${svgId}-fill`} cx="40%" cy="35%" r="70%">
                            <stop offset="0" stopColor="var(--ps-wax-light)" />
                            <stop offset=".55" stopColor="var(--ps-wax)" />
                            <stop offset="1" stopColor="var(--ps-wax-deep)" />
                        </radialGradient>
                        <clipPath id={`${svgId}-left`}>
                            <path d="M0 0 H58 L52 30 L60 52 L50 74 L57 112 H0Z" />
                        </clipPath>
                        <clipPath id={`${svgId}-right`}>
                            <path d="M58 0 H112 V112 H57 L50 74 L60 52 L52 30Z" />
                        </clipPath>
                        <g id={`${svgId}-art`}>
                            <circle
                                ref={poolRef}
                                cx="56"
                                cy="56"
                                r="30"
                                fill={`url(#${svgId}-fill)`}
                                filter={`url(#${svgId}-edge)`}
                            />
                            <g className={classes.imprint} data-shown={pressed || undefined}>
                                <circle
                                    cx="56"
                                    cy="56"
                                    r="25"
                                    fill="none"
                                    stroke="rgba(0,0,0,.35)"
                                    strokeWidth="2"
                                />
                                <g
                                    fill="rgba(40,0,6,.6)"
                                    stroke="rgba(255,190,190,.18)"
                                    strokeWidth=".8"
                                >
                                    <circle cx="50" cy="52" r="4.2" />
                                    <circle cx="59" cy="52" r="4.2" />
                                    <circle cx="68" cy="52" r="4.2" />
                                    <circle cx="54.5" cy="60" r="4.2" />
                                    <circle cx="63.5" cy="60" r="4.2" />
                                    <circle cx="59" cy="68" r="4.2" />
                                    <path d="M59 47 C58 42 61 39 65 37 M60 43 C55 38 49 40 47 43 C52 45 56 45 60 43Z" />
                                </g>
                            </g>
                        </g>
                    </defs>
                    <g className={classes.half} data-side="left">
                        <use href={`#${svgId}-art`} clipPath={`url(#${svgId}-left)`} />
                    </g>
                    <g className={classes.half} data-side="right">
                        <use href={`#${svgId}-art`} clipPath={`url(#${svgId}-right)`} />
                    </g>
                </svg>
                <span className={classes.ring} aria-hidden>
                    <svg viewBox="0 0 34 34">
                        <g fill="rgba(60,40,10,.55)">
                            <circle cx="11" cy="15" r="3" />
                            <circle cx="17" cy="15" r="3" />
                            <circle cx="23" cy="15" r="3" />
                            <circle cx="14" cy="21" r="3" />
                            <circle cx="20" cy="21" r="3" />
                            <circle cx="17" cy="27" r="3" />
                            <path d="M17 11 C16 7 19 5 22 4 M18 8 C14 4 9 6 8 8 C12 10 15 10 18 8Z" />
                        </g>
                    </svg>
                </span>
            </UnstyledButton>

            <p className={classes.note} role="status">
                {note}
            </p>
        </div>
    );
};
