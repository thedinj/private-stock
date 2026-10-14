"use client";

import { useState } from "react";
import { Group, Loader, Modal, ScrollArea, Stack, Text } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";

import type { FacetsResponse, TagScope } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import type { LibraryView } from "@/lib/libraryQuery";
import { chipState, cycleChip } from "@/lib/tagLogic";
import { SearchInput } from "@/components/SearchInput";

import { TriChip } from "./TriChip";

/**
 * One facet, in full (§5c).
 *
 * A modal rather than the panel growing a scroll box, because the panel is a 280px column
 * beside the grid and a few hundred chips in it is a column of single words. The modal has
 * the width to wrap them and the room for the one control that makes a list this long
 * usable, which is a box to narrow it by name.
 *
 * Fetched separately from the panel's own facets, at a higher limit and for this kind alone.
 * Folding it into the panel's request would make every open of the drawer fetch hundreds of
 * values on the chance somebody expands one.
 */

interface FacetModalProps {
    /** The facet to show, or null when nothing is expanded. */
    kind: string | null;
    /**
     * Which tagging system it belongs to (§6).
     *
     * Not optional, and not derivable from `kind`: both systems have a `tag` facet, so a
     * response carries two entries under that name and matching on the kind alone returned
     * whichever came first — the library's. Expanding the private group showed everybody's.
     */
    scope: TagScope;
    label: string;
    /** The panel's tag selection, as `facetParams` serialises it. */
    filterParams: string;
    /** The panel's view: the chips here are the same three-state chips, writing to it. */
    view: LibraryView;
    onChange: (next: LibraryView) => void;
    onClose: () => void;
}

export const FacetModal: React.FC<FacetModalProps> = ({
    kind,
    scope,
    label,
    filterParams,
    view,
    onChange,
    onClose,
}) => {
    const [search, setSearch] = useState("");

    /**
     * Debounced, because every distinct value of it is a request and a cache entry.
     *
     * 250ms is long enough that typing a performer's name is one query rather than eleven,
     * and short enough that the list feels like it is following the box.
     */
    const [debounced] = useDebouncedValue(search.trim(), 250);

    const params = kind
        ? `${filterParams}&expand=${encodeURIComponent(kind)}${
              debounced ? `&find=${encodeURIComponent(debounced)}` : ""
          }`
        : "";

    const { data, isLoading } = useQuery({
        queryKey: queryKeys.media.facetsFor(params),
        queryFn: () => api<FacetsResponse>(`/api/media/facets?${params}`),
        enabled: kind !== null,
        staleTime: 30_000,
    });

    const facet = data?.facets.find((entry) => entry.kind === kind && entry.scope === scope);
    const shown = facet?.values ?? [];

    return (
        <Modal
            opened={kind !== null}
            onClose={() => {
                setSearch("");
                onClose();
            }}
            title={label}
            size="lg"
            centered
        >
            <Stack gap="sm">
                {/* Narrowing by name, which is the only way to find a known value among a few
                    hundred. It asks the *server*, and that is the point of it: the list below
                    is a ceiling of 500, so filtering what had already been fetched could never
                    reach a performer who sits past it. Searching the vocabulary reaches every
                    value the facet has, which is what makes the claim of completeness true
                    rather than true up to a limit. */}
                <SearchInput
                    placeholder={`Find in ${label.toLowerCase()}…`}
                    value={search}
                    onChange={setSearch}
                    autoFocus
                />

                {isLoading && (
                    <Group gap="xs">
                        <Loader size="xs" color="brass" />
                        <Text size="sm" c="dimmed">
                            Counting…
                        </Text>
                    </Group>
                )}

                {/* Bounded so the modal never grows past the window; the list scrolls inside
                    it rather than the page scrolling behind it. */}
                <ScrollArea.Autosize mah="55dvh" type="auto">
                    <Group gap={6} pr="sm">
                        {shown.map((value) => (
                            <TriChip
                                key={value.tagId}
                                name={value.name}
                                count={value.uses}
                                state={chipState(view, value.tagId)}
                                onCycle={() => kind && onChange(cycleChip(view, value.tagId, kind))}
                            />
                        ))}
                    </Group>
                </ScrollArea.Autosize>

                {!isLoading && shown.length === 0 && (
                    <Text size="sm" c="dimmed">
                        {search ? `Nothing here matches "${search}".` : "Nothing to show."}
                    </Text>
                )}

                {/* Said rather than implied. The expanded list is a ceiling, not "all", and a
                    list that silently stops implies the rest does not exist. */}
                {facet?.truncated && (
                    <Text size="xs" c="dimmed">
                        Showing the {facet.values.length.toLocaleString()} most used of{" "}
                        {facet.total.toLocaleString()}. Type a name to reach any of the rest.
                    </Text>
                )}
            </Stack>
        </Modal>
    );
};
