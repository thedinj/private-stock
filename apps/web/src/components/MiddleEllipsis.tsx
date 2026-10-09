"use client";

import { useMemo } from "react";
import { Text, type TextProps } from "@mantine/core";

import { splitForMiddleEllipsis } from "@/lib/middleEllipsis";

import classes from "./MiddleEllipsis.module.scss";

/**
 * One line of text that, when it does not fit, is cut in the middle rather than at the end:
 * `FallGuy…2026-03-12 21-04-33` (§14).
 *
 * For names, which share their beginnings and differ at their ends. Two spans and no
 * measuring: the tail never shrinks, so when the line runs out of room the browser's own
 * ellipsis lands at the end of the head -- in the middle of the name. A name that fits is
 * drawn exactly as it would be anyway. Nothing is observed or recomputed on resize, so a page
 * of sixty can use it freely.
 *
 * The whole text is in the element -- clipped, not removed -- so it is what a screen reader
 * reads and what a copy takes, and it is the hover title. Where the split falls is
 * `splitForMiddleEllipsis`'s decision, the same for every name wherever it is shown.
 *
 * Mantine `Text` underneath, so size, weight, colour and the rest are its props as usual.
 * Not for prose: a sentence cut in the middle reads worse than one cut at the end.
 */
type MiddleEllipsisProps = Omit<TextProps, "children" | "truncate" | "lineClamp"> &
    Omit<React.ComponentPropsWithoutRef<"p">, keyof TextProps | "children" | "title"> & {
        text: string;
    };

export const MiddleEllipsis: React.FC<MiddleEllipsisProps> = ({ text, className, ...rest }) => {
    const { head, tail } = useMemo(() => splitForMiddleEllipsis(text), [text]);

    return (
        <Text
            {...rest}
            className={className ? `${classes.root} ${className}` : classes.root}
            title={text}
        >
            <span className={classes.head}>{head}</span>
            {tail && <span className={classes.tail}>{tail}</span>}
        </Text>
    );
};
