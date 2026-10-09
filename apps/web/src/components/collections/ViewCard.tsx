"use client";

import Link from "next/link";
import { Box, Text } from "@mantine/core";

import type { SavedFilter } from "@private-stock/core";

import { CoverMosaic } from "@/components/collections/CoverMosaic";
import { useSavedFilterCovers } from "@/lib/api/savedFilters";
import { savedFilterHref } from "@/lib/libraryQuery";
import { useNearViewport } from "@/lib/useNearViewport";

import classes from "@/components/playlist/PlaylistCard.module.scss";

/**
 * A saved view as a card, beside the playlists (§14b, §14c).
 *
 * The same card as a playlist's, stylesheet included, because they are the same kind of thing
 * and a screen that holds both should not make one look like a lesser version of the other.
 *
 * Its face is asked for separately, and only once the card is near the screen. A playlist's
 * covers come with the list because its members are a lookup; a view's are an answer to its
 * query, and answering every view to draw the list would make the page cost the number of
 * views somebody keeps. One per card, as it scrolls in, costs what is on screen.
 *
 * Until the face arrives the panel is the bare well, not the view's terms, so a face replaces
 * nothing. When there is none -- nothing matches, no artwork yet, or the query cannot be read
 * -- the terms stand in, which is the next most useful thing to see: what it asks.
 */

/** The facts a view has, in place of a count of items it has not fetched; on a card or a row. */
export const viewFacts = (filter: SavedFilter): string =>
    [
        filter.editable ? null : `shared by ${filter.ownerName}`,
        filter.showsOwnerRatings ? `uses ${filter.ownerName}'s ratings` : null,
        filter.viewerRelative && filter.resolveAs === "viewer"
            ? "uses your ratings and favourites"
            : null,
        filter.curated ? "offered to everyone" : filter.pinned ? "pinned" : null,
    ]
        .filter((fact): fact is string => fact !== null)
        .join(" · ") || "Saved view";

export const ViewCard: React.FC<{ filter: SavedFilter; menu?: React.ReactNode }> = ({
    filter,
    menu,
}) => {
    const { ref, near } = useNearViewport<HTMLDivElement>();
    const { data, isError } = useSavedFilterCovers(filter.id, near);
    const settled = data !== undefined || isError;

    return (
        <Box ref={ref} className={classes.card} data-menu={menu ? true : undefined}>
            <Link href={savedFilterHref(filter)} className={classes.link}>
                <CoverMosaic
                    covers={data?.covers ?? []}
                    empty={
                        settled ? (
                            <Text className={classes.emptyLabel}>
                                {filter.description ?? "A question about the library"}
                            </Text>
                        ) : undefined
                    }
                />

                <Box className={classes.body}>
                    <Text className={classes.name} lineClamp={2}>
                        {filter.name}
                    </Text>
                    <Text className={classes.meta}>{viewFacts(filter)}</Text>
                </Box>
            </Link>

            {menu && <Box className={classes.menu}>{menu}</Box>}
        </Box>
    );
};
