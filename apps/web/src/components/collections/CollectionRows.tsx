"use client";

import { Box, Text } from "@mantine/core";

import type { Playlist, SavedFilter } from "@private-stock/core";

import { FilmstripRow, type FilmstripFrame } from "@/components/browse/FilmstripRow";
import { playlistFacts } from "@/components/playlist/PlaylistCard";
import { useSavedFilterCovers } from "@/lib/api/savedFilters";
import { savedFilterHref } from "@/lib/libraryQuery";
import { useNearViewport } from "@/lib/useNearViewport";

import { viewFacts } from "./ViewCard";

/**
 * A view or a playlist as a row on Views & playlists (§14c): the performer page's row, so the two
 * browse pages read the same way and a list of hundreds scans downward.
 *
 * The frames open the collection, not the item they show. A performer's strip is that person's
 * range, and stepping along it is the point; a collection's covers are its face, and the thing
 * somebody pressing one wants is the collection -- for a view, its grid, which already starts
 * with these items.
 */

/** Frames held in place while a view's covers are on their way, so the row does not jump. */
const PENDING_FRAMES = 8;

const framesOf = (covers: string[], href: string): FilmstripFrame[] =>
    covers.map((coverUrl) => ({ key: coverUrl, href, coverUrl }));

/** The facts line, and what the collection says about itself under it. */
const Facts: React.FC<{ facts: string; description: string | null }> = ({ facts, description }) => (
    <>
        <Text size="xs" c="dimmed" tt="uppercase" lts="0.1em">
            {facts}
        </Text>
        {description && (
            <Text size="sm" c="dimmed" lineClamp={1}>
                {description}
            </Text>
        )}
    </>
);

export const ViewRow: React.FC<{ filter: SavedFilter; menu?: React.ReactNode }> = ({
    filter,
    menu,
}) => {
    // Asked for once the row is near the screen, as the card's is (`ViewCard`).
    const { ref, near } = useNearViewport<HTMLDivElement>();
    const { data, isError } = useSavedFilterCovers(filter.id, near);
    const href = savedFilterHref(filter);
    const pending = data === undefined && !isError;

    return (
        <Box ref={ref}>
            <FilmstripRow
                name={filter.name}
                href={href}
                frames={
                    pending
                        ? Array.from({ length: PENDING_FRAMES }, (_, i) => ({
                              key: `pending-${i}`,
                              href,
                              coverUrl: null,
                          }))
                        : framesOf(data?.covers ?? [], href)
                }
                actions={menu}
            >
                <Facts facts={viewFacts(filter)} description={filter.description} />
            </FilmstripRow>
        </Box>
    );
};

export const PlaylistRow: React.FC<{ playlist: Playlist; menu?: React.ReactNode }> = ({
    playlist,
    menu,
}) => {
    const href = `/playlists/${playlist.id}`;

    return (
        <FilmstripRow
            name={playlist.name}
            href={href}
            frames={framesOf(playlist.covers, href)}
            actions={menu}
        >
            <Facts facts={playlistFacts(playlist)} description={playlist.description} />
        </FilmstripRow>
    );
};
