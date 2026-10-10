"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    Box,
    Button,
    Center,
    Checkbox,
    Drawer,
    Group,
    Indicator,
    Loader,
    Menu,
    Pagination,
    Paper,
    ScrollArea,
    SegmentedControl,
    Select,
    Stack,
    Text,
    Tooltip,
} from "@mantine/core";
import { useDisclosure, useElementSize, useMediaQuery } from "@mantine/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
    naturalDirection,
    sortHasDirection,
    sortOverride,
    type MediaCountResponse,
    type MediaListResponse,
    type MediaLookupResponse,
    type MediaSort,
    type SortDirection,
} from "@private-stock/core";

import { FilterPanel } from "@/components/FilterPanel";
import { ActiveFilterBar } from "@/components/library/ActiveFilterBar";
import { BulkTagDialog, type SuggestedTag } from "@/components/library/BulkTagDialog";
import { KindTabs } from "@/components/library/KindTabs";
import { LayoutSwitch } from "@/components/library/LayoutSwitch";
import { MoreGlyph } from "@/components/media/Glyph";
import { PagePlate } from "@/components/shell/PagePlate";
import { LibraryEmptyState } from "@/components/LibraryEmptyState";
import { LoadFailed } from "@/components/LoadFailed";
import { MediaTile } from "@/components/MediaTile";
import { PlayMenu } from "@/components/PlayMenu";
import { SelectionBar } from "@/components/library/SelectionBar";
import selectionClasses from "@/components/library/SelectionBar.module.scss";
import { useAuth } from "@/lib/api/AuthProvider";
import { GALLERY_TRACKS, GRID_GAP, GRID_TRACKS, PRIORITY_TILES } from "@/lib/gridGeometry";
import { api } from "@/lib/api/client";
import { useSavedFilters } from "@/lib/api/savedFilters";
import { SavedViewControl } from "@/components/library/SavedViewControl";
import {
    clearFilters,
    viewToSavedQuery,
    effectiveDirection,
    effectiveSort,
    hasClearableFilters,
    hasLook,
    leaveViewIfEmpty,
    PAGE_SIZE,
    parseView,
    viewToParams,
    viewToRequestParams,
    newShuffleSeed,
    withSort,
    type LibraryView,
} from "@/lib/libraryQuery";
import { readSelection, selectionOwner, writeSelection } from "@/lib/librarySelection";
import { useLiveUpdates } from "@/lib/events/useLiveUpdates";
import { refreshListPage } from "@/lib/events/patchList";
import { useLibraryFacets } from "@/lib/api/facets";
import { useLibraries, useLibraryStats } from "@/lib/api/libraries";
import { queryKeys } from "@/lib/api/queryKeys";
import { rememberTagNames } from "@/lib/rememberedPages";
import { rememberReturnTo } from "@/lib/returnTo";
import { DIRECTION_LABELS, SORT_LABELS } from "@/lib/sortWords";
import { SearchInput } from "@/components/SearchInput";

import classes from "./LibraryCellar.module.scss";

/**
 * The cellar: the library as a grid, paged.
 *
 * Numbered pages rather than an endless scroll, chosen for robustness over polish (§20). A
 * page is a URL: shareable, reloadable, bookmarkable, and the back button lands exactly where
 * it should. Nothing accumulates in the browser as you move through the library, there is no
 * scroll position to restore or lose, and — with 60 tiles on screen — no virtualizer.
 *
 * That last point removed a surprising amount of fragile machinery: the row virtualizer, the
 * width measurement it depended on, the re-measure effect that existed only because the
 * virtualizer caches row heights, and the "fetch when the last row appears" trigger. Sixty DOM
 * nodes need none of it, and `repeat(auto-fill, ...)` does the column arithmetic in the
 * browser rather than in TypeScript.
 *
 * Split out of the route so that `/` can be the room instead (§14). The two pages want
 * genuinely different shapes -- one is a warehouse you search, the other is a place you
 * arrive -- and a single component switching between them was 500 lines holding two layouts
 * that shared a toolbar and nothing else.
 */

/** The sorts the menu offers, in the order it offers them. */
const SORT_OPTIONS: { value: MediaSort; label: string }[] = (
    [
        "addedAt",
        "capturedAt",
        "title",
        "duration",
        "size",
        "resolution",
        "bitrate",
        "fps",
        "rating",
        "lastViewed",
        "random",
    ] as const
).map((value) => ({ value, label: SORT_LABELS[value] }));

/**
 * Relevance is offered only while there is something to rank.
 *
 * Without a search term every row scores identically, so the option would silently behave like
 * a shuffle — and someone who picked it, cleared the search, and got a scrambled library would
 * have no way to connect the two.
 */
const sortOptions = (
    searching: boolean,
    looking: boolean
): { value: MediaSort; label: string }[] =>
    looking
        ? [{ value: "look", label: SORT_LABELS.look }, ...SORT_OPTIONS]
        : searching
          ? [{ value: "relevance", label: SORT_LABELS.relevance }, ...SORT_OPTIONS]
          : SORT_OPTIONS;

/**
 * Sort and direction, as two controls again.
 *
 * They were merged into one Select -- "Title · A–Z", "Date added · Newest" -- to thin out a
 * toolbar that had grown to five controls of equal weight. The saving was real and the cost
 * was worse: every sort appeared twice in one list, so choosing an order meant reading
 * fourteen options to find the field you wanted, and the field and its order were separated
 * by a middot rather than by being separate things.
 *
 * Two controls also make the direction *visible* rather than buried in the selected label,
 * which is what turns reversing an order into one click instead of reopening a menu and
 * finding the neighbouring row.
 *
 * The direction keeps its words rather than becoming an arrow, which was the good half of
 * the merge and survives it: "ascending" on a date could reasonably mean newest or oldest
 * first, and the person reading it would have to guess. "Newest" cannot be misread.
 */

/** The page's title when it is not a library or a saved view: the shelf you are on. */
const KIND_TITLES: Record<LibraryView["kind"], string> = {
    video: "Videos",
    image: "Photos",
    all: "All items",
};

/** A thumb's worth, for the controls that stay on screen on a phone (CLAUDE.md). */
const TOUCH_HEIGHT = "2.75rem";

/** The selection before anything has set it -- see `selected` below. */
const NO_SELECTION: string[] = [];

export const LibraryCellar: React.FC = () => {
    const router = useRouter();
    const searchParams = useSearchParams();

    const urlView = parseView(new URLSearchParams(searchParams.toString()));

    /**
     * The search box, and the search the grid asks.
     *
     * Two values, because typing is debounced: the box shows every keystroke, and the grid
     * follows 300ms after the last one. Debounced by hand rather than with `useDebouncedValue`
     * because a search changed from *outside* the box -- the chip's ×, "clear all", opening or
     * closing a saved view -- has to reach both at once. The chip's × used to change the address
     * and nothing else, and the grid kept reading the old term from the box, so it did nothing.
     */
    const [search, setSearch] = useState(urlView.search);
    const [debouncedSearch, setDebouncedSearch] = useState(urlView.search);

    /**
     * The search the address already carries, or is about to.
     *
     * What the effect below compares against, rather than the address itself: after a change
     * from outside the box, the address has been asked to change and has not yet, and comparing
     * with it would write the *old* address back with the new term -- undoing a "clear all".
     */
    const settledSearch = useRef(urlView.search);

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(search), 300);

        return () => clearTimeout(timer);
    }, [search]);

    /**
     * A search changed by navigation: the address is the truth, and the box follows it.
     *
     * Opening a saved view from the sidebar or the Views page is a plain link, and so is Back --
     * neither goes through `applyView`. Without this the old term stayed in the box and in the
     * grid's request, so a view opened on top of a search showed its own filters *and* the
     * search, and the next change wrote the search back into the address.
     */
    useEffect(() => {
        if (urlView.search !== settledSearch.current) {
            settledSearch.current = urlView.search;
            setSearch(urlView.search);
            setDebouncedSearch(urlView.search);
        }
    }, [urlView.search]);

    const view: LibraryView = { ...urlView, search: debouncedSearch };
    // Shared with the panel and the chips, so this costs no request of its own.
    const facets = useLibraryFacets(view);
    const gallery = view.mode === "gallery";

    // The names behind this search's tags, for the sidebar's "Last search" line, which cannot
    // ask for them without paying for the search again (`rememberTagNames`).
    const referencedTags = facets.data?.referencedTags;

    useEffect(() => {
        if (!referencedTags) return;

        const names = Object.entries(referencedTags).map(([id, tag]) => [id, tag.name]);

        if (names.length > 0) rememberTagNames(Object.fromEntries(names));
    }, [referencedTags]);

    const [filtersOpen, filters] = useDisclosure(false);
    const wide = useMediaQuery("(min-width: 62em)");

    /** The pinned working row's height, which the pinned filter column sits beneath. */
    const { ref: toolbarRef, height: toolbarHeight } = useElementSize();

    const { user, hasScope } = useAuth();

    /**
     * The ticked items, and the anchor a shift-click extends from.
     *
     * **Cleared whenever the view changes** — a page turn, a filter, a sort. That is what
     * keeps "a selection you can see is a selection you can check" true (§14b): a selection
     * that survived a page turn would be a set nobody is looking at, aimed at a Trash button,
     * which is the same objection that rejected select-all-312 in the first place.
     *
     * Kept for the view it was made on, though, so opening an item and coming Back finds it
     * still ticked (`lib/librarySelection.ts`). Starts as `NO_SELECTION` rather than a fresh
     * `[]` so the effect that stores it can tell "nothing has happened yet" from "cleared".
     */
    const [selected, setSelected] = useState<string[]>(NO_SELECTION);
    const [bulkTagging, setBulkTagging] = useState(false);
    const anchorRef = useRef<string | null>(null);

    /**
     * What the last bulk action did, kept here rather than in the bar.
     *
     * Applying an action clears the selection, which unmounts the bar — so a message
     * rendered inside it would be destroyed by the same event that produced it. "11 items
     * updated. 3 could not be: this item is in a read-only root" is the whole value of
     * reporting per item, and it has to outlive the control that triggered it.
     */
    const [outcome, setOutcome] = useState<string | null>(null);

    const applyView = (next: LibraryView) => {
        // A search set by something other than typing: the box and the grid take it now, and
        // the debounce has nothing left to do.
        if (next.search !== settledSearch.current) {
            settledSearch.current = next.search;
            setSearch(next.search);
            setDebouncedSearch(next.search);
        }

        const params = viewToParams(next);

        router.replace(params.toString() ? `/?${params.toString()}` : "/", { scroll: false });
    };

    /**
     * Any change to the filter returns to page one.
     *
     * Staying on page 40 of a result set that just shrank to three shows an empty grid with no
     * explanation, and "nothing matched your filter" would be a lie.
     */
    const applyFilter = (next: LibraryView) =>
        // `leaveViewIfEmpty` here rather than in each control: removing the last chip and
        // pressing "clear all" end in the same grid and have to mean the same thing (§14e).
        applyView(leaveViewIfEmpty({ ...next, page: 0 }));

    useEffect(() => {
        if (debouncedSearch !== settledSearch.current) {
            // Settled first, so `applyView` does not treat this as a change from outside and
            // write the debounced term back into a box somebody is still typing in.
            settledSearch.current = debouncedSearch;
            applyFilter({ ...urlView, search: debouncedSearch });
        }
        // applyView closes over the current URL; re-running on every parameter change would
        // fight the user's typing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedSearch]);

    /**
     * One serialization of the filter, shared by the page, the count and the facet panel.
     *
     * All three must ask the same question or they disagree with each other — a panel offering
     * counts the grid cannot reproduce, or a page count that does not match the pages you can
     * actually reach.
     */
    const filterParams = viewToRequestParams({ ...view, sort: effectiveSort(view) });

    const fetchPage = (page: number) => {
        const params = new URLSearchParams(filterParams);

        params.set("limit", String(PAGE_SIZE));
        params.set("page", String(page));

        return api<MediaListResponse>(`/api/media?${params.toString()}`);
    };

    const pageQuery = useQuery({
        queryKey: queryKeys.media.page(filterParams.toString(), view.page),
        queryFn: () => fetchPage(view.page),
        // Keeps the previous page on screen while the next loads, so paging does not flash an
        // empty grid on every click.
        placeholderData: (previous) => previous,
    });

    /**
     * The count, keyed on the filter alone (§20).
     *
     * Deliberately not part of the page request and deliberately not keyed on the page: an
     * exact count is a scan of the whole matching set, three orders of magnitude dearer than
     * the page itself, and its answer cannot change by turning a page. Keyed this way it is
     * fetched once when the filter changes and served from cache for every page after.
     */
    const countQuery = useQuery({
        queryKey: queryKeys.media.count(filterParams.toString()),
        queryFn: () => api<MediaCountResponse>(`/api/media/count?${filterParams.toString()}`),
        staleTime: 60_000,
    });

    const items = pageQuery.data?.items ?? [];

    // Keyed on the whole address rather than the page number: changing a filter can leave
    // the page number alone while changing everything on it.
    const addressKey = viewToParams(view).toString();
    const owner = user ? selectionOwner(user.id, addressKey) : null;

    // A new view starts with whatever was kept for it -- which is nothing, unless this is the
    // view the kept selection was made on and we are coming back to it.
    useEffect(() => {
        setSelected(owner ? readSelection(owner) : []);
        anchorRef.current = null;
        setOutcome(null);
    }, [owner]);

    useEffect(() => {
        // Not before anything has happened: storing the opening empty selection would wipe
        // the kept one before the effect above has read it back, under React's doubled
        // effects in development.
        if (owner && selected !== NO_SELECTION) writeSelection(owner, selected);
        // Keyed on the selection alone. A change of view resets the selection first, and that
        // reset is what gets stored -- writing the old selection under the new address on the
        // way would be a set restored onto a view it was not chosen from.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected]);

    /**
     * A ticked item that has left the page is no longer ticked.
     *
     * Matters for a kept selection most: the item opened from it may have been trashed, or
     * retagged out of the filter, while the grid was away. Not against placeholder data, which
     * is the page before this one. After the restore above, and keyed on it too, so a selection
     * brought back onto a page already in the cache is checked against it.
     */
    useEffect(() => {
        if (!pageQuery.data || pageQuery.isPlaceholderData) return;

        const onPage = new Set(pageQuery.data.items.map((item) => item.id));

        setSelected((current) =>
            current.every((id) => onPage.has(id)) ? current : current.filter((id) => onPage.has(id))
        );
    }, [pageQuery.data, pageQuery.isPlaceholderData, owner]);

    /**
     * Ticking one tile, or a run of them.
     *
     * Shift extends from the last tile ticked to this one, in the order the grid is showing
     * — which is the order on screen, not the order ids happen to arrive in. Without an
     * anchor, selecting twenty adjacent items is twenty clicks.
     */
    const toggleSelected = (mediaId: string, shiftKey: boolean) => {
        const anchor = anchorRef.current;

        if (shiftKey && anchor && anchor !== mediaId) {
            const order = items.map((item) => item.id);
            const from = order.indexOf(anchor);
            const to = order.indexOf(mediaId);

            if (from >= 0 && to >= 0) {
                const run = order.slice(Math.min(from, to), Math.max(from, to) + 1);

                setSelected((current) => [...new Set([...current, ...run])]);
                anchorRef.current = mediaId;

                return;
            }
        }

        anchorRef.current = mediaId;
        setSelected((current) =>
            current.includes(mediaId)
                ? current.filter((id) => id !== mediaId)
                : [...current, mediaId]
        );
    };

    /** Select-all takes the page, and only the page (§14b). */
    const pageIds = items.map((item) => item.id);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
    // For the empty state, any narrowing by kind counts: Videos in a library of photos is
    // "nothing matches", not "nothing here yet" (`isFiltered` treats Videos as the library).
    const filtered = hasClearableFilters(view) || view.kind !== "all";

    const queryClient = useQueryClient();

    /**
     * Play from the top: the first item of the set, opened in the viewer with the set behind it.
     *
     * Page one of the set whichever page is on screen, under the grid's own key so it is a cache
     * hit when page one is what is showing. The address recorded for the viewer is this view at
     * page one, because that is where the item is -- recording the page on screen would have the
     * viewer look for it there and find no neighbours. Back still lands on the grid: the viewer
     * corrects the address to wherever playback got to (§14b).
     *
     * The first item, photo or not. The viewer's set is mixed and a photo is a still that
     * advances after its dwell (see `stageDwell`), so skipping ahead to the first video would
     * start somewhere other than the top -- which Showcase and Tasting never do.
     */
    const playFromTop = async () => {
        const first = await queryClient.fetchQuery({
            queryKey: queryKeys.media.page(filterParams.toString(), 0),
            queryFn: () => fetchPage(0),
            staleTime: 30_000,
        });
        const target = first.items[0];

        if (!target) return;

        rememberReturnTo(`/?${viewToParams({ ...view, page: 0 }).toString()}`);
        router.push(`/media/${target.id}`);
    };

    /**
     * The page on screen, re-checked rather than refetched (§13b).
     *
     * Asks about exactly the items showing: each is updated where it stands -- a probe's title
     * and duration, a tag -- and one that has left the library drops out. A refetch would also
     * bring in whatever arrived since, which is what the new-items button is for. The count
     * is refetched only when something left, since that is the only change it can see.
     */
    const recheckPage = async () => {
        if (pageIds.length === 0) return;

        const pageKey = queryKeys.media.page(filterParams.toString(), view.page);
        const fresh = await api<MediaLookupResponse>(`/api/media/lookup?ids=${pageIds.join(",")}`);

        queryClient.setQueryData<MediaListResponse>(pageKey, (page) =>
            refreshListPage(page, fresh.items)
        );

        if (fresh.items.length < pageIds.length) {
            void queryClient.invalidateQueries({
                queryKey: queryKeys.media.count(filterParams.toString()),
            });
        }
    };

    /**
     * New items wait to be asked for (§13b, §14b).
     *
     * They used to apply immediately, on the reasoning that a page is a fixed window that
     * either changed or did not. But a changed window is still the list moving under you:
     * during a scan a newest-first page turned over every few seconds, and a shuffle took new
     * items into its pages. What arrives becomes a count beside the list, applied when you
     * choose; changes to what is already showing are applied in place by `recheckPage`.
     */
    const live = useLiveUpdates({
        autoApply: false,
        // A failed re-check leaves the page as it was, which is never wrong for long: the
        // next change re-checks again, and any view change refetches.
        onItemsChanged: () => void recheckPage().catch(() => undefined),
    });

    const { data: stats } = useLibraryStats();

    // Shuffled or not: a shuffle is an ordering of the matching set like any other sort, so it
    // has the same count and the same pages (§20).
    const pageCount = countQuery.data?.pageCount ?? null;
    const total = countQuery.data?.total ?? null;

    const summary = (): string => {
        if (pageQuery.isLoading) return "Loading…";
        if (total === null) return `${items.length} shown`;

        return `${total.toLocaleString()} item${total === 1 ? "" : "s"}${
            live.busy ? " · scanning…" : ""
        }`;
    };

    /** Mantine's Pagination is 1-based; the URL and the API are 0-based. */
    const goToPage = (page: number) => {
        applyView({ ...view, page: Math.max(0, page - 1) });
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const showPager = pageCount === null ? (pageQuery.data?.hasMore ?? false) : pageCount > 1;

    /**
     * A remembered page the list no longer reaches goes to the last one that exists (§14b).
     *
     * The Library link restores the page as well as the filter now, and a list can shrink
     * while you are away -- items trashed, a filter's matches retagged. Landing past the end
     * would show "nothing matches your filters" above a pager saying otherwise.
     */
    useEffect(() => {
        if (pageCount !== null && view.page > 0 && view.page >= pageCount) {
            applyView({ ...view, page: Math.max(0, pageCount - 1) });
        }
        // `applyView` and `view` are rebuilt every render; the page and the count are the inputs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pageCount, view.page]);

    /**
     * Which library this is, when it is one.
     *
     * Its own query rather than a prop: the room asks the same question under the same key,
     * so opening a library from there is answered from cache and the heading is right on the
     * first paint instead of appearing a moment later.
     */
    const { data: libraries } = useLibraries();

    /**
     * What this page is called.
     *
     * "All items" rather than "Library" for the unscoped grid, because the room is what the
     * navigation calls the Library -- two pages with the same heading, one of them reachable
     * from the other, is how you lose track of which one you are on.
     */
    const { data: savedFilters } = useSavedFilters();

    /**
     * The saved filter this view was opened from, if it still exists.
     *
     * Looked up rather than trusted: the id travels in the URL, so it can name a filter that
     * has since been deleted, or one belonging to somebody else. Not finding it simply means
     * the page is an ordinary filtered view, which is what it looks like anyway.
     */
    const currentFilter = view.filterId
        ? savedFilters?.filters.find((filter) => filter.id === view.filterId)
        : undefined;

    /**
     * What this page is called.
     *
     * A saved filter's name wins over the library's. You came here by its name, the sidebar
     * highlights it by its name, and "All items" over a view called "Unrated 4K" is the page
     * disagreeing with the two things that brought you to it.
     */
    const libraryLabel =
        currentFilter?.name ??
        (view.root
            ? (libraries?.libraries.find((entry) => entry.id === view.root)?.label ?? "Library")
            : KIND_TITLES[view.kind]);

    /**
     * The line above the title: where this sits, not what it is.
     *
     * A saved view says so, because its name is the user's and could be anything; a library and
     * the unscoped grid are both the Library.
     */
    const eyebrow = currentFilter ? "Saved view" : "Library";

    /** A phone, or anything as narrow: controls stand 44px for a thumb (CLAUDE.md). */
    const touch = !wide;
    const touchHeight = touch ? TOUCH_HEIGHT : undefined;

    /**
     * Sort and direction.
     *
     * On a phone these live in the filter drawer rather than in the toolbar, which is also
     * what makes splitting the order back into two controls affordable: controls wrapping
     * across a 412px screen cost about 200px of chrome before a single tile appears -- more
     * vertical space than the first row of the library they are there to arrange. The kind is
     * not here any more: it is the tabs under the title, on every screen size, because it is
     * the choice made first and most often.
     */
    const sort = effectiveSort(view);

    /**
     * A "find untagged" list is shown by date added whatever it was sorted by (§14b, §20): the
     * server runs it that way, so the controls say so rather than offering an order that would
     * not be honoured. Shown, not written -- the address and a saved filter keep their own sort,
     * which returns as soon as the filter stops being one of untagged items.
     */
    const looking = hasLook(view);
    /**
     * A look is shown best match first whatever the view's sort (§5e), as the server runs it;
     * the view's own sort returns when the look is cleared. Asked of core without the look
     * fields, which the view holds as "" for none and core reads as asked.
     */
    const overridden: MediaSort | null = looking
        ? "look"
        : sortOverride({ ...view, lookText: undefined, like: undefined });
    const shownSort = overridden ?? sort;
    const overrideNote = looking
        ? "A look is shown best match first. Your chosen order returns when the look is cleared."
        : "Untagged lists are shown newest first, so tagging through them stays quick. " +
          "Your chosen order returns when this filter changes.";

    const orderControls = (stacked: boolean) => {
        const controls = (
            <>
                <Select
                    value={shownSort}
                    onChange={(value) =>
                        applyFilter(withSort(view, (value ?? "addedAt") as MediaSort))
                    }
                    data={sortOptions(Boolean(debouncedSearch), looking)}
                    allowDeselect={false}
                    disabled={overridden !== null}
                    w={stacked ? "100%" : 170}
                    aria-label="Sort by"
                />

                {/* Absent rather than disabled when there is no second direction to offer: a
                    permutation read backwards is just another permutation, and the far end of
                    relevance is "worst match". A greyed pair would invite somebody to work out
                    why, and neither answer is one they can act on. */}
                {sortHasDirection(shownSort) && (
                    <SegmentedControl
                        fullWidth={stacked}
                        value={overridden ? naturalDirection(overridden) : effectiveDirection(view)}
                        onChange={(value) =>
                            applyFilter({ ...view, direction: value as SortDirection })
                        }
                        data={[
                            { value: "asc", label: DIRECTION_LABELS[shownSort][0] },
                            { value: "desc", label: DIRECTION_LABELS[shownSort][1] },
                        ]}
                        disabled={overridden !== null}
                        aria-label="Order"
                    />
                )}

                {view.sort === "random" && !overridden && (
                    // A new seed is a new permutation, so this is a genuine reshuffle rather
                    // than a re-fetch of the same order.
                    <Button
                        variant="default"
                        fullWidth={stacked}
                        onClick={() => applyFilter({ ...view, seed: newShuffleSeed() })}
                    >
                        Reshuffle
                    </Button>
                )}
            </>
        );

        if (!overridden) return controls;

        // A tooltip on the toolbar; in the phone drawer, where nothing hovers, the same words
        // under the controls.
        return stacked ? (
            <>
                {controls}
                <Text size="xs" c="dimmed">
                    {overrideNote}
                </Text>
            </>
        ) : (
            <Tooltip label={overrideNote} multiline w={260} withArrow>
                <Group gap="xs" wrap="nowrap">
                    {controls}
                </Group>
            </Tooltip>
        );
    };

    const searchBox = (
        <SearchInput
            placeholder="Search"
            value={search}
            onChange={setSearch}
            w={wide ? 240 : undefined}
            style={wide ? undefined : { flex: 1, minWidth: 0 }}
            styles={touch ? { input: { height: TOUCH_HEIGHT } } : undefined}
        />
    );

    /**
     * The tag a "Find untagged" came from, offered for what it found (§5d).
     *
     * Named by the facet response the panel already holds, which carries the tag's facet and
     * whether it is private -- so the offer files it exactly where the tag lives, and offers
     * nothing for a tag this viewer cannot see.
     */
    const mentioned = view.mentions ? facets.data?.referencedTags[view.mentions] : undefined;
    const suggestedTag: SuggestedTag | null = mentioned
        ? {
              name: mentioned.name,
              kind: mentioned.kind,
              scope: mentioned.private ? "private" : "public",
          }
        : null;
    // Saying the items found are somebody else: the owner's for a private tag, an
    // administrator's for the library's.
    const refusable =
        view.mentions && mentioned && (mentioned.private || hasScope("admin"))
            ? { tagId: view.mentions, name: mentioned.name }
            : null;

    /* The rare actions, out of the everyday controls. Tag matching is a bulk write, and only
       once a real filter narrows something: the kind alone would offer to tag every video,
       which is never the intent and is the one gesture with no cheap way back (§5d). */
    // Not while a look is in force: "everything matching" is sent as a saved query, which cannot
    // carry a look yet, so it would reach the whole filter rather than the few hundred on
    // screen (§5e). Selecting tiles sends their ids, and still works.
    const moreMenu = hasClearableFilters(view) && !looking && (
        <Menu position="bottom-end" withinPortal>
            <Menu.Target>
                <Button variant="subtle" color="gray" h={touchHeight} aria-label="More actions">
                    <MoreGlyph size={18} />
                </Button>
            </Menu.Target>
            <Menu.Dropdown>
                <Menu.Item onClick={() => setBulkTagging(true)}>Tag everything matching…</Menu.Item>
            </Menu.Dropdown>
        </Menu>
    );

    const kindTabs = (
        <KindTabs
            view={view}
            onChange={(kind) => applyFilter({ ...view, kind })}
            touch={touch}
            inline={wide}
        />
    );

    return (
        <Stack gap="md" __vars={{ "--cellar-toolbar-h": `${toolbarHeight}px` }}>
            {/*
             * Two tiers, each with a fixed place (§14b):
             *
             *   1. the plate -- where you are, the saved view's state, and the two ways of
             *      looking at this set: Play (which leaves the page) and Grid/Gallery;
             *   2. the working row -- which shelf, search, order, and the rare actions behind
             *      a menu. One line on a wide screen, pinned under the header as the grid
             *      scrolls; the shelf tabs over the search on a phone.
             *
             * It used to be one wrapping row of eleven controls of equal weight, which jumped
             * whenever a button appeared or the chips beside the title grew, so the control
             * wanted most never had a fixed position.
             */}
            <PagePlate
                eyebrow={eyebrow}
                title={libraryLabel}
                // A phone's alone: there the navigation is behind the burger. On a wide screen
                // Home is in the sidebar beside it, and the link was a second copy of it.
                back={{ href: "/", label: "Home", phoneOnly: true }}
                aside={<SavedViewControl view={view} onApply={applyView} />}
                actions={
                    <Group gap="xs" wrap="nowrap">
                        <PlayMenu
                            setParams={viewToParams(view)}
                            onFromTop={() => void playFromTop().catch(() => undefined)}
                            empty={total === 0}
                            height={touchHeight}
                        />

                        <LayoutSwitch
                            value={gallery ? "gallery" : "grid"}
                            onChange={(mode) => applyView({ ...view, mode })}
                            touch={touch}
                        />
                    </Group>
                }
            />

            {wide ? (
                <Box ref={toolbarRef} className={classes.toolbar}>
                    {kindTabs}
                    {searchBox}
                    <Group gap="sm" wrap="nowrap">
                        {orderControls(false)}
                    </Group>
                    {moreMenu && <Box className={classes.toolbarEnd}>{moreMenu}</Box>}
                </Box>
            ) : (
                <>
                    {kindTabs}

                    <Group gap="sm" wrap="nowrap">
                        {searchBox}

                        <Indicator
                            label={view.tags.length || undefined}
                            size={16}
                            disabled={!hasClearableFilters(view)}
                            color="brass"
                        >
                            <Button variant="default" h={touchHeight} onClick={filters.open}>
                                Filters
                            </Button>
                        </Indicator>

                        {moreMenu}
                    </Group>
                </>
            )}

            <Group gap="sm" align="center" wrap="wrap">
                <Text size="sm" c="dimmed">
                    {summary()}
                </Text>

                {live.pendingCount > 0 && (
                    <Button variant="light" color="brass" onClick={live.applyPending}>
                        Show {live.pendingCount.toLocaleString()} new item
                        {live.pendingCount === 1 ? "" : "s"}
                    </Button>
                )}

                {/* Beside the count rather than above the grid, because the count is the
                    number these are responsible for -- "312 items" and the reasons it is not
                    the whole library belong on one line (§14e). */}
                <ActiveFilterBar view={view} onChange={applyFilter} />

                {/* Out in the open, unlike "Tag everything matching" in the menu: tagging
                    what was found is the reason this view exists. Still through the dialogue,
                    which shows the count and writes a batch that can be withdrawn. */}
                {suggestedTag && items.length > 0 && !looking && (
                    <Button
                        size="compact-sm"
                        variant="light"
                        color="brass"
                        onClick={() => setBulkTagging(true)}
                    >
                        Tag all as {suggestedTag.name}…
                    </Button>
                )}
            </Group>

            <Group align="flex-start" gap="md" wrap="nowrap">
                {wide && (
                    <Box className={classes.filterColumn}>
                        <ScrollArea h="100%">
                            {/* Its own "Clear all" is left to the phone drawer: here the chips
                                beside the count are on screen too, with theirs. */}
                            <FilterPanel view={view} onChange={applyFilter} clearAll={false} />
                        </ScrollArea>
                    </Box>
                )}

                <Box style={{ flex: 1, minWidth: 0 }}>
                    {/* Takes the page, and only the page (§14b). The Gmail pattern -- select
                        the page, then offer to extend to all 312 matching -- is genuinely more
                        powerful, and the power is pointed at a Trash button. A selection you
                        can see is a selection you can check.

                        Above the grid it acts on, not in the status line beside the chips,
                        where it read as one more filter. */}
                    {items.length > 0 && (
                        <Checkbox
                            mb="sm"
                            size={touch ? "md" : "xs"}
                            color="brass"
                            checked={allSelected}
                            indeterminate={!allSelected && selected.length > 0}
                            label="Select page"
                            onChange={() =>
                                setSelected(
                                    allSelected
                                        ? selected.filter((id) => !pageIds.includes(id))
                                        : [...new Set([...selected, ...pageIds])]
                                )
                            }
                        />
                    )}

                    {pageQuery.isLoading ? (
                        <Center h={200}>
                            <Loader color="brass" />
                        </Center>
                    ) : /* Before the empty state, not after it: a page that did not arrive
                          used to be reported as a library with nothing in it, offering to
                          clear filters that were never the problem. */
                    pageQuery.isError ? (
                        <LoadFailed
                            error={pageQuery.error}
                            what="this page"
                            onRetry={() => void pageQuery.refetch()}
                        />
                    ) : items.length === 0 ? (
                        <LibraryEmptyState
                            stats={stats}
                            filtered={filtered}
                            onClearFilters={() => {
                                setSearch("");
                                // The library you are in, the way you are looking at it and
                                // the order it is in are not filters, so clearing the filters
                                // must not change any of them. `clearFilters` is the single
                                // definition of which fields that leaves -- spelling it out
                                // here is how a filter added later ends up uncleavable.
                                // It keeps the kind, so when the kind is all that is left --
                                // Videos in a library without any -- this is the one clear
                                // that has to let go of it, or the button would do nothing.
                                applyView(
                                    hasClearableFilters(view)
                                        ? clearFilters(view)
                                        : { ...clearFilters(view), kind: "all" }
                                );
                            }}
                        />
                    ) : (
                        <Box
                            style={{
                                display: "grid",
                                // The browser does the column arithmetic, so there is nothing
                                // to measure and nothing to get wrong on the first render.
                                gridTemplateColumns: gallery ? GALLERY_TRACKS : GRID_TRACKS,
                                gap: GRID_GAP,
                                // Dimmed rather than replaced while the next page loads:
                                // swapping to a spinner makes every page turn flash.
                                opacity: pageQuery.isPlaceholderData ? 0.6 : 1,
                                transition: "opacity 120ms",
                            }}
                        >
                            {items.map((item, index) => (
                                <MediaTile
                                    key={item.id}
                                    item={item}
                                    moment={pageQuery.data?.moments?.[item.id]}
                                    gallery={gallery}
                                    selected={selected.includes(item.id)}
                                    onToggleSelected={toggleSelected}
                                    priority={index < PRIORITY_TILES}
                                />
                            ))}
                        </Box>
                    )}

                    {showPager && (
                        <Center py="lg">
                            {pageCount === null ? (
                                // Until the count arrives -- or if it fails -- plain
                                // next/previous, rather than a page list it cannot populate
                                // honestly.
                                <Group gap="sm">
                                    <Button
                                        variant="default"
                                        disabled={view.page === 0}
                                        onClick={() => goToPage(view.page)}
                                    >
                                        Previous
                                    </Button>
                                    <Text size="sm" c="dimmed">
                                        Page {view.page + 1}
                                    </Text>
                                    <Button
                                        variant="default"
                                        disabled={!pageQuery.data?.hasMore}
                                        onClick={() => goToPage(view.page + 2)}
                                    >
                                        Next
                                    </Button>
                                </Group>
                            ) : (
                                <Pagination
                                    value={view.page + 1}
                                    onChange={goToPage}
                                    total={pageCount}
                                    color="brass"
                                    siblings={wide ? 2 : 0}
                                    withEdges
                                />
                            )}
                        </Center>
                    )}
                </Box>
            </Group>

            <Drawer
                opened={filtersOpen && !wide}
                onClose={filters.close}
                title="Filter and sort"
                position="bottom"
                // Tall enough for its contents and no taller. At a fixed 85% roughly the
                // bottom third was empty on a library with few facets.
                size="fit-content"
                styles={{ content: { maxHeight: "88dvh", overflowY: "auto" } }}
            >
                <Stack gap="lg">
                    {!wide && <Stack gap="sm">{orderControls(true)}</Stack>}
                    <FilterPanel view={view} onChange={applyFilter} heading={false} />
                </Stack>
            </Drawer>

            {/* Outside the selection block: this tags what the *filter* matches, which is a
                different set from what is ticked and is available whether or not anything is. */}
            <BulkTagDialog
                key={suggestedTag?.name ?? ""}
                suggested={suggestedTag}
                opened={bulkTagging}
                onClose={() => setBulkTagging(false)}
                // The same query the grid and its count came from, so the number in the
                // dialogue is the number on screen rather than a second reading of the filter
                // that has to be kept in step.
                target={{
                    type: "filter",
                    query: viewToSavedQuery(view),
                    filterId: view.filterId,
                }}
                onApplied={setOutcome}
            />

            {selected.length > 0 && (
                <SelectionBar
                    selected={selected}
                    onClear={() => {
                        setSelected([]);
                        setOutcome(null);
                    }}
                    canDelete={hasScope("delete")}
                    suggestedTag={suggestedTag}
                    refusable={refusable}
                    // Cleared after anything is applied: the items may no longer be on the
                    // page, and a selection naming items that have left it is a set nobody
                    // can check.
                    onApplied={(result) => {
                        setSelected([]);
                        setOutcome(result);
                    }}
                />
            )}

            {/* Takes the bar's place rather than appearing beside it, so the eye stays where
                it already was. Dismissed by hand: an action that partly failed is worth
                reading at whatever pace, and a message that times out is one somebody looks
                up to find gone. */}
            {selected.length === 0 && outcome && (
                <Paper className={selectionClasses.bar} shadow="md" radius="md" withBorder>
                    <Group gap="sm" wrap="nowrap">
                        <Text size="sm">{outcome}</Text>
                        <Button size="compact-xs" variant="subtle" onClick={() => setOutcome(null)}>
                            Dismiss
                        </Button>
                    </Group>
                </Paper>
            )}
        </Stack>
    );
};
