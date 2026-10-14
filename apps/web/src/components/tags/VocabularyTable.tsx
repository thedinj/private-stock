"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
    Alert,
    Anchor,
    Center,
    Group,
    Loader,
    Pagination,
    SegmentedControl,
    Stack,
    Switch,
    Table,
    Text,
} from "@mantine/core";

import type { TagScope } from "@private-stock/core";

import { useVocabulary } from "@/lib/api/tags";
import { facetLabel, facetLabelPlural } from "@/lib/facetLabels";
import { settling } from "@/lib/settling";
import { TagRowActions } from "@/components/tags/TagRowActions";
import {
    defineView,
    enumField,
    flagField,
    pageField,
    textField,
    useUrlSearch,
    useUrlView,
} from "@/lib/urlView";
import { SearchInput } from "@/components/SearchInput";

/**
 * One facet of one tagging system's vocabulary, as a table you can work through (§6).
 *
 * One facet per table, because the management screen gives each facet a section of its own as
 * the item page does: performers, sources and keywords share the table underneath and nothing
 * a person tidying them cares about. It used to be one table per system with a facet filter
 * over it, which put every performer under a heading calling them "Shared".
 *
 * Ordered by name unless asked otherwise. This is a list to *find* a tag in — "where is the
 * one I misspelled" — and by count is the second question, which of these matter. Either way
 * the order is the server's: the table holds one page of fifty, so sorting in the browser
 * would only reorder that page. "Unused only" stays a filter rather than a sort to the
 * bottom, because the bottom of a long list is where the pages run out.
 *
 * Searched and paged on the server. Fetching the whole vocabulary and filtering in the browser
 * is fine at fifty tags and not at the several thousand a performer facet reaches on a real
 * library — which is the size that makes this screen necessary in the first place.
 */

const PAGE_SIZE = 50;

/**
 * A table's search, filter, sort and page, in the address (§14b).
 *
 * Checking a tag's count in the library is the usual detour from a cleanup, and coming back
 * used to reset every table to its first page. Several tables share the page, so each one's
 * parameters carry its facet and system -- `performer.public.page`, `tag.private.q` -- and
 * changing one leaves the others where they were.
 */
const tableFields = {
    search: textField("q"),
    unusedOnly: flagField("unused"),
    sort: enumField("sort", ["count", "name"], "name"),
    page: pageField(),
};

interface VocabularyTableProps {
    kind: string;
    scope: TagScope;
    /** Whether this viewer may change this vocabulary. Reading it is open to everybody. */
    curator: boolean;
    onDone: (message: string) => void;
}

export const VocabularyTable: React.FC<VocabularyTableProps> = ({
    kind,
    scope,
    curator,
    onDone,
}) => {
    const tableView = useMemo(
        () => defineView("/tags/manage", tableFields, { prefix: `${kind}.${scope}.` }),
        [kind, scope]
    );
    const [view, apply] = useUrlView(tableView);
    const { unusedOnly, sort, page } = view;

    /**
     * Any filter change goes back to the first page.
     *
     * Staying on page 7 of a list that just became two pages long shows nothing, and an empty
     * table reads as "no tags match" rather than as "you are past the end".
     */
    // Typing is a filter, not a request per keystroke. The same 300ms the library search uses.
    const [search, setSearch] = useUrlSearch(
        view.search,
        (settled) => apply({ search: settled, page: 0 }),
        300
    );

    const { data, isLoading, isPlaceholderData, error } = useVocabulary({
        scope,
        kind,
        search: view.search || undefined,
        unusedOnly: unusedOnly || undefined,
        sort,
        page,
        pageSize: PAGE_SIZE,
    });

    const tags = data?.tags ?? [];
    const total = data?.total ?? 0;
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const one = facetLabel(kind).toLowerCase();
    const many = facetLabelPlural(kind).toLowerCase();

    if (error) {
        return (
            <Alert color="oxblood" variant="light" title="Could not load the tags">
                {(error as Error).message}
            </Alert>
        );
    }

    return (
        <Stack gap="sm">
            <Group gap="sm" wrap="wrap">
                <SearchInput
                    placeholder={`Find a ${one}`}
                    value={search}
                    onChange={setSearch}
                    w={{ base: "100%", xs: 220 }}
                />

                {/* Sorted by the server, not the page: a table paged fifty at a time sorted
                    in the browser would put the busiest of these fifty first, not the
                    busiest. */}
                <Group gap={6} align="center" wrap="nowrap">
                    <Text size="xs" c="dimmed">
                        Sort by
                    </Text>
                    <SegmentedControl
                        size="xs"
                        color="brass"
                        value={sort}
                        onChange={(value) =>
                            apply({ sort: value === "count" ? "count" : "name", page: 0 })
                        }
                        data={[
                            { value: "count", label: "Count" },
                            { value: "name", label: "A–Z" },
                        ]}
                    />
                </Group>

                <Switch
                    size="xs"
                    label="Unused only"
                    checked={unusedOnly}
                    onChange={(event) =>
                        apply({ unusedOnly: event.currentTarget.checked, page: 0 })
                    }
                />

                <Text size="xs" c="dimmed">
                    {total.toLocaleString()} {total === 1 ? one : many}
                </Text>
            </Group>

            {isLoading ? (
                <Center h={120}>
                    <Loader size="sm" color="brass" />
                </Center>
            ) : tags.length === 0 ? (
                <Text size="sm" c="dimmed" py="md">
                    {view.search || unusedOnly
                        ? `No ${many} match.`
                        : scope === "public"
                          ? `The library has no ${many} yet. Add one on any item's page.`
                          : `You have no private ${many}. Add one in the Private box on any item.`}
                </Text>
            ) : (
                // The last page stays up and settles while the next one loads.
                <Table.ScrollContainer minWidth={520} {...settling(isPlaceholderData)}>
                    <Table verticalSpacing="sm">
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>Name</Table.Th>
                                <Table.Th>Items</Table.Th>
                                {scope === "public" && <Table.Th>Coined by</Table.Th>}
                                <Table.Th />
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {tags.map((tag) => (
                                <Table.Tr key={tag.id}>
                                    <Table.Td>
                                        {tag.name}
                                        {/* Beneath the name, because a search here matches
                                            aliases too, and a row that matched on one would
                                            otherwise show no reason for being in the list. */}
                                        {(tag.aliases?.length ?? 0) > 0 && (
                                            <Text size="xs" c="dimmed">
                                                also {tag.aliases?.join(", ")}
                                            </Text>
                                        )}
                                    </Table.Td>
                                    <Table.Td>
                                        {/* Through to the library filtered by this tag, which
                                            is the question a count invites. An ordinary
                                            address, so it is shareable like any other. */}
                                        {(tag.mediaCount ?? 0) > 0 ? (
                                            <Anchor
                                                component={Link}
                                                href={`/?view=grid&tags=${tag.id}`}
                                                size="sm"
                                            >
                                                {(tag.mediaCount ?? 0).toLocaleString()}
                                            </Anchor>
                                        ) : (
                                            <Text size="sm" c="dimmed">
                                                0
                                            </Text>
                                        )}
                                    </Table.Td>
                                    {scope === "public" && (
                                        <Table.Td>
                                            <Text size="xs" c="dimmed">
                                                {tag.createdBy ?? ""}
                                            </Text>
                                        </Table.Td>
                                    )}
                                    <Table.Td>
                                        <TagRowActions
                                            tag={tag}
                                            scope={scope}
                                            curator={curator}
                                            onDone={onDone}
                                        />
                                    </Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                </Table.ScrollContainer>
            )}

            {pageCount > 1 && (
                <Center>
                    {/* Mantine's Pagination is 1-based; the query is 0-based. */}
                    <Pagination
                        value={page + 1}
                        onChange={(value) => apply({ page: value - 1 })}
                        total={pageCount}
                        color="brass"
                    />
                </Center>
            )}
        </Stack>
    );
};
