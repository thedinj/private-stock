"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    Box,
    Button,
    Center,
    Group,
    Menu,
    Modal,
    Pagination,
    SegmentedControl,
    Stack,
    Text,
    TextInput,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useQueryClient } from "@tanstack/react-query";

import { LoadFailed } from "@/components/LoadFailed";
import { MediaTile } from "@/components/MediaTile";
import { PlayMenu } from "@/components/PlayMenu";
import { LayoutSwitch } from "@/components/library/LayoutSwitch";
import { EmptyState } from "@/components/shell/EmptyState";
import { PageLoader } from "@/components/shell/PageLoader";
import { PagePlate } from "@/components/shell/PagePlate";
import { PlaylistReorder } from "@/components/playlist/PlaylistReorder";
import {
    useDeletePlaylist,
    useMovePlaylistItem,
    usePlaylist,
    usePlaylistItems,
    useRemovePlaylistItem,
    useUpdatePlaylist,
} from "@/lib/api/playlists";
import { useAuth } from "@/lib/api/AuthProvider";
import { useLiveUpdates } from "@/lib/events/useLiveUpdates";
import { GALLERY_TRACKS, GRID_GAP, GRID_TRACKS, PRIORITY_TILES } from "@/lib/gridGeometry";
import {
    newSeed,
    parsePlaylistView,
    playlistHref,
    resolvePlaylistView,
    type PlaylistView,
} from "@/lib/playlistView";
import { usePlaylistLayout } from "@/lib/playlistLayout";
import { MoreGlyph } from "@/components/media/Glyph";
import { useRememberedHref } from "@/lib/rememberedPages";
import { useOpenItem } from "@/lib/openItem";
import { rememberReturnTo } from "@/lib/returnTo";
import { settling } from "@/lib/settling";
import { fetchShowcasePage } from "@/lib/showcase/pages";
import { playlistSetParams } from "@/lib/showcase/set";

/**
 * One playlist, in one of its two orders (§14b).
 *
 * The order is in the address and nowhere else, which is what keeps this page, the up-next
 * strip and previous/next in the viewer from disagreeing about what they are showing. Nothing
 * here writes an order: shuffling sets a seed, and the seed is a permutation of the stored
 * positions rather than a rearrangement of them.
 *
 * The one control that *does* write the order is reorder mode, and it is unavailable while
 * shuffled. Moving an item in a shuffled view would have to infer a stored position from a
 * shuffled one, and any inference is a surprise — so the toggle is the way back to arranging,
 * rather than the arranging being quietly wrong.
 */

export const PlaylistDetail: React.FC<{ playlistId: string }> = ({ playlistId }) => {
    const router = useRouter();
    const openItem = useOpenItem();
    const searchParams = useSearchParams();
    const wide = useMediaQuery("(min-width: 62em)");

    /**
     * A playlist is a view of the library too (§13b).
     *
     * Its membership is fixed, so nothing arrives or leaves under the viewer — but covers
     * become ready, titles get parsed, and an item whose file was trashed stops being
     * visible. Without this the page shows whatever was true when it was opened.
     */
    useLiveUpdates({ autoApply: true });

    const params = new URLSearchParams(searchParams.toString());
    const [layout, rememberLayout] = usePlaylistLayout();
    /**
     * The address's layout when it names one, and this device's habit when it does not (§14b),
     * so a playlist opened from the sidebar comes up the way playlists were last browsed.
     */
    const urlView = {
        ...parsePlaylistView(params),
        ...(params.has("view") ? {} : { mode: layout }),
    };

    /**
     * The seed a list that prefers shuffle opens with.
     *
     * Rolled once and held, not per render: it becomes the address a moment later, and a
     * value that changed underneath would reshuffle the list on every render until it settled.
     */
    const [defaultSeed] = useState(newSeed);
    const { hasScope } = useAuth();
    /**
     * Sharing is curation, and curation is an administrator's (§14b). The control is absent
     * for everybody else rather than disabled — "why is this greyed" is answered by a
     * paragraph about what "shared" has to be able to mean.
     */
    const canShare = hasScope("admin");

    const {
        data: playlist,
        isLoading: loadingPlaylist,
        isError,
        error,
        refetch,
    } = usePlaylist(playlistId);
    const view = resolvePlaylistView(urlView, playlist?.sortMode ?? null, defaultSeed);

    const apply = (next: PlaylistView) =>
        router.replace(playlistHref(playlistId, next), { scroll: false });

    /**
     * Write the resolved order into the address.
     *
     * So that everything downstream has a decided address to read — the up-next strip and
     * previous/next parse `returnTo`, and an undecided address would leave them guessing at
     * an order this page had already chosen. `replace`, not `push`: applying a default is not
     * a navigation somebody should have to press Back through.
     */
    useEffect(() => {
        if (!urlView.decided && playlist) {
            apply(view);
        }
        // Runs on the one transition from undecided to decided; `apply` closes over the
        // current address, and re-running as that changes would fight the toggle.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [urlView.decided, playlist]);

    const shuffled = view.seed !== null;

    const itemsQuery = usePlaylistItems(playlistId, view.page, view.seed, view.decided);

    const [reordering, setReordering] = useState(false);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    const queryClient = useQueryClient();

    /**
     * Play from the top: the first item of the list in this order, whichever page is on screen.
     *
     * As the library does it -- page one under the page's own key, so it is a cache hit when page
     * one is showing, and the address recorded for the viewer is page one, because that is where
     * the item is. Back still lands on the page you left: the viewer corrects the address to
     * wherever playback got to (§14b).
     */
    const playFromTop = async () => {
        const first = await fetchShowcasePage(
            queryClient,
            { kind: "playlist", playlistId, seed: view.seed },
            0
        );
        const target = first.items[0];

        if (!target) return;

        rememberReturnTo(playlistHref(playlistId, { ...view, page: 0 }));
        // Warmed before it goes, like any item opened from a tile (§14, "Waiting").
        openItem({
            id: target.id,
            href: `/media/${encodeURIComponent(target.id)}`,
            marker: null,
            picture: target.coverUrl,
        });
    };

    const update = useUpdatePlaylist();
    const remove = useDeletePlaylist(() => router.push("/collections"));
    const removeItem = useRemovePlaylistItem();
    const move = useMovePlaylistItem();

    const editable = playlist?.editable ?? false;
    const busy = move.isPending || removeItem.isPending;

    /**
     * Arranging and shuffling cannot both be on.
     *
     * Switching to shuffle while reordering would leave a list of drag handles over an order
     * that nothing can write, so the mode is dropped rather than disabled in place.
     */
    useEffect(() => {
        if (shuffled) setReordering(false);
    }, [shuffled]);

    const items = itemsQuery.data?.items ?? [];
    const pageSize = itemsQuery.data?.pageSize ?? 60;
    const total = itemsQuery.data?.total ?? playlist?.itemCount ?? 0;

    /**
     * A shuffled playlist keeps its total but loses its page list.
     *
     * The total is a cheap indexed count and is the thing worth knowing — unlike the library,
     * which declines to count because there the count is a scan (§20). How many *pages* the
     * permutation yields is a different question: it runs to the prime above the last
     * position, not to the number of items, so a numbered pager would offer a page that may
     * hold nothing.
     */
    const pageCount = shuffled ? null : Math.max(1, Math.ceil(total / pageSize));

    const goToPage = (page: number) => {
        apply({ ...view, page: Math.max(0, page - 1) });
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    /**
     * Back to the index this playlist is listed on, which is Collections and only Collections
     * (§14c). It said "All playlists" and pointed at `/playlists`, a second index that listed
     * half of what Collections lists -- so arriving from Collections and pressing Back landed you
     * somewhere you had not been, showing less than the page you left. At its remembered address,
     * so the search and tab you came from are still there.
     */
    const back = { href: useRememberedHref("/collections"), label: "Views & playlists" };

    // The plate stays up while the list is on its way or has failed, so the page does not
    // blink its heading in once the data lands (§14, "house rules").
    if (isError) {
        return (
            <Stack gap="lg">
                <PagePlate eyebrow="Playlist" title="This playlist" back={back} />
                <LoadFailed error={error} what="this playlist" onRetry={() => void refetch()} />
            </Stack>
        );
    }

    if (loadingPlaylist || !playlist) {
        return (
            <Stack gap="lg">
                <PagePlate eyebrow="Playlist" title="…" back={back} />
                <PageLoader />
            </Stack>
        );
    }

    const summary = (): string => {
        const count = `${total.toLocaleString()} item${total === 1 ? "" : "s"}`;

        if (!editable) return `${count} · shared by ${playlist.ownerName}`;

        return shuffled ? `${count} · shuffled` : count;
    };

    return (
        <Stack gap="md">
            {/*
             * The plate every page wears (§14, "house rules"): its state as
             * the eyebrow, the list's name, and the one primary action -- Play, which opens the
             * first item in the viewer, where previous and next walk this list in this order, or
             * shows the list as a Showcase or a Tasting in the same order.
             */}
            <PagePlate
                eyebrow={summary()}
                title={playlist.name}
                back={back}
                actions={
                    <Group gap="xs" wrap="nowrap">
                        {/* The list in the order on screen: a shuffle is shown, tasted and
                            played in that shuffle. */}
                        <PlayMenu
                            setParams={playlistSetParams(playlistId, view.seed)}
                            onFromTop={() => void playFromTop().catch(() => undefined)}
                            empty={total === 0}
                        />

                        {editable && (
                            <Menu position="bottom-end" withinPortal>
                                <Menu.Target>
                                    <Button
                                        variant="subtle"
                                        color="gray"
                                        aria-label="Playlist actions"
                                    >
                                        <MoreGlyph size={18} />
                                    </Button>
                                </Menu.Target>

                                <Menu.Dropdown>
                                    <Menu.Item onClick={() => setRenaming(playlist.name)}>
                                        Rename
                                    </Menu.Item>

                                    <Menu.Item
                                        onClick={() =>
                                            update.mutate({
                                                id: playlistId,
                                                patch: { pinned: !playlist.pinned },
                                            })
                                        }
                                    >
                                        {playlist.pinned ? "Unpin from sidebar" : "Pin to sidebar"}
                                    </Menu.Item>

                                    {/* Sharing is curation, so the control is an administrator's
                                        (§14b) — and absent rather than disabled for everyone else,
                                        because "why is this greyed" is answered by a paragraph
                                        about what "shared" has to be able to mean. Withdrawing is
                                        never gated: whoever owns it can always make it private
                                        again, or a demoted administrator would leave something
                                        shared that nobody could take back. */}
                                    {canShare && (
                                        <Menu.Item
                                            onClick={() =>
                                                update.mutate({
                                                    id: playlistId,
                                                    patch: {
                                                        visibility:
                                                            playlist.visibility === "shared"
                                                                ? "private"
                                                                : "shared",
                                                    },
                                                })
                                            }
                                        >
                                            {playlist.visibility === "shared"
                                                ? "Make private"
                                                : "Share with everyone"}
                                        </Menu.Item>
                                    )}

                                    <Menu.Divider />

                                    {/* The stored default, which is a different statement from
                                        the toggle below: that one is about this visit, this one
                                        is about how the list opens from now on. */}
                                    <Menu.Label>Opens in</Menu.Label>
                                    <Menu.Item
                                        disabled={playlist.sortMode !== "shuffle"}
                                        onClick={() =>
                                            update.mutate({
                                                id: playlistId,
                                                patch: { sortMode: null },
                                            })
                                        }
                                    >
                                        The order I arranged
                                    </Menu.Item>
                                    <Menu.Item
                                        disabled={playlist.sortMode === "shuffle"}
                                        onClick={() =>
                                            update.mutate({
                                                id: playlistId,
                                                patch: { sortMode: "shuffle" },
                                            })
                                        }
                                    >
                                        A fresh shuffle
                                    </Menu.Item>

                                    <Menu.Divider />

                                    <Menu.Item
                                        color="oxblood"
                                        onClick={() => setConfirmingDelete(true)}
                                    >
                                        Delete playlist
                                    </Menu.Item>
                                </Menu.Dropdown>
                            </Menu>
                        )}
                    </Group>
                }
            />

            {/* The working row: which order, and how it is laid out -- as the library's. */}
            <Group justify="space-between" gap="sm" wrap="wrap">
                <Group gap="sm" wrap="wrap">
                    {/* The order, as two named states rather than a switch labelled
                        "Shuffle". A switch says what it does when you press it; these say
                        which order you are looking at, which is the thing that has to be
                        unambiguous when the grid and the viewer must agree. */}
                    <SegmentedControl
                        value={shuffled ? "shuffle" : "stored"}
                        onChange={(value) =>
                            apply({
                                ...view,
                                seed: value === "shuffle" ? newSeed() : null,
                                decided: true,
                                page: 0,
                            })
                        }
                        data={[
                            { value: "stored", label: "In order" },
                            { value: "shuffle", label: "Shuffle" },
                        ]}
                    />

                    {shuffled && (
                        // A new seed is a new permutation, so this is a genuine reshuffle
                        // rather than a refetch of the order already on screen.
                        <Button
                            variant="default"
                            onClick={() => apply({ ...view, seed: newSeed(), page: 0 })}
                        >
                            Reshuffle
                        </Button>
                    )}

                    {/* Arranging, as a button on the row rather than a line in a menu -- the
                        same control the reel page uses for the same job. Absent while shuffled:
                        a disabled control invites "why can I not use this", and the answer is on
                        the toggle beside it. */}
                    {editable && !shuffled && (
                        <Button
                            variant={reordering ? "light" : "default"}
                            color={reordering ? "brass" : undefined}
                            onClick={() => setReordering((on) => !on)}
                        >
                            {reordering ? "Done arranging" : "Arrange"}
                        </Button>
                    )}
                </Group>

                <LayoutSwitch
                    value={view.mode}
                    onChange={(mode) => {
                        rememberLayout(mode);
                        apply({ ...view, mode });
                    }}
                    touch={!wide}
                />
            </Group>

            {itemsQuery.isLoading || !view.decided ? (
                <PageLoader />
            ) : itemsQuery.isError ? (
                <LoadFailed
                    error={itemsQuery.error}
                    what="this page of the playlist"
                    onRetry={() => void itemsQuery.refetch()}
                />
            ) : items.length === 0 ? (
                <EmptyState
                    title={
                        total === 0 ? "Nothing in this playlist yet" : "Nothing here you can see"
                    }
                >
                    {total === 0
                        ? "Open an item and choose + Playlist beside its title."
                        : "What is on this page is in a library this account cannot open."}
                </EmptyState>
            ) : reordering ? (
                // The same page of the playlist, so it settles the same way when the page
                // turns mid-arrangement; `busy` is about a move being saved, not this.
                <Box {...settling(itemsQuery.isPlaceholderData)}>
                    <PlaylistReorder
                        items={items}
                        offset={view.page * pageSize}
                        busy={busy}
                        onMove={(mediaId, toIndex) =>
                            move.mutate({ id: playlistId, mediaId, toIndex: Math.max(0, toIndex) })
                        }
                        onRemove={(mediaId) => removeItem.mutate({ id: playlistId, mediaId })}
                    />
                </Box>
            ) : (
                <Box
                    {...settling(itemsQuery.isPlaceholderData)}
                    style={{
                        display: "grid",
                        gridTemplateColumns: view.mode === "gallery" ? GALLERY_TRACKS : GRID_TRACKS,
                        gap: GRID_GAP,
                    }}
                >
                    {items.map((item, index) => (
                        <MediaTile
                            key={item.id}
                            item={item}
                            gallery={view.mode === "gallery"}
                            priority={index < PRIORITY_TILES}
                        />
                    ))}
                </Box>
            )}

            {(pageCount === null ? (itemsQuery.data?.hasMore ?? false) : pageCount > 1) && (
                <Center py="lg">
                    {pageCount === null ? (
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
                                disabled={!itemsQuery.data?.hasMore}
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

            <Modal
                opened={renaming !== null}
                onClose={() => setRenaming(null)}
                title="Rename playlist"
                centered
            >
                <Stack gap="md">
                    <TextInput
                        label="Name"
                        data-autofocus
                        value={renaming ?? ""}
                        onChange={(event) => {
                            const name = event.currentTarget.value;

                            setRenaming(name);
                        }}
                    />
                    <Group justify="flex-end" gap="sm">
                        <Button variant="default" onClick={() => setRenaming(null)}>
                            Cancel
                        </Button>
                        <Button
                            color="brass"
                            disabled={!renaming?.trim()}
                            loading={update.isPending}
                            onClick={() => {
                                update.mutate({
                                    id: playlistId,
                                    patch: { name: renaming!.trim() },
                                });
                                setRenaming(null);
                            }}
                        >
                            Rename
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal
                opened={confirmingDelete}
                onClose={() => setConfirmingDelete(false)}
                title="Delete this playlist?"
                centered
            >
                <Stack gap="md">
                    <Text size="sm">
                        The list and its order are deleted. Nothing happens to the items themselves
                        — they stay in your library.
                    </Text>
                    <Group justify="flex-end" gap="sm">
                        <Button variant="default" onClick={() => setConfirmingDelete(false)}>
                            Keep it
                        </Button>
                        <Button
                            color="oxblood"
                            loading={remove.isPending}
                            onClick={() => remove.mutate(playlistId)}
                        >
                            Delete playlist
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Stack>
    );
};
