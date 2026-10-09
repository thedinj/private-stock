"use client";

import { useMemo, useState } from "react";
import {
    Box,
    Button,
    Checkbox,
    Group,
    Menu,
    Modal,
    Pagination,
    Paper,
    SegmentedControl,
    Select,
    Stack,
    Text,
    TextInput,
} from "@mantine/core";

import {
    clipNaturalDirection,
    clipSorts,
    type Clip,
    type ClipSort,
    type TagBatch,
} from "@private-stock/core";

import { LoadFailed } from "@/components/LoadFailed";
import { BulkTagDialog } from "@/components/library/BulkTagDialog";
import { ClipCard } from "@/components/media/ClipCard";
import { ClipTagFilter, type ClipTagFilterValue } from "@/components/media/ClipTagFilter";
import { EmptyState } from "@/components/shell/EmptyState";
import { PageLoader } from "@/components/shell/PageLoader";
import { PagePlate } from "@/components/shell/PagePlate";
import { useAddReelItems, useClips, useCreateReel, useOwnReels } from "@/lib/api/reels";
import { useUndoBatch } from "@/lib/api/tags";
import selectionClasses from "@/components/library/SelectionBar.module.scss";
import {
    defineView,
    enumField,
    flagField,
    idListField,
    pageField,
    textField,
    useUrlSearch,
    useUrlView,
} from "@/lib/urlView";

/**
 * The clip browser (§14d).
 *
 * The surface that makes the working case possible: a reel of a holiday is forty spans marked
 * across dozens of videos over weeks, and gathering them by reopening forty item pages is not
 * gathering them.
 *
 * **Tick some clips, then say what to do with them.** This began as a mode — you chose a reel at
 * the top and rows turned into membership toggles — on the theory that the browser could *be* the
 * reel's editor. It read as a puzzle: nothing happened until you had set a control whose purpose
 * was not apparent, a ticked box could not be unticked, and there was no way to make a reel from
 * the page where you were looking at the things to put in one. Select-then-act is what the
 * library grid already does for bulk tagging, it needs no mode, and "New reel…" is one of the
 * actions rather than a journey to another page.
 *
 * Three things keep a few hundred rows usable, besides the selection:
 *
 *  - **Faces, for free** — the scrubber's sprite sheet already has a tile near every in point, so
 *    a clip's thumbnail costs no ffmpeg, no artifact and no disk.
 *  - **Grouped by the video they came from**, which is how they were made: one sitting per file.
 *  - **"Not in a reel yet"**, which is the question somebody assembling one keeps asking.
 *
 * And tags, for the reel that cuts across videos (§14d "Tagging clips"): "Video has: pool" and
 * "Clip has: jumping" finds every jump into every pool, ready to tick and add.
 *
 * Your own clips and nobody else's: a clip is private raw material, and the only place one
 * reaches another account is as a span inside a reel they can open.
 */

const SORTS: { value: ClipSort; label: string }[] = [
    { value: "created", label: "Recently marked" },
    { value: "startMs", label: "Position in file" },
    { value: "duration", label: "Length" },
    { value: "label", label: "Name" },
];

/**
 * The view, in the address (§14b), so opening a clip's video and coming back -- or leaving
 * through the sidebar and returning -- finds the same search, filter, layout and page.
 */
const clipsView = defineView("/clips", {
    sort: enumField("sort", clipSorts, "created"),
    search: textField("q"),
    unusedOnly: flagField("unused"),
    flat: flagField("flat"),
    videoTags: idListField("vt"),
    videoNotTags: idListField("vnt"),
    videoMatch: enumField("vm", ["all", "any"], "all"),
    clipTags: idListField("ct"),
    clipNotTags: idListField("cnt"),
    clipMatch: enumField("cm", ["all", "any"], "all"),
    orVideo: idListField("orv"),
    page: pageField(),
});

/** An empty list is no filter, and stays out of the request and its cache key. */
const ids = (list: string[]): string[] | undefined => (list.length > 0 ? list : undefined);

const ClipsPage: React.FC = () => {
    const [view, apply] = useUrlView(clipsView);
    const { sort, unusedOnly, page } = view;
    const grouped = !view.flat;
    const [search, setSearch] = useUrlSearch(view.search, (settled) =>
        apply({ search: settled, page: 0 })
    );

    const [selected, setSelected] = useState<string[]>([]);
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState("");
    /**
     * What just happened, in words, for the outcome bar. The badges move too, but a count is
     * easier to believe.
     */
    const [done, setDone] = useState<string | null>(null);
    /** The batch the last "Tag…" wrote, while its Undo is on offer. */
    const [lastBatch, setLastBatch] = useState<TagBatch | null>(null);
    const [tagging, setTagging] = useState(false);
    const undo = useUndoBatch(() => {
        setLastBatch(null);
        setDone("Tags withdrawn");
    });

    const tagFilter: ClipTagFilterValue = {
        videoTags: view.videoTags,
        videoNotTags: view.videoNotTags,
        videoMatch: view.videoMatch,
        clipTags: view.clipTags,
        clipNotTags: view.clipNotTags,
        clipMatch: view.clipMatch,
        orVideo: view.orVideo,
    };
    const tagFiltering =
        view.videoTags.length +
            view.videoNotTags.length +
            view.clipTags.length +
            view.clipNotTags.length >
        0;
    const filtering = Boolean(view.search) || unusedOnly || tagFiltering;

    const reels = useOwnReels();
    const addItems = useAddReelItems();
    const createReel = useCreateReel();

    const { data, isLoading, error, refetch } = useClips({
        sort,
        direction: clipNaturalDirection(sort),
        search: view.search || undefined,
        unusedOnly: unusedOnly || undefined,
        videoTags: ids(view.videoTags),
        videoNotTags: ids(view.videoNotTags),
        videoMatch: view.videoTags.length > 1 ? view.videoMatch : undefined,
        clipTags: ids(view.clipTags),
        clipNotTags: ids(view.clipNotTags),
        clipMatch: view.clipTags.length > 1 ? view.clipMatch : undefined,
        orVideo: ids(view.orVideo),
        page,
    });

    const items = useMemo(() => data?.items ?? [], [data?.items]);
    const pageIds = useMemo(() => items.map((clip) => clip.id), [items]);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
    /** Whether the box is showing anything, which is what decides which way it goes. */
    const pageTouched = pageIds.some((id) => selected.includes(id));

    /**
     * Grouped by source item, in the order the query returned them.
     *
     * Two hundred flat rows is unreadable; thirty videos holding a few spans each is navigable.
     * The groups keep the query's own order rather than imposing a second one, so changing the
     * sort still changes what you see first.
     */
    const groups = useMemo(() => {
        const out = new Map<string, { title: string; clips: Clip[] }>();

        for (const clip of items) {
            const group = out.get(clip.mediaId) ?? { title: clip.mediaTitle, clips: [] };

            group.clips.push(clip);
            out.set(clip.mediaId, group);
        }

        return [...out.entries()];
    }, [items]);

    const pages = data ? Math.ceil(data.total / Math.max(1, data.pageSize)) : 0;
    /** Everything the current filter matches, not merely this page of it. */
    const total = data?.total ?? 0;
    const mine = reels.data?.items ?? [];

    const toggle = (id: string) =>
        setSelected((current) =>
            current.includes(id) ? current.filter((other) => other !== id) : [...current, id]
        );

    const addTo = (reelId: string, reelName: string) => {
        const count = selected.length;

        addItems.mutate(
            { id: reelId, input: { clipIds: selected } },
            {
                onSuccess: () => {
                    setSelected([]);
                    setLastBatch(null);
                    setDone(`Added ${count} clip${count === 1 ? "" : "s"} to ${reelName}`);
                },
            }
        );
    };

    /**
     * A wall of cards, laid out like the shelf of reels.
     *
     * `auto-fill` with a floor rather than a fixed count, so the same page is four across on a
     * laptop and two on a phone without a breakpoint deciding it. 180px is about where a sprite
     * tile stops being recognisable — they are generated 200px wide (§9), so this renders them
     * close to 1:1 and never asks the browser to invent detail.
     */
    const wall = (clips: Clip[], showSource: boolean) => (
        <Box
            style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                gap: "var(--mantine-spacing-xs)",
            }}
        >
            {clips.map((clip) => (
                <ClipCard
                    key={clip.id}
                    clip={clip}
                    selected={selected.includes(clip.id)}
                    onToggle={() => toggle(clip.id)}
                    showSource={showSource}
                />
            ))}
        </Box>
    );

    return (
        <Stack gap="md">
            {/* The letterhead every page wears, at the one size every page uses (§14). */}
            <PagePlate
                eyebrow={
                    data
                        ? `${total.toLocaleString()} ${total === 1 ? "clip" : "clips"}`
                        : "Your raw material"
                }
                title="Clips"
                lede={
                    <>
                        Spans you have marked. Press <kbd>[</kbd> and <kbd>]</kbd> while watching.
                    </>
                }
            />

            {/*
             * The toolbar decides **what is shown**; what to do with what is picked is the bar at
             * the foot of the page, as in the library (`SelectionBar`).
             *
             * They were one toolbar, filters on the left and actions on the right, and once clips
             * had tags that put two buttons called "Tags" and "Tag…" side by side -- one a filter,
             * the other a write -- with nothing to tell them apart but an ellipsis.
             *
             * The fields have no labels. "Sort" over a control whose value reads "Recently
             * marked", and "Search" over a box that says "Search names", are each a line of type
             * to say what the control already said. `wrap` lets the row become two on a phone.
             *
             * **It holds its space.** Nothing here appears or disappears with a selection, so the
             * wall never moves under a pointer working along a row of cards. The action bar
             * floats over the foot of the page instead of pushing anything down.
             *
             * `sticky` because the reason to filter is a long page, and a filter is no use once it
             * has scrolled away.
             */}
            <Paper
                withBorder
                p="xs"
                radius="sm"
                style={{
                    position: "sticky",
                    top: "var(--mantine-spacing-xs)",
                    zIndex: 2,
                    background: "var(--ps-surface)",
                }}
            >
                <Group justify="space-between" wrap="wrap" gap="sm">
                    <Group gap="xs" wrap="wrap">
                        <Select
                            data={SORTS}
                            value={sort}
                            onChange={(value) => {
                                apply({ sort: (value as ClipSort) ?? "created", page: 0 });
                            }}
                            allowDeselect={false}
                            size="sm"
                            w={{ base: "100%", xs: 170 }}
                            aria-label="Sort"
                        />
                        <TextInput
                            placeholder="Search names"
                            value={search}
                            onChange={(event) => setSearch(event.currentTarget.value)}
                            size="sm"
                            w={{ base: "100%", xs: 180 }}
                            aria-label="Search clip names"
                        />
                        <SegmentedControl
                            value={unusedOnly ? "unused" : "all"}
                            onChange={(value) => apply({ unusedOnly: value === "unused", page: 0 })}
                            size="sm"
                            data={[
                                { value: "all", label: "All" },
                                { value: "unused", label: "Not in a reel" },
                            ]}
                        />
                        <ClipTagFilter
                            value={tagFilter}
                            onChange={(patch) => apply({ ...patch, page: 0 })}
                        />
                        {/* A choice between two layouts, shown as the two of them. It was a button
                            labelled with the state it was *not* in, which reads as the state it
                            is in -- the switch-says-what-it-does trap `PlaylistDetail` records. */}
                        <SegmentedControl
                            value={grouped ? "grouped" : "flat"}
                            onChange={(value) => apply({ flat: value === "flat" })}
                            size="sm"
                            data={[
                                { value: "grouped", label: "By video" },
                                { value: "flat", label: "Flat" },
                            ]}
                            aria-label="Layout"
                        />
                    </Group>

                    <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                        {/*
                         * The only selection control, doing both jobs.
                         *
                         * There was a "Clear" button beside it, and it was the clutter it looked
                         * like: this box is already ticked or half-ticked whenever there is
                         * anything to clear, and unticking a ticked box is what anybody would try
                         * first. So ticking takes the page and unticking drops **everything**,
                         * which is the more useful half — it also catches a selection made on a
                         * page since paged away from, where clearing only this page would leave a
                         * count nothing on screen accounts for.
                         *
                         * Keyed off what the box *looks* like rather than off the selection, so it
                         * never does the opposite of what it appears to offer: an unticked box on
                         * a page none of whose clips are picked still selects that page.
                         *
                         * **It stays up here** rather than joining the actions at the foot of the
                         * page, because "everything this tag filter found" is the selection a reel
                         * is most often made from, and the action bar only appears once something
                         * is picked.
                         *
                         * **Its label says what clicking it does.** The text beside it used to
                         * double as the page's news -- "Tagged 1 clip" -- and read as the box's
                         * label. The count of what is picked is on the action bar; the clip count
                         * is in the page's eyebrow.
                         */}
                        <Checkbox
                            checked={allSelected}
                            indeterminate={!allSelected && pageTouched}
                            disabled={items.length === 0}
                            onChange={() =>
                                setSelected((current) =>
                                    pageTouched ? [] : [...new Set([...current, ...pageIds])]
                                )
                            }
                            label={pageTouched ? "Clear selection" : "Select all"}
                            aria-label={
                                pageTouched
                                    ? "Clear the selection"
                                    : "Select everything on this page"
                            }
                            styles={{ label: { whiteSpace: "nowrap" } }}
                        />
                    </Group>
                </Group>
            </Paper>

            {isLoading && <PageLoader />}

            {error && <LoadFailed error={error} what="your clips" onRetry={() => void refetch()} />}

            {data && items.length === 0 && (
                <EmptyState title={filtering ? "Nothing matches that" : "No clips yet"}>
                    {filtering
                        ? "Try another name or fewer tags, or show every clip."
                        : "Open a video and press [ at the start of the good bit, then ]."}
                </EmptyState>
            )}

            {grouped
                ? groups.map(([mediaId, group]) => (
                      <Stack key={mediaId} gap={6}>
                          <Text size="xs" c="dimmed" fw={600}>
                              {group.title} · {group.clips.length}
                          </Text>
                          {/* The heading already says where these came from. */}
                          {wall(group.clips, false)}
                      </Stack>
                  ))
                : wall(items, true)}

            {pages > 1 && (
                <Group justify="center">
                    <Pagination
                        value={page + 1}
                        onChange={(value) => apply({ page: value - 1 })}
                        total={pages}
                        color="brass"
                    />
                </Group>
            )}

            {/*
             * What to do with the picked clips, floating at the foot of the page like the
             * library's `SelectionBar`: a selection is made by scrolling and ticking, so a bar
             * that scrolls away is one you have to go back for, and it covers the page's foot
             * rather than pushing the wall down. Only while something is picked, so its buttons
             * are never disabled -- the page's lede and the checkboxes on every card already say
             * what it is for.
             */}
            {selected.length > 0 && (
                <Paper className={selectionClasses.bar} shadow="md" radius="md" withBorder>
                    {/* Wraps rather than overflowing a narrow phone: four controls in a row is
                        more than 360px holds. */}
                    <Group gap="xs" wrap="wrap" justify="center">
                        <Text size="sm" fw={600} style={{ whiteSpace: "nowrap" }}>
                            {selected.length} selected
                        </Text>
                        <Button size="sm" variant="default" onClick={() => setTagging(true)}>
                            Tag…
                        </Button>

                        <Menu position="top-end" withinPortal>
                            <Menu.Target>
                                <Button size="sm" loading={addItems.isPending}>
                                    Add to reel
                                </Button>
                            </Menu.Target>
                            <Menu.Dropdown>
                                {mine.length > 0 && (
                                    <>
                                        <Menu.Label>Your reels</Menu.Label>
                                        {mine.map((reel) => (
                                            <Menu.Item
                                                key={reel.id}
                                                onClick={() => addTo(reel.id, reel.name)}
                                            >
                                                {reel.name}
                                            </Menu.Item>
                                        ))}
                                        <Menu.Divider />
                                    </>
                                )}
                                {/* The thing whose absence made this page a dead end. */}
                                <Menu.Item onClick={() => setNaming(true)}>New reel…</Menu.Item>
                            </Menu.Dropdown>
                        </Menu>
                        <Button
                            size="sm"
                            variant="subtle"
                            color="gray"
                            onClick={() => setSelected([])}
                        >
                            Clear
                        </Button>
                    </Group>
                </Paper>
            )}

            {/*
             * What just happened, and the way back from it -- the library's outcome bar, in the
             * same place (`LibraryCellar`). Away from the selection controls, so it cannot be
             * mistaken for a label on one of them, and dismissed by hand rather than timed out:
             * an Undo that fades is one somebody looks up to find gone.
             */}
            {selected.length === 0 && done && (
                <Paper className={selectionClasses.bar} shadow="md" radius="md" withBorder>
                    <Group gap="sm" wrap="nowrap">
                        <Text size="sm">{done}</Text>
                        {lastBatch && (
                            <Button
                                size="compact-xs"
                                variant="light"
                                color="brass"
                                loading={undo.isPending}
                                onClick={() => undo.mutate(lastBatch.id)}
                            >
                                Undo
                            </Button>
                        )}
                        <Button
                            size="compact-xs"
                            variant="subtle"
                            color="gray"
                            onClick={() => {
                                setDone(null);
                                setLastBatch(null);
                            }}
                        >
                            Dismiss
                        </Button>
                    </Group>
                </Paper>
            )}

            {/* Keyed on opening, so each opens fresh with nothing carried from the last apply. */}
            {tagging && (
                <BulkTagDialog
                    opened
                    onClose={() => setTagging(false)}
                    target={{ type: "clips", clipIds: selected }}
                    onApplied={(message, batch) => {
                        setSelected([]);
                        setDone(message);
                        setLastBatch(batch ?? null);
                    }}
                />
            )}

            <Modal opened={naming} onClose={() => setNaming(false)} title="New reel" centered>
                <Stack gap="md">
                    <TextInput
                        label="Name"
                        value={name}
                        onChange={(event) => setName(event.currentTarget.value)}
                        data-autofocus
                    />
                    <Text size="xs" c="dimmed">
                        {selected.length} selected clip{selected.length === 1 ? "" : "s"} will go
                        into it, in the order they are listed.
                    </Text>
                    <Button
                        disabled={name.trim() === ""}
                        loading={createReel.isPending}
                        onClick={() => {
                            const count = selected.length;
                            const reelName = name.trim();

                            /*
                             * Created with the clips already in it: two requests can half-fail,
                             * and what survives is an empty reel named after something it does
                             * not contain (§14b).
                             */
                            createReel.mutate(
                                { name: reelName, visibility: "private", clipIds: selected },
                                {
                                    onSuccess: () => {
                                        setNaming(false);
                                        setName("");
                                        setSelected([]);
                                        setLastBatch(null);
                                        setDone(
                                            `Made ${reelName} with ${count} clip${count === 1 ? "" : "s"}`
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

            <Box />
        </Stack>
    );
};

export default ClipsPage;
