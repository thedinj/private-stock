"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
    Button,
    Group,
    Modal,
    SegmentedControl,
    Stack,
    Switch,
    Text,
    TextInput,
    Title,
} from "@mantine/core";

import {
    BROWSE_TOUCH_HEIGHT,
    BrowseToolbar,
    useBrowseWide,
} from "@/components/browse/BrowseToolbar";
import { BROWSE_LAYOUTS, RowsTilesSwitch } from "@/components/browse/RowsTilesSwitch";
import { CollectionMenu } from "@/components/collections/CollectionMenu";
import { PlaylistRow, ViewRow } from "@/components/collections/CollectionRows";
import { CollectionSections } from "@/components/collections/CollectionSections";
import { ViewCard } from "@/components/collections/ViewCard";
import { PlaylistCard } from "@/components/playlist/PlaylistCard";
import { LoadFailed } from "@/components/LoadFailed";
import { EmptyState } from "@/components/shell/EmptyState";
import { PageLoader } from "@/components/shell/PageLoader";
import { PagePlate } from "@/components/shell/PagePlate";
import { useCreatePlaylist, usePlaylists } from "@/lib/api/playlists";
import { useSavedFilters } from "@/lib/api/savedFilters";
import { matchesCollectionSearch } from "@/lib/collectionSearch";
import {
    defineView,
    enumField,
    flagField,
    textField,
    useUrlSearch,
    useUrlView,
} from "@/lib/urlView";
import { SearchInput } from "@/components/SearchInput";

/**
 * Everything that exposes a subset of the library, in one place (§14c).
 *
 * A saved view is a query and a playlist is a list, and that is the only difference between
 * them: both exist so somebody can get to a handful of things without searching for them
 * again. They had a page each — well, a page and a dropdown — which made them look like
 * unrelated features and let their rules drift apart, most visibly around who a pin belongs to.
 *
 * This is now the only index for either kind. `/playlists` was a second one, listing half of
 * what this page lists and reachable from a sidebar entry of its own; the sidebar said
 * "Collections" and then said "Playlists" underneath it, which is not a hierarchy anybody could
 * explain. A playlist keeps its own page at `/playlists/:id`, because a hand-ordered list is
 * not expressible as an address into the grid; that page's back link comes here.
 *
 * The sidebar carries the pinned few, for the same reason it always has: a nav with a row per
 * collection is a nav nobody can scan. This page is where the rest live, which is what keeps an
 * unpinned collection from being saved and then unreachable.
 *
 * Two sections per kind rather than four sections: yours, then what the house offers. A shared
 * collection is an administrator's, because sharing is curation — so the second section is the
 * curated baseline, and anybody may take any of it out of their own sidebar without it leaving
 * this page.
 *
 * **Browsed like the performer page, because it is the only way to all of them.** The library's
 * ⋯ menu used to list every saved view as well, and at eighty views that list ran off the
 * bottom of the screen with the current view's actions underneath it. It is gone, and this page
 * took the job with the performer page's controls in the performer page's order
 * (`BrowseToolbar`): All / Views / Playlists, a search over names and descriptions, A–Z or
 * recently changed, rows or tiles, and "Pinned only" where that page has "Favourites only". Each
 * row and tile has a ⋯ of its own, as a performer's does (`CollectionMenu`). All of it lives in
 * the address, so Back, a playlist's back link and the sidebar return to it.
 *
 * Rows by default, for the performer page's reason: a list of hundreds scans downward. No "Most
 * items", which the performer page has: a view's count is a scan of everything it matches, and
 * nothing in the app pays that for a number in a list (§20).
 */

const KINDS = ["all", "views", "playlists"] as const;
const SORTS = ["name", "updated"] as const;

const collectionsView = defineView("/collections", {
    kind: enumField("kind", KINDS, "all"),
    search: textField("q"),
    sort: enumField("sort", SORTS, "name"),
    layout: enumField("layout", BROWSE_LAYOUTS, "rows"),
    pinned: flagField("pinned"),
});

/** A–Z, or the most recently changed first: the two orders both kinds can answer. */
const ordered = <T extends { name: string; updatedAt: string }>(
    rows: T[],
    sort: (typeof SORTS)[number]
): T[] =>
    [...rows].sort((left, right) =>
        sort === "updated"
            ? right.updatedAt.localeCompare(left.updatedAt)
            : left.name.localeCompare(right.name)
    );

const CollectionsPage: React.FC = () => {
    const router = useRouter();
    const playlists = usePlaylists();
    const views = useSavedFilters();
    const wide = useBrowseWide();

    const [view, apply] = useUrlView(collectionsView);
    // The box filters as it is typed -- the lists are already on the page -- and the address
    // catches up once typing pauses.
    const [search, setSearch] = useUrlSearch(view.search, (settled) => apply({ search: settled }));

    const [naming, setNaming] = useState<null | { name: string; pinned: boolean }>(null);
    const create = useCreatePlaylist((playlist) => {
        setNaming(null);
        router.push(`/playlists/${playlist.id}`);
    });

    const loading = playlists.isLoading || views.isLoading;
    const failed = playlists.error ?? views.error;

    const viewCount = views.data?.filters.length ?? 0;
    const playlistCount = playlists.data?.playlists.length ?? 0;

    const matches = (row: { name: string; description: string | null; pinned: boolean }) =>
        matchesCollectionSearch(row, search) && (!view.pinned || row.pinned);
    const matchingViews = ordered((views.data?.filters ?? []).filter(matches), view.sort);
    const matchingPlaylists = ordered((playlists.data?.playlists ?? []).filter(matches), view.sort);
    const narrowed = search.trim() !== "" || view.pinned;
    // A section with nothing matching is left out while narrowed, rather than shown empty: its
    // "no views yet" would be untrue.
    const showViews = view.kind !== "playlists" && (!narrowed || matchingViews.length > 0);
    const showPlaylists = view.kind !== "views" && (!narrowed || matchingPlaylists.length > 0);
    const touch = wide ? undefined : { label: { lineHeight: BROWSE_TOUCH_HEIGHT } };

    /*
     * The tabs count what pressing them would show, so the numbers follow the search. Without
     * one they are the totals the eyebrow gives, but the tabs are where the eye is once the
     * plate has scrolled away.
     */
    const toolbar = (
        <>
            <SegmentedControl
                value={view.kind}
                onChange={(value) => apply({ kind: value as (typeof KINDS)[number] })}
                color="brass"
                size="sm"
                fullWidth={!wide}
                styles={touch}
                data={[
                    {
                        value: "all",
                        label: `All ${(matchingViews.length + matchingPlaylists.length).toLocaleString()}`,
                    },
                    { value: "views", label: `Views ${matchingViews.length.toLocaleString()}` },
                    {
                        value: "playlists",
                        label: `Playlists ${matchingPlaylists.length.toLocaleString()}`,
                    },
                ]}
            />
            <SearchInput
                placeholder="Find views and playlists"
                aria-label="Find views and playlists"
                value={search}
                onChange={setSearch}
                w={wide ? 240 : "100%"}
                styles={wide ? undefined : { input: { height: BROWSE_TOUCH_HEIGHT } }}
            />
            <SegmentedControl
                value={view.sort}
                onChange={(value) => apply({ sort: value as (typeof SORTS)[number] })}
                color="brass"
                size="sm"
                fullWidth={!wide}
                styles={touch}
                data={[
                    { value: "name", label: "A–Z" },
                    { value: "updated", label: "Recently changed" },
                ]}
            />
            <RowsTilesSwitch
                value={view.layout}
                onChange={(layout) => apply({ layout })}
                touch={!wide}
            />
            {/* "Favourites only" on the performer page: a pin is what marks a collection as one
                somebody reaches for. Brass, the sidebar's colour, where the heart there is
                oxblood. */}
            <Switch
                label="Pinned only"
                color="brass"
                checked={view.pinned}
                onChange={(event) => apply({ pinned: event.currentTarget.checked })}
            />
        </>
    );

    return (
        <Stack gap="lg">
            <PagePlate
                // What is here, once it is known; where this is until then (§14, "house rules").
                eyebrow={
                    loading || failed
                        ? "Views and playlists"
                        : `${viewCount} ${viewCount === 1 ? "view" : "views"} · ${playlistCount} ${playlistCount === 1 ? "playlist" : "playlists"}`
                }
                title="Views & playlists"
                actions={
                    /*
                     * One action, though there are two kinds here.
                     *
                     * A playlist starts empty and has to be named before anything can go in it,
                     * so making one is a gesture with nowhere else to live. A view is the
                     * opposite: it is *saved from* a library you have already narrowed, so a
                     * "New view" button here could only send you to the library to do the
                     * narrowing — which is what the empty state says in words instead.
                     */
                    <Button color="brass" onClick={() => setNaming({ name: "", pinned: true })}>
                        New playlist
                    </Button>
                }
            />

            {loading ? (
                <PageLoader />
            ) : failed ? (
                <LoadFailed
                    error={failed}
                    what="your collections"
                    onRetry={() => {
                        void playlists.refetch();
                        void views.refetch();
                    }}
                />
            ) : (
                <>
                    <BrowseToolbar>{toolbar}</BrowseToolbar>

                    {narrowed && !showViews && !showPlaylists && (
                        <EmptyState
                            title="Nothing matches that"
                            action={
                                <Button
                                    variant="light"
                                    color="brass"
                                    onClick={() => {
                                        setSearch("");
                                        apply({ pinned: false });
                                    }}
                                >
                                    Show everything
                                </Button>
                            }
                        >
                            {view.pinned && !search.trim()
                                ? "Nothing here is pinned to your sidebar."
                                : view.kind === "all"
                                  ? "No view or playlist matches what you asked for."
                                  : "Nothing on this tab matches what you asked for."}
                        </EmptyState>
                    )}

                    {showViews && (
                        <Stack gap="md">
                            <Stack gap={2}>
                                <Title order={4}>Views</Title>
                                <Text size="sm" c="dimmed">
                                    A view is a question, so it answers itself again every time it
                                    is opened — new items appear in it without anyone adding them.
                                </Text>
                            </Stack>

                            <CollectionSections
                                rows={matchingViews}
                                noun="views"
                                layout={view.layout}
                                render={(filter) => {
                                    const menu = (
                                        <CollectionMenu kind="filter" collection={filter} />
                                    );

                                    return view.layout === "rows" ? (
                                        <ViewRow key={filter.id} filter={filter} menu={menu} />
                                    ) : (
                                        <ViewCard key={filter.id} filter={filter} menu={menu} />
                                    );
                                }}
                                empty={
                                    <Text size="sm" c="dimmed">
                                        No views yet. Filter the library, then save what you are
                                        looking at.
                                    </Text>
                                }
                            />
                        </Stack>
                    )}

                    {showPlaylists && (
                        <Stack gap="md">
                            <Stack gap={2}>
                                <Title order={4}>Playlists</Title>
                                <Text size="sm" c="dimmed">
                                    A playlist is a hand-ordered list, so it holds exactly what was
                                    put in it, in the order it was put there.
                                </Text>
                            </Stack>

                            <CollectionSections
                                rows={matchingPlaylists}
                                noun="playlists"
                                layout={view.layout}
                                render={(playlist) => {
                                    const menu = (
                                        <CollectionMenu kind="playlist" collection={playlist} />
                                    );

                                    return view.layout === "rows" ? (
                                        <PlaylistRow
                                            key={playlist.id}
                                            playlist={playlist}
                                            menu={menu}
                                        />
                                    ) : (
                                        <PlaylistCard
                                            key={playlist.id}
                                            playlist={playlist}
                                            menu={menu}
                                        />
                                    );
                                }}
                                empty={
                                    <Text size="sm" c="dimmed">
                                        No playlists yet. Make one, then add items from the page of
                                        anything you are watching.
                                    </Text>
                                }
                            />
                        </Stack>
                    )}
                </>
            )}

            <Modal
                opened={naming !== null}
                onClose={() => setNaming(null)}
                title="New playlist"
                centered
            >
                <Stack gap="md">
                    <TextInput
                        label="Name"
                        placeholder="Sunday evening"
                        data-autofocus
                        value={naming?.name ?? ""}
                        // Read here rather than inside the updater: React clears
                        // `currentTarget` once the handler returns, and a functional update
                        // runs later.
                        onChange={(event) => {
                            const name = event.currentTarget.value;

                            setNaming((prev) => (prev ? { ...prev, name } : prev));
                        }}
                        onKeyDown={(event) =>
                            event.key === "Enter" &&
                            naming?.name.trim() &&
                            create.mutate({
                                name: naming.name.trim(),
                                visibility: "private",
                                pinned: naming.pinned,
                            })
                        }
                        error={create.isError ? (create.error as Error).message : null}
                    />

                    <Switch
                        label="Pin to the sidebar"
                        color="brass"
                        checked={naming?.pinned ?? false}
                        onChange={(event) => {
                            const pinned = event.currentTarget.checked;

                            setNaming((prev) => (prev ? { ...prev, pinned } : prev));
                        }}
                    />

                    <Group justify="flex-end" gap="sm">
                        <Button variant="subtle" color="gray" onClick={() => setNaming(null)}>
                            Cancel
                        </Button>
                        <Button
                            color="brass"
                            loading={create.isPending}
                            disabled={!naming?.name.trim()}
                            onClick={() =>
                                naming?.name.trim() &&
                                create.mutate({
                                    name: naming.name.trim(),
                                    visibility: "private",
                                    pinned: naming.pinned,
                                })
                            }
                        >
                            Create
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Stack>
    );
};

export default CollectionsPage;
