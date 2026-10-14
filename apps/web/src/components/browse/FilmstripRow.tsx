"use client";

import Link from "next/link";
import { Box } from "@mantine/core";

import classes from "./FilmstripRow.module.scss";

/**
 * A row on a browse page: a name, what to say under it, a strip of what it holds, and a control
 * at the end (§6 "Tags", §14c).
 *
 * A performer, somebody they appear with, a saved view and a playlist all wear it, because they
 * are the same object to look at: a name and a glimpse of its range. A row rather than a card
 * because these lists run to hundreds, and a row scans downward where a wall of cards does not.
 *
 * The strip shows as many whole frames as the width allows and never a sliver of one; see the
 * stylesheet for how.
 *
 * **A tag's own picture leads the row** where it has one (§6 "A tag's picture"). A performer's
 * portrait sits beside the name, 88 pixels square (72 on a phone) -- the smallest a face is drawn
 * anywhere -- and a source's or keyword's frame is the strip's first, at a frame's size and
 * ringed, since it is the tag's rather than one of its items. Both open the tag's page.
 */

export interface FilmstripFrame {
    key: string;
    href: string;
    coverUrl: string | null;
    title?: string;
    onClick?: () => void;
}

/** The row's own picture: a portrait beside the name, or a frame leading the strip. */
export interface FilmstripPicture {
    url: string;
    shape: "portrait" | "frame";
}

interface FilmstripRowProps {
    name: string;
    href: string;
    picture?: FilmstripPicture | null;
    /**
     * Keep the portrait's column without a portrait, so the names of a list where some rows have
     * one start in line with the rest.
     */
    pictureSlot?: boolean;
    /** Beside the name, riding on its first line however far it wraps: a heart, a mark. */
    adornment?: React.ReactNode;
    /** Under the name: aliases, counts, the facts about it. */
    children?: React.ReactNode;
    frames: FilmstripFrame[];
    /** At the end of the row, and beside the name on a phone: a menu, a link. */
    actions?: React.ReactNode;
}

export const FilmstripRow: React.FC<FilmstripRowProps> = ({
    name,
    href,
    picture,
    pictureSlot,
    adornment,
    children,
    frames,
    actions,
}) => (
    <Box
        className={classes.row}
        data-pictured={picture?.shape === "portrait" || pictureSlot || undefined}
    >
        {picture?.shape !== "portrait" && pictureSlot && <Box className={classes.slot} />}
        {picture?.shape === "portrait" && (
            // A column of its own, so the name keeps the label's whole width beside it. The same
            // destination as the name, so out of the tab order: one link is announced, not two.
            <Link href={href} className={classes.portrait} tabIndex={-1} aria-hidden>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={picture.url} alt="" loading="lazy" decoding="async" />
            </Link>
        )}

        <Box className={classes.label}>
            <Box className={classes.nameLine}>
                <Link href={href} className={classes.name}>
                    {name}
                </Link>
                {adornment && (
                    <Box component="span" className={classes.heart}>
                        {adornment}
                    </Box>
                )}
            </Box>
            {children}
        </Box>

        <Box className={classes.strip}>
            {picture?.shape === "frame" && (
                <Link
                    href={href}
                    className={`${classes.frame} ${classes.own}`}
                    tabIndex={-1}
                    aria-hidden
                >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={picture.url} alt="" loading="lazy" decoding="async" />
                </Link>
            )}
            {frames.map((frame) => (
                <Link
                    key={frame.key}
                    href={frame.href}
                    className={classes.frame}
                    title={frame.title}
                    onClick={frame.onClick}
                    // A frame that opens an item is lit while it is on its way (§14,
                    // "Waiting"); one that goes anywhere else is never marked, so this is inert.
                    data-open-frame
                >
                    {frame.coverUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={frame.coverUrl} alt="" loading="lazy" decoding="async" />
                    ) : (
                        <Box className={classes.blank} />
                    )}
                </Link>
            ))}
        </Box>

        {actions && <Box className={classes.actions}>{actions}</Box>}
    </Box>
);
