"use client";

import { useEffect, useRef } from "react";
import { Box, Button, Center, Group, Loader, Stack, Text, Title } from "@mantine/core";

import type { TagBrowseSort, TagScope } from "@private-stock/core";

import type { BrowseLayout } from "@/components/browse/RowsTilesSwitch";
import { LoadFailed } from "@/components/LoadFailed";
import { useTagBrowse } from "@/lib/api/tags";

import { TagFilmstripRow } from "./TagFilmstripRow";
import { TagTile } from "./TagTile";
import tileClasses from "./TagTile.module.scss";

/**
 * One system's tags of one facet, as filmstrip rows or tiles loaded while scrolling (§6 "Tags").
 *
 * Pages of thirty arrive as the end of the list comes into view, so a facet of a thousand
 * performers costs what is looked at rather than what exists. A button stands in for the
 * observer where there is none, and is also simply there for anybody who would rather click.
 */

interface TagBrowseListProps {
    kind: string;
    scope: TagScope;
    search: string;
    sort: TagBrowseSort;
    /** Only the viewer's favourites. */
    favorite: boolean;
    layout: BrowseLayout;
    seed: number;
    curator: boolean;
    onDone: (message: string) => void;
    /** A heading over the list, for a page that shows two systems one after the other. */
    heading?: string;
    /** Said when nothing matches and nothing was searched for. Null hides the whole list. */
    empty: string | null;
}

export const TagBrowseList: React.FC<TagBrowseListProps> = ({
    kind,
    scope,
    search,
    sort,
    favorite,
    layout,
    seed,
    curator,
    onDone,
    heading,
    empty,
}) => {
    const query = useTagBrowse({
        kind,
        scope,
        search: search || undefined,
        sort,
        seed,
        favorite,
    });
    const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;
    const sentinel = useRef<HTMLDivElement>(null);

    /**
     * Asks for the next page as the bottom of the list approaches.
     *
     * An effect because an observer is a subscription to the page, not a fetch: the request
     * itself is TanStack's, and this only says when. 600px early, so the next rows are
     * usually there before anybody reaches the gap.
     */
    useEffect(() => {
        const node = sentinel.current;

        if (!node || !hasNextPage || typeof IntersectionObserver === "undefined") {
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
                    void fetchNextPage();
                }
            },
            { rootMargin: "600px 0px" }
        );

        observer.observe(node);

        return () => observer.disconnect();
    }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

    if (query.error) {
        return <LoadFailed error={query.error} onRetry={() => void query.refetch()} />;
    }

    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    const total = query.data?.pages[0]?.total ?? 0;

    if (!query.isLoading && rows.length === 0 && !search && empty === null) {
        return null;
    }

    return (
        <Stack gap={0}>
            {heading && (
                <Group justify="space-between" align="baseline" mb="xs">
                    <Title order={3}>{heading}</Title>
                    {total > 0 && (
                        <Text size="xs" c="dimmed">
                            {total.toLocaleString()}
                        </Text>
                    )}
                </Group>
            )}

            {query.isLoading ? (
                <Center h={160}>
                    <Loader size="sm" color="brass" />
                </Center>
            ) : rows.length === 0 ? (
                <Text size="sm" c="dimmed" py="md">
                    {search
                        ? "Nothing by that name."
                        : favorite
                          ? "No favourites here yet. Tap ♡ beside a name to add one."
                          : empty}
                </Text>
            ) : layout === "tiles" ? (
                <Box className={tileClasses.wall}>
                    {rows.map((row) => (
                        <TagTile
                            key={row.tag.id}
                            row={row}
                            scope={scope}
                            curator={curator}
                            seed={seed}
                            onDone={onDone}
                        />
                    ))}
                </Box>
            ) : (
                rows.map((row) => (
                    <TagFilmstripRow
                        key={row.tag.id}
                        row={row}
                        // A performer's portrait has a column of its own; once any row on the
                        // page has one, every row keeps it, so the names start in line.
                        pictureSlot={rows.some(
                            (other) => other.tag.kind === "performer" && other.tag.picture
                        )}
                        scope={scope}
                        curator={curator}
                        seed={seed}
                        onDone={onDone}
                    />
                ))
            )}

            <Box ref={sentinel} />

            {hasNextPage && (
                <Center py="md">
                    <Button
                        variant="subtle"
                        color="brass"
                        loading={isFetchingNextPage}
                        onClick={() => void fetchNextPage()}
                    >
                        Show more
                    </Button>
                </Center>
            )}
        </Stack>
    );
};
