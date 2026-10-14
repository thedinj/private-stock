"use client";

import { Tabs, Text } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type { MediaCountResponse } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { effectiveSort, viewToRequestParams, type LibraryView } from "@/lib/libraryQuery";

import classes from "./KindTabs.module.scss";

/**
 * Which shelf of the library you are on: Videos, Photos, or both (§14e).
 *
 * **Tabs, directly under the title, and the first thing on the page.** Most sessions are spent
 * in one kind or the other, and the kind used to be one grey segmented control among eleven
 * controls of equal weight, sliding sideways whenever the buttons beside it came and went -- and
 * on a phone it was inside the filter drawer, two taps deep, for the choice made first and most
 * often. Tabs say "which shelf" in the vocabulary everybody already reads, never move, and
 * separate choosing a shelf from narrowing within it, which is the distinction `clearFilters`
 * already draws.
 *
 * **All comes last and carries no count.** The mixed view is still wanted -- a search across
 * both, a showcase of everything -- but it is not where anybody starts, and giving it equal
 * weight made it read as the default.
 *
 * The counts are the current filter's, asked per kind. The tab you are on shares its key with
 * the grid's own count and costs nothing; the other kind is one more exact count per filter
 * (§20), fetched once and cached like the grid's. For a shuffle or an untagged list it costs no
 * walk of its own either: the server keeps one order for both kinds and counts each tab from it
 * (§20 "One walk serves both kind tabs").
 *
 * **The other kind waits for the filter to settle.** The search box is debounced at 300 ms for
 * the grid, and somebody typing a word slowly pauses that long after every letter -- each pause
 * was the grid, its count, this count and the facets, and an exact count over a short prefix is
 * one of the dearest statements the app runs. On the NAS, where the web process blocks for the
 * whole of it, "Pulsing" cost fourteen counts in a second, some finishing five seconds after the
 * word they were for (§20). Nobody reads the inactive tab's number mid-word, so it is asked only
 * once the filter has held still for `SETTLE_MS`, and shows the previous number meanwhile.
 */

/** How long the filter must hold still before the count of the tab you are not on is asked. */
const SETTLE_MS = 1_000;

interface KindTabsProps {
    view: LibraryView;
    onChange: (kind: LibraryView["kind"]) => void;
    /** A phone: the tabs share the width equally and stand tall enough for a thumb. */
    touch: boolean;
    /** The first thing in the working row on a wide screen, rather than a row of their own. */
    inline?: boolean;
}

const useKindCount = (view: LibraryView, kind: "video" | "image"): number | null => {
    // Built exactly as the grid builds its own, so the current kind's count is a cache hit.
    const params = viewToRequestParams({ ...view, kind, sort: effectiveSort(view) }).toString();
    const [settled] = useDebouncedValue(params, SETTLE_MS);

    // The current tab's key is the grid's, already being fetched, so delaying it saves nothing.
    const asked = view.kind === kind ? params : settled;

    const { data } = useQuery({
        queryKey: queryKeys.media.count(asked),
        queryFn: () => api<MediaCountResponse>(`/api/media/count?${asked}`),
        staleTime: 60_000,
        placeholderData: keepPreviousData,
    });

    return data?.total ?? null;
};

const Count: React.FC<{ value: number | null }> = ({ value }) =>
    value === null ? null : (
        <Text span size="xs" c="dimmed" ml={6}>
            {value.toLocaleString()}
        </Text>
    );

export const KindTabs: React.FC<KindTabsProps> = ({ view, onChange, touch, inline = false }) => {
    const videos = useKindCount(view, "video");
    const photos = useKindCount(view, "image");

    return (
        <Tabs
            value={view.kind}
            onChange={(value) => value && onChange(value as LibraryView["kind"])}
            color="brass"
            // A tab switch is a navigation of this page, not a panel swap: there are no
            // `Tabs.Panel`s, and the grid below is what changes.
            activateTabWithKeyboard
            styles={touch ? { tab: { height: "2.75rem" } } : undefined}
            classNames={
                inline
                    ? { root: classes.inlineRoot, list: classes.inlineList, tab: classes.inlineTab }
                    : undefined
            }
        >
            <Tabs.List grow={touch}>
                <Tabs.Tab value="video">
                    Videos
                    <Count value={videos} />
                </Tabs.Tab>
                <Tabs.Tab value="image">
                    Photos
                    <Count value={photos} />
                </Tabs.Tab>
                <Tabs.Tab value="all">All</Tabs.Tab>
            </Tabs.List>
        </Tabs>
    );
};
