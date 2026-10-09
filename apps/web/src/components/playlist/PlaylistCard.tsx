"use client";

import Link from "next/link";
import { Box, Text } from "@mantine/core";

import type { Playlist } from "@private-stock/core";

import { CoverMosaic } from "@/components/collections/CoverMosaic";

import classes from "./PlaylistCard.module.scss";

/**
 * A playlist as a card with a face (§14b).
 *
 * The list of playlists was a list of names on empty panels — the one screen in the app that
 * showed nothing of what it held, which made every playlist look alike and a full one look
 * identical to an empty one. The covers come from across the whole list rather than off the
 * top of it, so the face is a glimpse of the playlist and not of its first item.
 *
 * The whole card is the link, rather than the name being one inside it: the card is a single
 * thing to press, which matters most on a phone, where a 16px anchor inside a panel is the
 * only target on a panel-sized area. A `menu` sits beside that link rather than in it.
 */

/** What a playlist says about itself under its name, on a card or a row. */
export const playlistFacts = (playlist: Playlist): string =>
    [
        `${playlist.itemCount.toLocaleString()} item${playlist.itemCount === 1 ? "" : "s"}`,
        playlist.editable ? null : `shared by ${playlist.ownerName}`,
        playlist.sortMode === "shuffle" ? "opens shuffled" : null,
        playlist.pinned ? "pinned" : null,
    ]
        .filter(Boolean)
        .join(" · ");

export const PlaylistCard: React.FC<{ playlist: Playlist; menu?: React.ReactNode }> = ({
    playlist,
    menu,
}) => (
    <Box className={classes.card} data-menu={menu ? true : undefined}>
        <Link href={`/playlists/${playlist.id}`} className={classes.link}>
            <CoverMosaic
                covers={playlist.covers}
                empty={
                    <Text className={classes.emptyLabel}>
                        {playlist.itemCount === 0 ? "Empty" : "No artwork yet"}
                    </Text>
                }
            />

            <Box className={classes.body}>
                <Text className={classes.name} lineClamp={2}>
                    {playlist.name}
                </Text>
                <Text className={classes.meta}>{playlistFacts(playlist)}</Text>
            </Box>
        </Link>

        {menu && <Box className={classes.menu}>{menu}</Box>}
    </Box>
);
