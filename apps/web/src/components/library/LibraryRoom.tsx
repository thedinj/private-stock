"use client";

import Link from "next/link";
import { Anchor, Box, Button, Center, Group, Loader, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import type {
    HomeResponse,
    LibrarySummary,
    MediaListItem,
    ResolvedShelf,
    SavedFilter,
    Shelf,
} from "@private-stock/core";

import { LoadFailed } from "@/components/LoadFailed";
import { MediaTile } from "@/components/MediaTile";
import { PlaylistCard } from "@/components/playlist/PlaylistCard";
import { GRID_GAP, GRID_TRACKS } from "@/lib/gridGeometry";
import { api } from "@/lib/api/client";
import { rememberReturn, rememberShelf } from "@/lib/returnTo";
import { usePlaylists } from "@/lib/api/playlists";
import { useSavedFilters } from "@/lib/api/savedFilters";
import { savedFilterHref } from "@/lib/libraryQuery";
import { useLiveUpdates } from "@/lib/events/useLiveUpdates";
import { useLibraries } from "@/lib/api/libraries";
import { queryKeys } from "@/lib/api/queryKeys";

import classes from "./LibraryRoom.module.scss";

/**
 * The room (§14).
 *
 * The app had built the cellar and never this. Every screen was inventory — a rack of tiles,
 * paged, filtered, sorted — which is exactly right for finding one thing among two hundred
 * thousand and exactly wrong as the front door. This is the other half: you arrive, one thing
 * is offered, and the libraries are named doors rather than rows in a table.
 *
 * Built on `/api/home`, which has been shipping since §6 with no page consuming it. The
 * shelves, their limits and the per-account layout already exist; all that was missing was
 * somewhere to show them.
 */

const formatDuration = (ms: number | null): string | null => {
    if (!ms || ms <= 0) return null;

    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${minutes}:${String(seconds).padStart(2, "0")}`;
};

/**
 * Where a shelf's "see all" goes.
 *
 * The shelf carries its own descriptor back from the server precisely so the client can
 * answer this without the server having to know any URLs (§6). Null where a shelf has no
 * honest equivalent as a filter — "recently viewed" is a walk of one viewer's views, and the
 * grid's "last viewed" sort carries on into everything never viewed, and a link that quietly showed something else would be
 * worse than no link.
 */
const shelfHref = (shelf: Shelf, filters: SavedFilter[]): string | null => {
    if (shelf.source === "tag") return `/?tags=${encodeURIComponent(shelf.tagId)}&view=grid`;

    /**
     * A saved filter's row leads to the filter, by the one definition of its address.
     *
     * Resolved against the list rather than built from the shelf, because the shelf carries
     * only the id and the grid reads expanded parameters — linking to `?filter=<id>` alone
     * would land on the unfiltered library wearing the filter's name, which is the worst of
     * both. Not finding it means the list has not arrived yet, and a row with no link for a
     * moment is better than a link to the wrong page.
     */
    if (shelf.source === "filter") {
        const filter = filters.find((candidate) => candidate.id === shelf.filterId);

        return filter ? savedFilterHref(filter) : null;
    }

    if (shelf.source !== "builtin") return null;

    switch (shelf.builtin) {
        case "recentlyAdded":
            return "/?view=grid";
        case "favorites":
            return "/?favorite=1&view=grid";
        case "topRated":
            return "/?sort=rating&view=grid";
        case "random":
            return "/?sort=random&view=grid";
        case "recentlyViewed":
            return null;
    }
};

export const SectionHead: React.FC<{ title: string; href?: string | null; more?: string }> = ({
    title,
    href,
    more,
}) => (
    <Box mb="sm">
        <Group justify="space-between" align="baseline" wrap="nowrap" gap="md">
            {/* One line, clipped. A shelf can be named after a tag, and a tag is whatever
                somebody typed -- an unclamped heading pushes "See all" off the row. */}
            <Title order={4} lineClamp={1} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                {title}
            </Title>
            {href && (
                <Anchor
                    component={Link}
                    href={href}
                    size="sm"
                    c="brass.4"
                    underline="never"
                    style={{ flexShrink: 0 }}
                >
                    {more ?? "See all"} →
                </Anchor>
            )}
        </Group>
        <Box className={classes.rule} mt={10} />
    </Box>
);

/**
 * A shelf's tiles. Each opens its item with the shelf as the set, so the viewer carries on to
 * the next tile on the shelf when one finishes, and stops after the last (§14b).
 */
export const TileGrid: React.FC<{ items: MediaListItem[] }> = ({ items }) => (
    <Box
        style={{
            display: "grid",
            gridTemplateColumns: GRID_TRACKS,
            gap: GRID_GAP,
        }}
    >
        {items.map((item) => (
            <MediaTile key={item.id} item={item} onOpen={() => rememberShelf(items)} />
        ))}
    </Box>
);

/**
 * The picture window.
 *
 * One thing, offered. Not a carousel: a rotating hero is a decision nobody asked to be given
 * repeatedly, and it makes the first thing you see depend on how long you took to look at it.
 */
const Hero: React.FC<{ item: MediaListItem; eyebrow: string; shelf: MediaListItem[] }> = ({
    item,
    eyebrow,
    shelf,
}) => {
    // Videos only: a photograph's probed length is one frame, and read as "0:00".
    const duration = item.kind === "video" ? formatDuration(item.durationMs) : null;

    const facts = [duration, item.height ? `${item.height}p` : null].filter(Boolean);

    return (
        <Box className={`${classes.bleed} ${classes.hero}`}>
            {item.coverUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.coverUrl} alt="" className={classes.heroImage} />
            ) : (
                <Box className={classes.heroFallback} />
            )}

            <Box className={classes.scrimSide} />
            <Box className={classes.scrimFoot} />

            <Box className={classes.heroCopy}>
                <Text className={classes.eyebrow}>{eyebrow}</Text>
                <h1 className={classes.heroTitle}>{item.title}</h1>
                {facts.length > 0 && <Text className={classes.heroLine}>{facts.join(" · ")}</Text>}
                <Group gap="sm" wrap="wrap">
                    <Button
                        component={Link}
                        href={`/media/${item.id}`}
                        color="brass"
                        size="md"
                        // The shelf it heads, so playing on from it walks the rest of the row.
                        onClick={() => rememberShelf(shelf)}
                    >
                        Play
                    </Button>
                </Group>
            </Box>
        </Box>
    );
};

const Invite: React.FC<{ library: LibrarySummary }> = ({ library }) => (
    <Link href={`/?root=${encodeURIComponent(library.id)}`} className={classes.invite}>
        {library.cover?.coverUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={library.cover.coverUrl} alt="" className={classes.inviteGhost} />
        )}
        <Box className={classes.inviteVeil} />
        <Box className={classes.inviteEdge} />
        <Box className={classes.inviteBody}>
            <Text className={classes.inviteName}>{library.label}</Text>
            <Text className={classes.inviteCount}>
                {library.items.toLocaleString()} item{library.items === 1 ? "" : "s"}
            </Text>
        </Box>
    </Link>
);

/**
 * An empty room, and nothing about the machine.
 *
 * This used to be `LibraryEmptyState`, which is a *diagnostic*: how many folders were found,
 * how many are enabled, whether a scan is running, and a button to go and turn roots on. All
 * of that is true and useful and none of it belongs on the front door — it is the state of
 * the installation, not of the collection, and the front door is where somebody arrives
 * hoping to be handed something.
 *
 * The diagnosis still exists, in the two places that can act on it: the library itself, which
 * is where you go when you expected to find things, and the admin screen, which is where they
 * get turned on. Here there is a sentence and a door.
 */
const RoomEmpty: React.FC = () => (
    <Center mih={320}>
        <Stack gap="xs" align="center" maw={440} ta="center">
            <Text className={classes.eyebrow}>Nothing yet</Text>
            <Title order={2}>The cellar is empty</Title>
            <Text size="sm" c="dimmed">
                Once something has been catalogued, what you were last watching will be waiting
                here.
            </Text>
            <Button
                component={Link}
                href="/?view=grid"
                variant="default"
                mt="sm"
                onClick={rememberReturn}
            >
                Open the library
            </Button>
        </Stack>
    </Center>
);

export const LibraryRoom: React.FC = () => {
    /**
     * The front door hears about the library changing (§13b).
     *
     * It did not, which made this the page where the problem was most visible: it is where
     * everyone lands, and "recently added" that does not show what was recently added reads
     * as the scanner being broken rather than as a stale cache.
     *
     * `autoApply` is true because there is nothing here to disturb. The restraint the grid
     * needs — never reorder rows under somebody's cursor — is about a paged list being read
     * position by position; a shelf is a short row of what is newest, and refreshing it is
     * the entire point of it.
     */
    useLiveUpdates({ autoApply: true });

    const {
        data: home,
        isLoading: homeLoading,
        isError: homeFailed,
        error: homeError,
        refetch: refetchHome,
    } = useQuery({
        queryKey: queryKeys.home(),
        queryFn: () => api<HomeResponse>("/api/home"),
    });

    const { data: libraries } = useLibraries();

    // Only so a filter shelf's "see all" can be addressed; the shelf's items come back with
    // the home response like every other row's.
    const { data: savedFilters } = useSavedFilters();

    /**
     * The household's own arrangements (§14b).
     *
     * A handful, not the list — the list is one click away and has a page of its own. Here
     * because a playlist is the most personal thing in the app and the room is where things
     * are offered: it belonged on the front door the moment a playlist had a face to show.
     */
    const { data: playlistData } = usePlaylists();

    const shelves: ResolvedShelf[] = (home?.shelves ?? []).filter(
        (shelf) => shelf.items.length > 0
    );

    /**
     * What to offer: the first thing on the first shelf that has anything.
     *
     * Not from "recently viewed" while another shelf has something. Nothing here is long enough
     * to be left part way through, so the item you viewed last is the one you have just finished,
     * and offering it back is the one suggestion that is nearly always wrong. Otherwise the
     * layout decides rather than a fixed builtin: the room is the user's, and a hero that insisted
     * on "recently added" would ignore a room they arranged themselves.
     */
    const filled = shelves.filter((shelf) => shelf.items.length > 0);
    const heroShelf =
        filled.find(
            (shelf) =>
                !(shelf.shelf.source === "builtin" && shelf.shelf.builtin === "recentlyViewed")
        ) ?? filled[0];
    const hero = heroShelf?.items[0];

    if (homeLoading && !home) {
        return (
            <Center h={320}>
                <Loader color="brass" />
            </Center>
        );
    }

    /**
     * A request that failed is not an empty library.
     *
     * It read as one: no response meant no shelves, no shelves meant no hero, and the page
     * announced that the cellar was empty. A dropped connection is the commonest cause of
     * that on a NAS at home, and "everything you own is gone" is the worst available way to
     * report it. Checked before the empty state, never after.
     */
    if (homeFailed) {
        return <LoadFailed error={homeError} what="the room" onRetry={() => void refetchHome()} />;
    }

    if (!hero) {
        return <RoomEmpty />;
    }

    return (
        <Box>
            <Hero
                item={hero}
                shelf={heroShelf?.items ?? [hero]}
                eyebrow={heroShelf?.title ?? "In the library"}
            />

            <Stack gap={40} mt={40}>
                {shelves.map((shelf) => (
                    <Box key={shelf.key}>
                        <SectionHead
                            title={shelf.title}
                            href={shelfHref(shelf.shelf, savedFilters?.filters ?? [])}
                        />
                        <TileGrid items={shelf.items} />
                    </Box>
                ))}

                {/* The household's own arrangements, before the libraries (§14b).

                    A playlist is the most personal thing in the app -- an order somebody
                    chose -- so it sits above the doors into everybody's shelves. Four at
                    most: this is a glimpse and a way in, and the page that lists them all is
                    one click along the same line. Absent entirely when there are none,
                    rather than an empty rack inviting you to fill it. */}
                {(playlistData?.playlists.length ?? 0) > 0 && (
                    <Box>
                        <SectionHead title="Your playlists" href="/collections" />
                        <Box
                            style={{
                                display: "grid",
                                gridTemplateColumns:
                                    "repeat(auto-fill, minmax(min(240px, 100%), 1fr))",
                                gap: GRID_GAP,
                            }}
                        >
                            {playlistData?.playlists.slice(0, 4).map((playlist) => (
                                <PlaylistCard key={playlist.id} playlist={playlist} />
                            ))}
                        </Box>
                    </Box>
                )}

                {/* Two or more, or not at all. A section headed "Your libraries" holding one
                    card is a door beside the door you came through: everything on this page
                    is already that library, and the only thing the row adds is a second way
                    to say so — and the grid is one nav item away either way. The same rule
                    the sidebar already applies to its own list of libraries. */}
                {(libraries?.libraries.length ?? 0) > 1 && (
                    <Box>
                        <SectionHead
                            title="Your libraries"
                            href="/?view=grid"
                            more={`Browse all ${(libraries?.total ?? 0).toLocaleString()}`}
                        />
                        <Box
                            style={{
                                display: "grid",
                                // One per row on a phone, where a library's name is the whole
                                // point and a 188px card cannot hold one.
                                // `auto-fit`, not `auto-fill`: empty tracks collapse, so
                                // one library fills the row instead of being a small card
                                // marooned in a four-column grid.
                                gridTemplateColumns:
                                    "repeat(auto-fit, minmax(min(260px, 100%), 1fr))",
                                gap: GRID_GAP,
                            }}
                        >
                            {libraries?.libraries.map((library) => (
                                <Invite key={library.id} library={library} />
                            ))}
                        </Box>
                    </Box>
                )}
            </Stack>
        </Box>
    );
};
