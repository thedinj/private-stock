import { useId } from "react";

import seal from "@/app/icon.svg";

import classes from "./CorkStamp.module.scss";

/**
 * The seal with the estate's words round it, as a cork is branded (§14).
 *
 * For the places the seal is shown large and alone -- the sign-in card and About -- where the
 * wordmark's 26px seal would be lost. Below about 100px the words cannot be read, so it is not
 * offered smaller; the header keeps the plain `SealMark`.
 *
 * Decorative, like the seal: the title beside it names the app, so the whole stamp is hidden
 * from assistive technology. The ring's id comes from `useId` because both uses can be on
 * screen at once (About opens over a page), and two `<path id>`s with one name would hang
 * both rings' text on whichever the browser found first.
 */
const WORDS = "PRIVATE STOCK · ESTATE BOTTLED · NOT FOR SALE · ";

/** The ring the words run on: radius 74 in a 200 box, so its length is 2π·74. */
const RING_R = 74;
const RING_LENGTH = 2 * Math.PI * RING_R;

export const CorkStamp: React.FC<{ size: number }> = ({ size }) => {
    const ringId = `cork-ring-${useId().replace(/:/g, "")}`;

    return (
        <svg
            className={classes.stamp}
            width={size}
            height={size}
            viewBox="0 0 200 200"
            aria-hidden
            focusable="false"
        >
            <defs>
                <path
                    id={ringId}
                    d={`M100,100 m-${RING_R},0 a${RING_R},${RING_R} 0 1,1 ${2 * RING_R},0 a${RING_R},${RING_R} 0 1,1 -${2 * RING_R},0`}
                />
            </defs>
            <circle className={classes.rim} cx="100" cy="100" r="95" strokeWidth="1.5" />
            <circle className={classes.rim} cx="100" cy="100" r="58" strokeWidth="1" />
            <g className={classes.turn}>
                {/* Spaced to close the ring exactly, so the last dot meets the first word. */}
                <text className={classes.words}>
                    <textPath href={`#${ringId}`} textLength={RING_LENGTH} lengthAdjust="spacing">
                        {WORDS}
                    </textPath>
                </text>
            </g>
            <image href={seal.src} x="58" y="58" width="84" height="84" />
        </svg>
    );
};
