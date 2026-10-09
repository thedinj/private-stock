"use client";

import { Box, Stack, Text } from "@mantine/core";

import type { BrowseLayout } from "@/components/browse/RowsTilesSwitch";
import { GRID_GAP } from "@/lib/gridGeometry";

/**
 * Yours, then the household's (§14b).
 *
 * The sectioning, the wall geometry and the wording were written twice — once on the playlists
 * page and once for saved views — and the two had already drifted: one said "Shared with you"
 * and the other said nothing at all, and only one of them distinguished a collection somebody
 * had pinned from one the house had promoted.
 *
 * Generic over the row so it can hold either kind without either kind's type leaking here. A
 * view and a playlist are the same idea with different mechanics; this is the part with no
 * mechanics in it at all.
 */

/** As many columns as fit, and exactly one on a phone, where a name is the whole point. */
const collectionWallStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(240px, 100%), 1fr))",
    gap: GRID_GAP,
} as const;

interface CollectionRow {
    id: string;
    /** Whether it is the viewer's own. Decides which section it lands in. */
    editable: boolean;
    /** Whether the house put it in this viewer's sidebar rather than the viewer. */
    curated: boolean;
}

interface CollectionSectionsProps<T extends CollectionRow> {
    rows: T[];
    render: (row: T) => React.ReactNode;
    /** What the section headings call these, lower case: "playlists", "views". */
    noun: string;
    /** Shown when there are none of either, in place of both sections. */
    empty: React.ReactNode;
    /** A wall of cards, or rows that stack (§14c). */
    layout: BrowseLayout;
}

export const CollectionSections = <T extends CollectionRow>({
    rows,
    render,
    noun,
    empty,
    layout,
}: CollectionSectionsProps<T>): React.ReactElement => {
    const mine = rows.filter((row) => row.editable);
    const shared = rows.filter((row) => !row.editable);

    if (rows.length === 0) {
        return <>{empty}</>;
    }

    // Rows carry their own rules between them, so they stack with no gap of their own.
    const wall = (section: T[]) =>
        layout === "tiles" ? (
            <Box style={collectionWallStyle}>{section.map(render)}</Box>
        ) : (
            <Box>{section.map(render)}</Box>
        );

    return (
        <Stack gap="lg">
            {mine.length > 0 && wall(mine)}

            {shared.length > 0 && (
                <Stack gap="xs">
                    <Text size="xs" c="dimmed">
                        {/*
                         * Named for where they came from rather than for what they are. "Shared
                         * with you" is what the person did; that these are the only ones an
                         * administrator can have made is a fact about permissions, not
                         * something the reader of a sidebar needs told.
                         */}
                        Shared {noun}
                    </Text>
                    {wall(shared)}
                </Stack>
            )}
        </Stack>
    );
};
