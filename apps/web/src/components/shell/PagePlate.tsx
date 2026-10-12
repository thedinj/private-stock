"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Anchor, Box, Title } from "@mantine/core";

import { setFoldedTitle } from "./foldedTitle";
import classes from "./PagePlate.module.scss";

/**
 * Where you are, said once and said loudly (§14).
 *
 * Every screen used to open the same way: a 22px title in a stack with 2px of gap, a grey
 * subtitle, and then the controls. Six screens, one shape, no weight — you could not tell
 * Trash from Playlists without reading. This is the replacement, and it is the app's
 * letterhead: an eyebrow at 11px, a serif title at section size, and a brass rule that travels
 * and gives out underneath. One size on every page -- see the stylesheet for why there is no
 * larger one any more.
 *
 * The hierarchy is that jump and nothing else. **The display face ships one weight**
 * (`theme.ts`), so hierarchy cannot come from a heavier heading and has to come from size,
 * colour and space — which is where it should come from anyway, and which is why the scale
 * steps by a third rather than by a tenth.
 *
 * One per screen. The rule is the only place the accent is spent at full strength, and it
 * reads as an accent everywhere else in the app precisely because it is rare here.
 */
interface PagePlateProps {
    /**
     * The small brass line above the title. Where this screen sits, not what it does. A node
     * rather than a string so a count in it can roll when it changes (`Odometer`).
     */
    eyebrow: React.ReactNode;
    title: string;
    /** A sentence under the rule, for a screen whose rules are not obvious. */
    lede?: React.ReactNode;
    /** Usually the one action the screen exists for. Wraps under the title on a phone. */
    actions?: React.ReactNode;
    /**
     * Where the back link goes, and what it is called.
     *
     * Omitted on the library itself, which is already home — a "← Home" on the home page is
     * a control that cannot work, and those are absent rather than disabled.
     *
     * `phoneOnly` for a link that repeats the sidebar: below `sm` the sidebar is behind the
     * burger and the link is the only way back on screen; above it, it is a second copy.
     */
    back?: { href: string; label: string; phoneOnly?: boolean };
    /** Beside the title, on its line: a control *about* the title, such as a saved view's state. */
    aside?: React.ReactNode;
}

/** The header's height: the plate counts as gone once it is under the header, not off the top. */
const HEADER_PX = 56;

/**
 * The plate's title goes to the header while the plate is out of sight (§14, "Motion").
 *
 * Watched against a root shrunk by the header's height, so the title moves up there at the
 * moment the plate slides under the bar -- and only when it left upwards: a plate below the
 * fold on a short screen is not "scrolled away". Cleared on unmount, so the next page never
 * inherits this one's name.
 */
const useFoldIntoHeader = (title: string) => {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const plate = ref.current;
        if (!plate || typeof IntersectionObserver === "undefined") return;

        const observer = new IntersectionObserver(
            ([entry]) => {
                const above = entry.boundingClientRect.top < HEADER_PX;

                setFoldedTitle(!entry.isIntersecting && above ? title : null);
            },
            { rootMargin: `-${HEADER_PX}px 0px 0px 0px` }
        );

        observer.observe(plate);

        return () => {
            observer.disconnect();
            setFoldedTitle(null);
        };
    }, [title]);

    return ref;
};

export const PagePlate: React.FC<PagePlateProps> = ({
    eyebrow,
    title,
    lede,
    actions,
    back,
    aside,
}) => {
    const ref = useFoldIntoHeader(title);

    return (
        <Box className={classes.plate} ref={ref}>
            {back && (
                <Anchor
                    component={Link}
                    href={back.href}
                    size="xs"
                    c="dimmed"
                    underline="never"
                    hiddenFrom={back.phoneOnly ? "sm" : undefined}
                >
                    ← {back.label}
                </Anchor>
            )}

            <Box className={classes.head}>
                <Box className={classes.copy}>
                    <span className={classes.eyebrow}>{eyebrow}</span>
                    <Box className={classes.titleLine}>
                        <Title order={1} className={classes.title} data-plate-title data-candle>
                            {title}
                        </Title>
                        {aside}
                    </Box>
                </Box>

                {actions && <Box className={classes.actions}>{actions}</Box>}
            </Box>

            <Box className={classes.rule} data-candle />

            {lede && <Box className={classes.lede}>{lede}</Box>}
        </Box>
    );
};
