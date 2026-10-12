"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Box, CloseButton, NavLink, Text, type NavLinkProps } from "@mantine/core";

import type { CollectionKind } from "@private-stock/core";

import { useAuth } from "@/lib/api/AuthProvider";
import { usePlaylists } from "@/lib/api/playlists";
import { useSavedFilters } from "@/lib/api/savedFilters";
import { parseView, savedFilterHref } from "@/lib/libraryQuery";
import { useLibraries } from "@/lib/api/libraries";
import { useProcessingPause } from "@/lib/api/processing";
import {
    FIRST_LIBRARY_QUERY,
    forgetLastLibrarySearch,
    useLastLibrarySearch,
    useRememberedHref,
    useRememberedSectionHref,
    useRememberedTagNames,
    useRememberPages,
} from "@/lib/rememberedPages";
import { summarizeSearch } from "@/lib/searchSummary";
import { ListGlyph, ViewGlyph } from "@/components/media/Glyph";
import { Odometer } from "@/components/Odometer";

import classes from "./AppNavbar.module.scss";

/**
 * The navigation, and the libraries in it.
 *
 * Its own component because of `useSearchParams`. Called in the shared layout it opts *every*
 * page underneath out of static rendering — Next bails the whole subtree out of prerendering
 * unless the hook sits behind a Suspense boundary, and the build fails naming a page that has
 * nothing to do with it. Extracted here, one boundary in the layout covers it and the rest of
 * the app is unaffected.
 */
/**
 * The shell's own horizontal padding, so a nav label lands directly under the wordmark.
 *
 * The header pads with `--app-shell-padding` and the navbar used to add its own on top of
 * NavLink's default, which put the labels 8px right of the wordmark in the same corner.
 */
const navPadding = { paddingInline: "calc(var(--app-shell-padding) - 6px)" };

/** Smallest to largest: a still, a span, a sequence of spans. */
const STUDIO_PAGES = [
    { href: "/captures", label: "Captures" },
    { href: "/clips", label: "Clips" },
    { href: "/reels", label: "Reels" },
];

const TAG_PAGES = [
    { href: "/tags/performers", label: "Performers" },
    { href: "/tags/sources", label: "Sources" },
    { href: "/tags/keywords", label: "Keywords" },
    { href: "/tags/manage", label: "Manage" },
];

/**
 * A sidebar entry for a list page: it points where the page was last left, not at its plain
 * address (§14b, `rememberedPages.ts`). A component because the tag pages are a list, and a
 * hook cannot be called in a loop.
 */
const RememberedNavLink: React.FC<
    Omit<NavLinkProps, "href"> & { path: string; onClick: () => void }
> = ({ path, ...props }) => (
    <NavLink component={Link} prefetch={false} href={useRememberedHref(path)} {...props} />
);

export const AppNavbar: React.FC<{
    onNavigate: () => void;
}> = ({ onNavigate }) => {
    /**
     * Where we are, so the nav can say so.
     *
     * `NavLink` has had an `active` prop since Mantine 7 and nothing ever passed it, so the
     * sidebar never indicated which page you were on. Read from the URL rather than held in
     * state because the URL is already the source of truth for the view (§14) — a second copy
     * would be wrong every time someone used the back button.
     */
    const pathname = usePathname();
    const params = useSearchParams();
    const currentRoot = params.get("root");

    /**
     * Two destinations on one route.
     *
     * `/` is the room -- the front door, and what Home points at. Everything else on that
     * route is the library proper: `/?view=grid`, `/?view=gallery`, a search, or a named
     * root. `/` alone cannot tell them apart, so neither can a bare pathname check.
     */
    const inRoom = pathname === "/" && !currentRoot && !params.get("view");
    const inLibrary = pathname === "/" && !inRoom;
    const lastSearch = useLastLibrarySearch();
    // Views & playlists at its last search and tab, as every other list page in the sidebar is.
    const collectionsHref = useRememberedHref("/collections");
    const studioHref = useRememberedSectionHref("studio");

    // Every list page the sidebar returns you to is recorded here, as its address changes.
    useRememberPages();
    const currentFilter = params.get("filter");

    const { data: libraries } = useLibraries();

    const { data: savedFilters } = useSavedFilters();
    const { data: playlists } = usePlaylists();
    const tagNames = useRememberedTagNames();

    /**
     * The search the library was left at, in a few words (§14b, `searchSummary.ts`). Null when
     * there is none, and then there is no row: nothing to go back to is said by its absence.
     */
    const lastSearchSummary =
        lastSearch === null
            ? null
            : summarizeSearch(parseView(new URLSearchParams(lastSearch)), {
                  tag: (id) => tagNames[id],
                  root: (id) => libraries?.libraries.find((library) => library.id === id)?.label,
                  savedFilter: (id) =>
                      savedFilters?.filters.find((filter) => filter.id === id)?.name,
              });
    const onLastSearch =
        lastSearch !== null && pathname === "/" && params.toString() === lastSearch;

    /**
     * The pinned few, both kinds, in one list (§14c).
     *
     * Only pinned collections are listed. The sidebar is for the handful you reach for daily;
     * the rest live on `/collections`, which is why an unpinned one is saved rather than lost.
     * A nav that grew a row per collection would be a nav nobody could scan, and "pinned"
     * would mean nothing.
     *
     * One list rather than two, and no headings above them. There were two — a "Saved" heading
     * over the views and the Playlists entry doubling as a heading over the playlists — which
     * read as two unrelated features in a sidebar that had a Collections entry between them
     * saying they were one. A view and a playlist go in the same list for the same reason they
     * share a page: they are one idea, and which mechanics a given one uses is a fact about the
     * row, not a reason to sit in a different part of the sidebar.
     *
     * `pinned` is resolved per viewer by the server, so nothing here needs to know whose
     * collection it is: your own pin, a pin you made on something shared with you, and the
     * household default an administrator set all arrive as the same `true`.
     */
    const pinnedCollections = [
        ...(savedFilters?.filters ?? [])
            .filter((filter) => filter.pinned)
            .map((filter) => ({
                id: filter.id,
                kind: "filter" as CollectionKind,
                name: filter.name,
                href: savedFilterHref(filter),
                active: currentFilter === filter.id,
                // A view whose stored query can no longer be parsed is shown as broken rather
                // than hidden: disappearing looks like data loss, and this can at least be
                // opened and deleted deliberately.
                note:
                    filter.query === null ? (
                        <Text size="xs" c="dimmed" title="This view can no longer be read">
                            !
                        </Text>
                    ) : null,
            })),
        ...(playlists?.playlists ?? [])
            .filter((playlist) => playlist.pinned)
            .map((playlist) => ({
                id: playlist.id,
                kind: "playlist" as CollectionKind,
                name: playlist.name,
                href: `/playlists/${playlist.id}`,
                active: pathname === `/playlists/${playlist.id}`,
                note: (
                    <Text size="xs" c="dimmed">
                        {playlist.itemCount.toLocaleString()}
                    </Text>
                ),
            })),
    ].sort((left, right) => left.name.localeCompare(right.name));

    // Null-safe like the total beside the entry: nothing is offered until both lists are in.
    const unpinnedCount =
        playlists && savedFilters
            ? playlists.playlists.length + savedFilters.filters.length - pinnedCollections.length
            : 0;
    /*
     * Alphabetically, because that is the only order a reader can predict across two sequences.
     *
     * Each kind carries its own `position`, both counting from zero and neither with a UI to
     * set them (§14c) — so merging on position would interleave two arbitrary sequences and
     * call it an order. When reordering arrives it will have to give a pinned collection one
     * position among all of them, and this is the line that changes.
     */

    return (
        <>
            {/* `prefetch={false}` on every link below, which is not a default worth keeping.

                App Router prefetches a `<Link>` as soon as it is in the viewport, and the
                whole of this navbar is in the viewport at once. A cold load therefore asked
                the NAS to render Collections, Reels, Clips, Tags, Duplicates, Trash and Admin
                as RSC payloads before anyone had clicked anything -- seven page renders whose
                only purpose was to be thrown away, on the box §17 calls CPU-bound. Over
                HTTP/1.1 they also sat in the same six-connection queue as the covers and the
                page's own JS chunks, so the cost was paid twice.

                `false` switches off the viewport prefetch and keeps the hover one, which is
                the half that was earning anything: it starts on intent rather than on
                presence, and there is only ever one of it. */}
            {/* Home is the room; Library is the rack.

                They were one entry pointing at `/`, which meant the only way to reach the
                grid from the navigation was to go to the front door first and then find a
                "see all". Browsing is the more frequent errand, so it gets the tab, and the
                room gets its own -- as well as the wordmark, which links there too. */}
            <NavLink
                component={Link}
                prefetch={false}
                href="/"
                label="Home"
                active={inRoom}
                color="brass"
                style={navPadding}
                onClick={onNavigate}
            />

            {/* The library as it opens, and below it the search you left (§14b).

                This entry used to go straight back to the remembered search, which kept the
                filter you had built across a trip to Tags -- and made every visit pay for that
                filter and sort before a new search could be asked for. So the two ways in are
                two rows: this one clean, the next one back where you were. */}
            <NavLink
                component={Link}
                prefetch={false}
                href={`/?${FIRST_LIBRARY_QUERY}`}
                label="Library"
                active={inLibrary && !onLastSearch}
                color="brass"
                style={navPadding}
                onClick={onNavigate}
                // From the libraries list rather than the shell's polled stats: the count is the
                // expensive number, and this is the query that is cached for it and refreshed by
                // the change feed (§20).
                rightSection={
                    libraries ? (
                        // Rolls when a scan lands while the sidebar is open (§14, "Motion").
                        <Text size="xs" c="dimmed">
                            <Odometer value={libraries.total} />
                        </Text>
                    ) : null
                }
            />

            {/* Only when there is a search to go back to. Its line is the search in a few
                words -- "Alice +2" -- cut with an ellipsis if even that is too long, and the
                whole of it on hover. */}
            {lastSearch !== null && lastSearchSummary !== null && (
                /* The × beside the row forgets it. A sibling laid over the row's right edge
                   rather than its `rightSection`: the row is a link, and a button inside an
                   anchor is invalid markup that some browsers follow anyway. */
                <Box className={classes.lastSearch}>
                    <NavLink
                        component={Link}
                        prefetch={false}
                        href={`/?${lastSearch}`}
                        label="Last search"
                        description={lastSearchSummary}
                        title={lastSearchSummary}
                        active={onLastSearch}
                        color="brass"
                        classNames={{ description: classes.oneLine }}
                        style={{
                            ...navPadding,
                            paddingInlineStart: "calc(var(--app-shell-padding) - 6px + 16px)",
                            paddingInlineEnd: 44,
                        }}
                        onClick={onNavigate}
                    />
                    <CloseButton
                        className={classes.lastSearchClose}
                        size={44}
                        iconSize={14}
                        aria-label="Forget the last search"
                        title="Forget the last search"
                        onClick={forgetLastLibrarySearch}
                    />
                </Box>
            )}

            {/* The libraries, kept apart rather than merged into one list (§14). Listed only
                when there is more than one: a single root named twice — once as "Library" and
                once as itself — is a menu that looks like it has a duplicate in it. */}
            {(libraries?.libraries.length ?? 0) > 1 &&
                libraries?.libraries.map((library) => (
                    <NavLink
                        key={library.id}
                        component={Link}
                        prefetch={false}
                        href={`/?root=${encodeURIComponent(library.id)}`}
                        label={library.label}
                        active={currentRoot === library.id}
                        color="brass"
                        style={{
                            ...navPadding,
                            paddingInlineStart: "calc(var(--app-shell-padding) - 6px + 16px)",
                        }}
                        onClick={onNavigate}
                        rightSection={
                            <Text size="xs" c="dimmed">
                                {library.items.toLocaleString()}
                            </Text>
                        }
                    />
                ))}

            {/* Collections, below the libraries and above the admin pages (§14c).

                A library is where files are; a collection is how you look at them. Both are
                ways into the same grid, so they belong in the same list -- and the collection
                has to sit second, because the library is the thing that exists whether or not
                anybody has had an opinion about it.

                One entry for both kinds, because they are one kind of thing with two sets of
                mechanics. It is always present, unlike the pinned rows under it: it is where an
                unpinned collection is found again, and where a first one gets made.

                Labelled by what is in it rather than by our word for it. "Collections" is the
                code's name for the pair, and nobody looking for a saved view guessed that it
                lived behind it (§14c). */}
            <NavLink
                component={Link}
                prefetch={false}
                href={collectionsHref}
                label="Views & playlists"
                active={pathname === "/collections" || pathname.startsWith("/playlists")}
                color="brass"
                style={navPadding}
                onClick={onNavigate}
                rightSection={
                    // Everything the page would show, shared ones included -- a count beside a
                    // link has to be the count of what opening it gives you.
                    //
                    // Null while either list is in flight rather than zero: a number that
                    // appears as 0 and then corrects itself reads as something having just been
                    // found, which is the one thing it must never say about a collection.
                    playlists && savedFilters ? (
                        <Text size="xs" c="dimmed">
                            {(
                                playlists.playlists.length + savedFilters.filters.length
                            ).toLocaleString()}
                        </Text>
                    ) : null
                }
            />

            {/* Each view links to its query expanded into an ordinary library address, plus
                `filter=<id>` to say where it came from. That means no new page, no new request
                and no second code path: the grid renders it exactly as it renders a hand-built
                filter, and the address stays shareable. A playlist has a page of its own,
                because a hand-ordered list is not expressible as a query. */}
            {pinnedCollections.map((collection) => (
                <NavLink
                    key={`${collection.kind}:${collection.id}`}
                    component={Link}
                    prefetch={false}
                    href={collection.href}
                    label={collection.name}
                    active={collection.active}
                    color="brass"
                    style={{
                        ...navPadding,
                        paddingInlineStart: "calc(var(--app-shell-padding) - 6px + 16px)",
                    }}
                    onClick={onNavigate}
                    leftSection={
                        /* Which mechanics this one uses, since the list holds both and the
                           names alone would not say. A mark on the row rather than a heading
                           over a group: it is a property of the collection, and it keeps the
                           list in one predictable order instead of two.

                           Fixed width so the names line up, and titled rather than left to be
                           guessed -- the glyphs are a reminder for somebody who already knows,
                           not the place anybody learns the difference. */
                        <Text
                            span
                            c="dimmed"
                            display="inline-flex"
                            title={collection.kind === "filter" ? "Saved view" : "Playlist"}
                        >
                            {collection.kind === "filter" ? (
                                <ViewGlyph size={14} />
                            ) : (
                                <ListGlyph size={14} />
                            )}
                        </Text>
                    }
                    rightSection={collection.note}
                />
            ))}

            {/* The rest, as a count rather than as rows (§14c).

                The pinned rows alone gave no sign there was anything else, so a collection
                taken out of the sidebar looked gone. One row however many there are: listing
                them here is the unscannable nav that pinning exists to prevent. Absent when
                everything is already pinned, since then there is nothing more to find. */}
            {unpinnedCount > 0 && (
                <NavLink
                    component={Link}
                    prefetch={false}
                    href={collectionsHref}
                    label={`${unpinnedCount.toLocaleString()} more…`}
                    c="dimmed"
                    style={{
                        ...navPadding,
                        paddingInlineStart: "calc(var(--app-shell-padding) - 6px + 16px)",
                    }}
                    onClick={onNavigate}
                />
            )}

            {/* Studio: what you made from the library -- stills, spans and reels of spans --
                below Collections and outside it (§14d).

                Not entries on the Collections page, and not pinned rows under this one. A
                collection is a *way back into the library* — a query or a list of items — and
                there are few enough of them to pin; a capture, a clip or a reel is your own
                *work*, and there will be hundreds. Hundreds is why each page is an index with its
                own sort, search and paging rather than a list that unrolls in a sidebar.

                One section rather than three peers of Library and Tags, because they are one
                errand. Laid out the way Tags is: the pages always listed, indented, and the
                section's own entry returning to the one last used, as Review does. */}
            <NavLink
                component={Link}
                prefetch={false}
                href={studioHref}
                label="Studio"
                color="brass"
                style={navPadding}
                onClick={onNavigate}
            />
            {STUDIO_PAGES.map((page) => (
                <RememberedNavLink
                    key={page.href}
                    path={page.href}
                    label={page.label}
                    // A reel's own page is still Reels.
                    active={pathname === page.href || pathname.startsWith(`${page.href}/`)}
                    color="brass"
                    style={{
                        ...navPadding,
                        paddingInlineStart: "calc(var(--app-shell-padding) - 6px + 16px)",
                    }}
                    onClick={onNavigate}
                />
            ))}

            {/* Deliberately outside the admin block below: everybody has private tags, and a
                screen where a regular account manages its own vocabulary in full does not
                belong behind a scope. The public half is read-only without it (§6). */}
            {/* The section's own entry opens its first page, as `/tags` redirects to -- but
                where that page was left, like the entry beneath it. */}
            <RememberedNavLink
                path="/tags/performers"
                label="Tags"
                // Lit on a tag's own page, which belongs to the section but to none of its
                // entries -- a performer's page is not the Performers list.
                active={
                    pathname.startsWith("/tags/") &&
                    !TAG_PAGES.some((page) => pathname === page.href)
                }
                color="brass"
                style={navPadding}
                onClick={onNavigate}
            />
            {/* The section's pages, indented under it the way the libraries sit under Library:
                three ways to look at the vocabulary and one to tidy it (§6 "Tags"). Always
                listed: they used to unfold only inside the section, but the vocabulary is
                reached for often enough that the extra click cost more than the four rows. */}
            {TAG_PAGES.map((page) => (
                <RememberedNavLink
                    key={page.href}
                    path={page.href}
                    label={page.label}
                    active={pathname === page.href}
                    color="brass"
                    style={{
                        ...navPadding,
                        paddingInlineStart: "calc(var(--app-shell-padding) - 6px + 16px)",
                    }}
                    onClick={onNavigate}
                />
            ))}
        </>
    );
};

/**
 * Upkeep: the administrator's pages, at the foot of the sidebar above the account.
 *
 * Visited when something needs doing, not every session, so smaller and quieter, below a rule,
 * where nobody looking for Reels reads past them -- and four entries, one per question an
 * administrator arrives with (§12c):
 *
 * - **Review** — what needs a decision: duplicates, OCR, unreadable files, the trash. One entry
 *   over four queues, returning to the one last used; the queues switch at the top of the page.
 * - **Libraries** — what is catalogued, and how new files are found.
 * - **Processing** — what is done to the files and whether it is healthy. Says "paused" when it
 *   is, because a paused library looks exactly like a broken one from anywhere else.
 * - **Household** — who gets in.
 *
 * There were five, and they were not one kind of thing: four review queues named one by one and
 * an "Admin" page holding everything else in eleven cards. Absent for everybody without the
 * scope, as they always were.
 */
export const AppNavbarUpkeep: React.FC<{ onNavigate: () => void }> = ({ onNavigate }) => {
    const { hasScope } = useAuth();
    const pathname = usePathname();
    const reviewHref = useRememberedSectionHref("review");
    const isAdmin = hasScope("admin");
    const { data: pause } = useProcessingPause(isAdmin);

    if (!isAdmin) return null;

    const upkeepProps = {
        color: "brass",
        style: navPadding,
        onClick: onNavigate,
        classNames: { root: classes.upkeep, label: classes.upkeepLabel },
    };

    return (
        <Box className={classes.upkeepGroup}>
            <NavLink
                component={Link}
                prefetch={false}
                href={reviewHref}
                label="Review"
                active={pathname.startsWith("/review")}
                {...upkeepProps}
            />
            <NavLink
                component={Link}
                prefetch={false}
                href="/admin/libraries"
                label="Libraries"
                active={pathname === "/admin/libraries"}
                {...upkeepProps}
            />
            <NavLink
                component={Link}
                prefetch={false}
                href="/admin/processing"
                label="Processing"
                active={pathname === "/admin/processing"}
                rightSection={
                    pause?.paused ? (
                        <Text size="xs" c="oxblood.4">
                            paused
                        </Text>
                    ) : null
                }
                {...upkeepProps}
            />
            <NavLink
                component={Link}
                prefetch={false}
                href="/admin/household"
                label="Household"
                active={pathname === "/admin/household"}
                {...upkeepProps}
            />
        </Box>
    );
};
