"use client";

import { useMemo, useState } from "react";
import {
    ActionIcon,
    Box,
    Button,
    Center,
    Checkbox,
    Group,
    Loader,
    Menu,
    Modal,
    Pagination,
    Paper,
    Rating,
    Stack,
    Text,
    TextInput,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";

import {
    REEL_ITEM_LIMIT,
    libraryEntryId,
    type BulkActionResult,
    type LibraryListResponse,
    type Capture,
    type Clip,
    type LibraryEntry,
    type LibraryEntryType,
} from "@private-stock/core";

import { LoadFailed } from "@/components/LoadFailed";
import { MediaTile } from "@/components/MediaTile";
import { CaptureCard } from "@/components/media/CaptureCard";
import { ClipCard } from "@/components/media/ClipCard";
import { FrameLightbox } from "@/components/media/FrameLightbox";
import { CloseGlyph } from "@/components/media/Glyph";
import { BulkTagDialog } from "@/components/library/BulkTagDialog";
import { SelectionBar } from "@/components/library/SelectionBar";
import { UntagDialog } from "@/components/library/UntagDialog";
import { api } from "@/lib/api/client";
import { useDiscardCaptures, useRenameCapture } from "@/lib/api/captures";
import { useLibraryCount, useLibraryPage, useLibraryStillRun } from "@/lib/api/libraryTabs";
import { queryKeys } from "@/lib/api/queryKeys";
import {
    useAddReelItems,
    useCreateReel,
    useMarkClips,
    useOwnReels,
    useUntagClips,
} from "@/lib/api/reels";
import { describeBulkResult } from "@/components/library/describeBulkResult";
import { GALLERY_TRACKS, GRID_GAP, GRID_TRACKS, PRIORITY_TILES } from "@/lib/gridGeometry";
import { effectiveSort, libraryRequestParams, type LibraryView } from "@/lib/libraryQuery";
import { useOpenClip } from "@/lib/clipPage";
import { useDwellSeconds } from "@/lib/playbackPrefs";
import { settling } from "@/lib/settling";

import selectionClasses from "./SelectionBar.module.scss";

/**
 * The Clips, Stills and All tabs' grid (§14e "What a kind is").
 *
 * The library's header, tabs, search, sort and filters are the cellar's; this is the part below
 * them that has to know a clip from a still from an item: the tiles, opening one, the pager, and
 * the bar for what is ticked.
 *
 * **Each tile is its own kind's.** An item is the library's `MediaTile`, a clip the clip wall's
 * card (play over the page, tags from its tag line), a still the stills wall's card (opens the
 * lightbox). Their pictures differ -- a cover, a sprite tile, a 640px still -- and pretending
 * otherwise would mean drawing every clip as its video's cover.
 *
 * **The bar does what applies, and says so** (§14b). Videos and photos alone keep the library's
 * own `SelectionBar`; anything with a clip or a still in it gets one whose verbs each name what
 * they reach -- "Rate 13 · 2 stills can't be rated".
 */

type Key = `${LibraryEntryType}:${string}`;

const keyOf = (entry: LibraryEntry): Key => `${entry.type}:${libraryEntryId(entry)}`;

const plural = (count: number, one: string, many = `${one}s`): string =>
    `${count.toLocaleString()} ${count === 1 ? one : many}`;

interface LibraryEntriesProps {
    view: LibraryView;
    gallery: boolean;
    touch: boolean;
    wide: boolean;
    onPage: (page: number) => void;
    canDelete: boolean;
    /** Play from the top was pressed on the Stills tab, and the show is on. (Clips go to their page.) */
    playing: boolean;
    onStopPlaying: () => void;
}

export const LibraryEntries: React.FC<LibraryEntriesProps> = ({
    view,
    gallery,
    touch,
    wide,
    onPage,
    canDelete,
    playing,
    onStopPlaying,
}) => {
    const page = useLibraryPage(view, true);
    const count = useLibraryCount(view);
    const entries = useMemo(() => page.data?.items ?? [], [page.data?.items]);

    const [selected, setSelected] = useState<Map<Key, LibraryEntry>>(new Map());
    const [outcome, setOutcome] = useState<string | null>(null);
    const [stillOpen, setStillOpen] = useState<string | null>(null);

    const stills = entries.flatMap((entry) => (entry.type === "capture" ? [entry.capture] : []));

    /**
     * The Stills tab from the top: its first reel's worth, in the tab's order, through the same
     * lightbox as one still opened by hand -- stepping on by itself at the viewer's dwell.
     */
    const [dwellSeconds] = useDwellSeconds();
    const stillRun = useLibraryStillRun(view, playing && view.kind === "capture");
    const showStills = (stillRun.data?.items ?? []).flatMap((entry) =>
        entry.type === "capture" ? [entry.capture] : []
    );
    const [showAt, setShowAt] = useState<string | null>(null);
    const showOpen =
        playing && view.kind === "capture" ? (showAt ?? showStills[0]?.artifactId ?? null) : null;

    const stopShow = () => {
        setShowAt(null);
        onStopPlaying();
    };

    const openClip = useOpenClip();
    const discard = useDiscardCaptures();
    const rename = useRenameCapture();

    const toggle = (entry: LibraryEntry) =>
        setSelected((current) => {
            const next = new Map(current);
            const key = keyOf(entry);

            if (next.has(key)) next.delete(key);
            else next.set(key, entry);

            return next;
        });

    const pageKeys = entries.map(keyOf);
    const allSelected = pageKeys.length > 0 && pageKeys.every((key) => selected.has(key));
    const pageCount = count.data?.pageCount ?? null;

    const chosen = [...selected.values()];
    const total = count.data?.total ?? 0;

    /**
     * Every match, not just this page: the first reel's worth, hydrated in one page of the
     * library's own list -- `/api/library` takes a page of up to that many.
     */
    const [selectingAll, setSelectingAll] = useState(false);
    const selectAllMatching = () => {
        setSelectingAll(true);
        api<LibraryListResponse>(
            `/api/library?${libraryRequestParams({ ...view, sort: effectiveSort(view) }).toString()}&limit=${REEL_ITEM_LIMIT}&page=0`
        )
            .then((result) =>
                setSelected(new Map(result.items.map((entry) => [keyOf(entry), entry])))
            )
            .catch(() => setOutcome("Could not select them. Try again."))
            .finally(() => setSelectingAll(false));
    };
    const mediaOnly = chosen.length > 0 && chosen.every((entry) => entry.type === "media");

    const applied = (message: string) => {
        setSelected(new Map());
        setOutcome(message);
    };

    return (
        <Box style={{ flex: 1, minWidth: 0 }}>
            {entries.length > 0 && (
                <Checkbox
                    mb="sm"
                    size={touch ? "md" : "xs"}
                    color="brass"
                    checked={allSelected}
                    indeterminate={!allSelected && selected.size > 0}
                    label="Select page"
                    onChange={() =>
                        setSelected((current) => {
                            const next = new Map(current);

                            for (const entry of entries) {
                                if (allSelected) next.delete(keyOf(entry));
                                else next.set(keyOf(entry), entry);
                            }

                            return next;
                        })
                    }
                />
            )}

            {page.isLoading ? (
                <Center h={200}>
                    <Loader color="brass" />
                </Center>
            ) : page.isError ? (
                <LoadFailed
                    error={page.error}
                    what="this page"
                    onRetry={() => void page.refetch()}
                />
            ) : entries.length === 0 ? (
                <Stack align="center" gap={6} py={60}>
                    <Text fw={600}>Nothing here</Text>
                    <Text size="sm" c="dimmed" ta="center" maw={420}>
                        {view.kind === "clip"
                            ? "No clips match. Open a video and press [ at the start of the good bit, then ]."
                            : view.kind === "capture"
                              ? "No stills match. Press s while a video plays to take one."
                              : "Nothing matches these filters."}
                    </Text>
                </Stack>
            ) : (
                <Box
                    {...settling(page.isPlaceholderData)}
                    style={{
                        display: "grid",
                        gridTemplateColumns: gallery ? GALLERY_TRACKS : GRID_TRACKS,
                        gap: GRID_GAP,
                    }}
                >
                    {entries.map((entry, index) => {
                        const key = keyOf(entry);
                        const isSelected = selected.has(key);

                        if (entry.type === "media") {
                            return (
                                <div key={key}>
                                    <MediaTile
                                        item={entry.item}
                                        gallery={gallery}
                                        selected={isSelected}
                                        onToggleSelected={() => toggle(entry)}
                                        priority={index < PRIORITY_TILES}
                                    />
                                </div>
                            );
                        }

                        if (entry.type === "clip") {
                            return (
                                <div key={key}>
                                    <ClipCard
                                        clip={entry.clip}
                                        selected={isSelected}
                                        onToggle={() => toggle(entry)}
                                        onPlay={() => openClip(entry.clip.id, view)}
                                        square={false}
                                        // The viewer names the video; on the library's grid
                                        // a third line made every row a clip is in taller.
                                        showSource={false}
                                    />
                                </div>
                            );
                        }

                        return (
                            <div key={key}>
                                <CaptureCard
                                    capture={entry.capture}
                                    selected={isSelected}
                                    onToggle={() => toggle(entry)}
                                    onOpen={() => setStillOpen(entry.capture.artifactId)}
                                />
                            </div>
                        );
                    })}
                </Box>
            )}

            {(view.page > 0 || page.data?.hasMore) && (
                <Center py="lg">
                    {pageCount === null ? (
                        <Group gap="sm">
                            <Button
                                variant="default"
                                disabled={view.page === 0}
                                onClick={() => onPage(view.page - 1)}
                            >
                                Previous
                            </Button>
                            <Text size="sm" c="dimmed">
                                Page {view.page + 1}
                            </Text>
                            <Button
                                variant="default"
                                disabled={!page.data?.hasMore}
                                onClick={() => onPage(view.page + 1)}
                            >
                                Next
                            </Button>
                        </Group>
                    ) : (
                        <Pagination
                            value={view.page + 1}
                            onChange={(value) => onPage(value - 1)}
                            total={pageCount}
                            color="brass"
                            siblings={wide ? 2 : 0}
                            withEdges
                        />
                    )}
                </Center>
            )}

            {mediaOnly && (
                <SelectionBar
                    selected={chosen.map(libraryEntryId)}
                    onClear={() => setSelected(new Map())}
                    canDelete={canDelete}
                    onApplied={applied}
                />
            )}

            {chosen.length > 0 && !mediaOnly && (
                <MixedSelectionBar
                    chosen={chosen}
                    onClear={() => setSelected(new Map())}
                    onApplied={applied}
                    onDiscard={(ids, done) =>
                        discard.mutate(ids, {
                            onSuccess: () => {
                                done();
                                applied(`Discarded ${plural(ids.length, "still")}`);
                            },
                        })
                    }
                    discarding={discard.isPending}
                    selectAll={
                        view.kind === "clip" &&
                        total > chosen.length &&
                        chosen.length < REEL_ITEM_LIMIT
                            ? {
                                  label:
                                      total > REEL_ITEM_LIMIT
                                          ? `Select the first ${REEL_ITEM_LIMIT} of ${total.toLocaleString()}`
                                          : `Select all ${total.toLocaleString()} matching`,
                                  busy: selectingAll,
                                  onSelect: selectAllMatching,
                              }
                            : undefined
                    }
                />
            )}

            {chosen.length === 0 && outcome && (
                <Paper className={selectionClasses.bar} shadow="md" radius="md" withBorder>
                    <Group gap="sm" wrap="nowrap">
                        <Text size="sm">{outcome}</Text>
                        <Button size="compact-xs" variant="subtle" onClick={() => setOutcome(null)}>
                            Dismiss
                        </Button>
                    </Group>
                </Paper>
            )}

            <FrameLightbox
                frames={showStills}
                openId={showOpen}
                onClose={stopShow}
                onOpenId={setShowAt}
                onDelete={(artifactId) => discard.mutate([artifactId])}
                seekHref={(frame) =>
                    `/media/${showStills.find((still) => still.artifactId === frame.artifactId)?.mediaId}?at=${frame.atMs}`
                }
                onRename={(artifactId, label) => {
                    const still = showStills.find(
                        (candidate) => candidate.artifactId === artifactId
                    );

                    if (still) rename.mutate({ mediaId: still.mediaId, artifactId, label });
                }}
                busy={discard.isPending}
                showDwellMs={dwellSeconds * 1000}
            />

            <FrameLightbox
                frames={stills}
                openId={stillOpen}
                onClose={() => setStillOpen(null)}
                onOpenId={setStillOpen}
                onDelete={(artifactId) =>
                    discard.mutate([artifactId], { onSuccess: () => setStillOpen(null) })
                }
                seekHref={(frame) =>
                    `/media/${stills.find((still) => still.artifactId === frame.artifactId)?.mediaId}?at=${frame.atMs}`
                }
                onRename={(artifactId, label) => {
                    const still = stills.find((candidate) => candidate.artifactId === artifactId);

                    if (still) rename.mutate({ mediaId: still.mediaId, artifactId, label });
                }}
                busy={discard.isPending}
            />
        </Box>
    );
};

interface MixedSelectionBarProps {
    chosen: LibraryEntry[];
    onClear: () => void;
    onApplied: (message: string) => void;
    onDiscard: (artifactIds: string[], done: () => void) => void;
    discarding: boolean;
    /**
     * Every clip the filter matches, up to a reel's worth (§14d "Reviewing recordings for a
     * reel"): a reel by period is rarely one page. Only on the Clips tab, and only while more
     * match than are ticked.
     */
    selectAll?: { label: string; busy: boolean; onSelect: () => void };
}

/**
 * What can be done with a selection holding clips or stills (§14b, §14e).
 *
 * Every verb reaches the kinds it applies to and its label says which: tagging and stars reach
 * items and clips, a reel only clips, discarding only stills. A verb that reaches nothing ticked
 * is not drawn, the house rule (§9).
 */
const MixedSelectionBar: React.FC<MixedSelectionBarProps> = ({
    chosen,
    onClear,
    onApplied,
    onDiscard,
    discarding,
    selectAll,
}) => {
    const queryClient = useQueryClient();
    const mediaIds = chosen.flatMap((entry) => (entry.type === "media" ? [entry.item.id] : []));
    const clips: Clip[] = chosen.flatMap((entry) => (entry.type === "clip" ? [entry.clip] : []));
    const stills: Capture[] = chosen.flatMap((entry) =>
        entry.type === "capture" ? [entry.capture] : []
    );
    const clipIds = clips.map((clip) => clip.id);

    const [tagging, setTagging] = useState(false);
    const [untagging, setUntagging] = useState<"items" | "clips" | null>(null);
    const [confirmingDiscard, setConfirmingDiscard] = useState(false);
    const [naming, setNaming] = useState(false);
    const [reelName, setReelName] = useState("");
    const [busy, setBusy] = useState(false);

    const marks = useMarkClips();
    const reels = useOwnReels();
    const addItems = useAddReelItems();
    const createReel = useCreateReel();
    const untagClips = useUntagClips((result) => {
        setUntagging(null);
        onApplied(`Untagged ${plural(result.clips, "clip")}`);
    });

    const markable = mediaIds.length + clipIds.length;
    /** What a verb reaches, in words: "3 items and 2 clips". */
    const reached = [
        mediaIds.length ? plural(mediaIds.length, "item") : null,
        clipIds.length ? plural(clipIds.length, "clip") : null,
    ]
        .filter(Boolean)
        .join(" and ");
    /** Said after any verb a still cannot take. */
    const leftAlone =
        stills.length > 0 ? ` · ${plural(stills.length, "still")} left as they are` : "";

    /** Stars or a heart on the items and the clips, in one press. */
    const mark = async (input: { rating?: number | null; favorite?: boolean }, verb: string) => {
        setBusy(true);

        try {
            if (mediaIds.length > 0) {
                const body =
                    input.rating !== undefined
                        ? { action: "rate", mediaIds, rating: input.rating }
                        : { action: "favorite", mediaIds, favorite: input.favorite };

                await api<BulkActionResult>("/api/media/bulk", {
                    method: "POST",
                    body: JSON.stringify(body),
                });
                void queryClient.invalidateQueries({ queryKey: queryKeys.media.all() });
                void queryClient.invalidateQueries({ queryKey: queryKeys.home() });
            }

            if (clipIds.length > 0) {
                await marks.mutateAsync({ clipIds, ...input });
            }

            onApplied(`${verb} ${reached}${leftAlone}`);
        } catch {
            onApplied("Nothing was changed.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <Paper className={selectionClasses.bar} shadow="md" radius="md" withBorder>
            <Group gap="xs" wrap="wrap" justify="center">
                <Text size="sm" fw={600} style={{ whiteSpace: "nowrap" }}>
                    {[
                        mediaIds.length && plural(mediaIds.length, "item"),
                        clipIds.length && plural(clipIds.length, "clip"),
                        stills.length && plural(stills.length, "still"),
                    ]
                        .filter(Boolean)
                        .join(" · ")}
                </Text>

                {markable > 0 && (
                    <>
                        <Button
                            size="compact-sm"
                            variant="default"
                            disabled={busy}
                            onClick={() => setTagging(true)}
                        >
                            Tag {reached}…
                        </Button>
                        {mediaIds.length > 0 && (
                            <Button
                                size="compact-sm"
                                variant="default"
                                disabled={busy}
                                onClick={() => setUntagging("items")}
                            >
                                Untag {plural(mediaIds.length, "item")}
                            </Button>
                        )}
                        {clipIds.length > 0 && (
                            <Button
                                size="compact-sm"
                                variant="default"
                                disabled={busy}
                                onClick={() => setUntagging("clips")}
                            >
                                Untag {plural(clipIds.length, "clip")}
                            </Button>
                        )}

                        <Group gap={4} align="center">
                            <Text size="xs" c="dimmed">
                                Rate
                            </Text>
                            <Rating
                                size="sm"
                                color="brass"
                                value={0}
                                readOnly={busy}
                                onChange={(rating) => void mark({ rating }, "Rated")}
                            />
                            <ActionIcon
                                size="sm"
                                variant="subtle"
                                color="gray"
                                disabled={busy}
                                aria-label="Clear rating"
                                title="Clear rating"
                                onClick={() => void mark({ rating: null }, "Cleared the rating of")}
                            >
                                <CloseGlyph size={14} />
                            </ActionIcon>
                        </Group>

                        <Button
                            size="compact-sm"
                            variant="default"
                            color="oxblood"
                            disabled={busy}
                            onClick={() => void mark({ favorite: true }, "Favourited")}
                        >
                            ♥
                        </Button>
                        <Button
                            size="compact-sm"
                            variant="default"
                            disabled={busy}
                            onClick={() => void mark({ favorite: false }, "Unfavourited")}
                        >
                            ♡
                        </Button>
                    </>
                )}

                {clipIds.length > 0 && (
                    <Menu position="top" withinPortal>
                        <Menu.Target>
                            <Button
                                size="compact-sm"
                                variant="default"
                                loading={addItems.isPending}
                            >
                                Add {plural(clipIds.length, "clip")} to reel
                            </Button>
                        </Menu.Target>
                        <Menu.Dropdown>
                            {(reels.data?.items ?? []).map((reel) => (
                                <Menu.Item
                                    key={reel.id}
                                    onClick={() =>
                                        addItems.mutate(
                                            { id: reel.id, input: { clipIds } },
                                            {
                                                onSuccess: () =>
                                                    onApplied(
                                                        `Added ${plural(clipIds.length, "clip")} to ${reel.name}`
                                                    ),
                                            }
                                        )
                                    }
                                >
                                    {reel.name}
                                </Menu.Item>
                            ))}
                            {(reels.data?.items.length ?? 0) > 0 && <Menu.Divider />}
                            <Menu.Item onClick={() => setNaming(true)}>New reel…</Menu.Item>
                        </Menu.Dropdown>
                    </Menu>
                )}

                {stills.length > 0 && (
                    <Button
                        size="compact-sm"
                        variant="default"
                        color="oxblood"
                        onClick={() => setConfirmingDiscard(true)}
                    >
                        Discard {plural(stills.length, "still")}…
                    </Button>
                )}

                {selectAll && (
                    <Button
                        size="compact-sm"
                        variant="subtle"
                        loading={selectAll.busy}
                        onClick={selectAll.onSelect}
                    >
                        {selectAll.label}
                    </Button>
                )}

                <Button size="compact-sm" variant="subtle" color="gray" onClick={onClear}>
                    Clear
                </Button>
            </Group>

            {tagging && (
                <BulkTagDialog
                    opened
                    onClose={() => setTagging(false)}
                    target={{ type: "mixed", mediaIds, clipIds }}
                    onApplied={(message) => onApplied(message)}
                />
            )}

            <UntagDialog
                opened={untagging === "items"}
                onClose={() => setUntagging(null)}
                selected={mediaIds}
                onRemove={(tagIds) => {
                    setBusy(true);
                    void api<BulkActionResult>("/api/media/bulk", {
                        method: "POST",
                        body: JSON.stringify({ action: "untag", mediaIds, tagIds }),
                    })
                        .then((result) => {
                            void queryClient.invalidateQueries({ queryKey: queryKeys.media.all() });
                            void queryClient.invalidateQueries({ queryKey: queryKeys.tags.all() });
                            setUntagging(null);
                            onApplied(describeBulkResult(result));
                        })
                        .catch(() => onApplied("Nothing was changed."))
                        .finally(() => setBusy(false));
                }}
                busy={busy}
            />
            <UntagDialog
                opened={untagging === "clips"}
                onClose={() => setUntagging(null)}
                selected={clipIds}
                of="clips"
                onRemove={(tagIds) => untagClips.mutate({ clipIds, tagIds })}
                busy={untagClips.isPending}
            />

            <Modal
                opened={confirmingDiscard}
                onClose={() => setConfirmingDiscard(false)}
                title={`Discard ${plural(stills.length, "still")}?`}
                centered
            >
                <Stack gap="md">
                    <Text size="sm">
                        Nothing goes to the trash: they cannot be restored. An item using one as its
                        cover goes back to the generated cover.
                    </Text>
                    <Group justify="flex-end" gap="sm">
                        <Button variant="default" onClick={() => setConfirmingDiscard(false)}>
                            Keep them
                        </Button>
                        <Button
                            color="oxblood"
                            loading={discarding}
                            onClick={() =>
                                onDiscard(
                                    stills.map((still) => still.artifactId),
                                    () => setConfirmingDiscard(false)
                                )
                            }
                        >
                            Discard
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal opened={naming} onClose={() => setNaming(false)} title="New reel" centered>
                <Stack gap="md">
                    <TextInput
                        label="Name"
                        value={reelName}
                        onChange={(event) => setReelName(event.currentTarget.value)}
                        data-autofocus
                    />
                    <Text size="xs" c="dimmed">
                        {plural(clipIds.length, "selected clip")} will go into it, in the order they
                        are listed.
                    </Text>
                    <Button
                        disabled={reelName.trim() === ""}
                        loading={createReel.isPending}
                        onClick={() => {
                            const name = reelName.trim();

                            createReel.mutate(
                                { name, visibility: "private", clipIds },
                                {
                                    onSuccess: () => {
                                        setNaming(false);
                                        setReelName("");
                                        onApplied(
                                            `Made ${name} with ${plural(clipIds.length, "clip")}`
                                        );
                                    },
                                }
                            );
                        }}
                    >
                        Create reel
                    </Button>
                </Stack>
            </Modal>
        </Paper>
    );
};
