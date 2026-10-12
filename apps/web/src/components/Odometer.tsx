"use client";

import { useEffect, useRef } from "react";

import classes from "./Odometer.module.scss";

/**
 * A count whose digits roll to a new value, rather than jumping (§14, "Motion").
 *
 * For the numbers that change while somebody is looking at them -- a scan landing, a merge, a
 * stage of processing ticking along. A number that jumps is easy to miss changing at all; one
 * that rolls says that it changed and, by how far each digit travels, roughly by how much.
 *
 * **Nothing moves on the first render**: arriving at a page is not a change. Separators are
 * static and only digits roll, staggered from the right as a mechanical counter's do. Under
 * reduced motion the stylesheet's global rule makes the roll instant.
 *
 * It inherits font, size and colour, so it drops into a line of text. The strips are hidden
 * from assistive technology and the plain number is given in their place.
 */

const DIGITS = "0123456789";

/** Each digit to the left starts this much later, so the units lead. */
const STAGGER_MS = 40;

export const Odometer: React.FC<{ value: number }> = ({ value }) => {
    const text = value.toLocaleString();
    const mounted = useRef(false);

    useEffect(() => {
        mounted.current = true;
    }, []);

    const chars = Array.from(text);
    // Count digits from the right, so the stagger and the React keys stay with their place
    // value when the number gains a digit at the front.
    let fromRight = 0;
    const cells = chars
        .map((char, index) => ({ char, index }))
        .reverse()
        .map(({ char, index }) => {
            if (!DIGITS.includes(char)) return { key: `s${chars.length - index}`, char, place: -1 };
            return { key: `d${fromRight}`, char, place: fromRight++ };
        })
        .reverse();

    return (
        <span className={classes.odometer}>
            <span className={classes.spoken}>{text}</span>
            {cells.map(({ key, char, place }) =>
                place < 0 ? (
                    <span key={key} aria-hidden>
                        {char}
                    </span>
                ) : (
                    <span key={key} className={classes.window} aria-hidden>
                        <span
                            className={`${classes.strip} ${mounted.current ? "" : classes.static}`}
                            style={{
                                transform: `translateY(${-Number(char)}lh)`,
                                transitionDelay: `${place * STAGGER_MS}ms`,
                            }}
                        >
                            {Array.from(DIGITS, (digit) => (
                                <span key={digit}>{digit}</span>
                            ))}
                        </span>
                    </span>
                )
            )}
        </span>
    );
};
