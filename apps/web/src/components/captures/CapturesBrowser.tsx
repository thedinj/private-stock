"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
    Anchor,
    Box,
    Button,
    Checkbox,
    Group,
    Image,
    Modal,
    Pagination,
    Paper,
    SegmentedControl,
    Select,
    SimpleGrid,
    Stack,
    Text,
} from "@mantine/core";

import { captureNaturalDirection, type Capture, type CaptureSort } from "@private-stock/core";

import { LoadFailed } from "@/components/LoadFailed";
import { CaptureCard } from "@/components/media/CaptureCard";
import { EmptyState } from "@/components/shell/EmptyState";
import { PageLoader } from "@/components/shell/PageLoader";
import { PagePlate } from "@/components/shell/PagePlate";
import { FrameLightbox } from "@/components/media/FrameLightbox";
import { useCaptures, useDiscardCaptures, useRenameCapture } from "@/lib/api/captures";
import { captureView } from "@/lib/captureView";
import { rememberReturn } from "@/lib/returnTo";
import { useUrlSearch, useUrlView } from "@/lib/urlView";
import { SearchInput } from "@/components/SearchInput";

/**
 * Your captures, in one place (§9).
 *
 * Every still you have grabbed, across the library — the question the item page's strip can
 * only answer one item at a time. Only your own: captures are library-wide to read, and
 * everybody's stay on each item's strip, but "what have I grabbed" is a question about you.
 *
 * Laid out like `/clips`, whose toolbar reasoning applies unchanged: one sticky bar that holds
 * its height whatever is selected, filters on the left and the action on the right, and a wall
 * of cards grouped by the video they came from. The view lives in the address (§14b, §20), so a
 * reload or the back button returns to the same page of the same list.
 */

const SORTS: { value: CaptureSort; label: string }[] = [
    { value: "created", label: "Recently captured" },
    { value: "title", label: "Video title" },
    { value: "position", label: "Position in video" },
];

/** How many selected stills the confirmation shows before it says "and N more". */
const CONFIRM_PREVIEW = 12;

export const CapturesBrowser: React.FC = () => {
    const [view, apply] = useUrlView(captureView);
    const [search, setSearch] = useUrlSearch(view.search, (settled) =>
        apply({ search: settled, page: 0 })
    );

    /**
     * Held as the captures themselves rather than ids, so the confirmation can show pictures of
     * a selection made on pages since paged away from. Kept across pages, as `/clips` keeps
     * its selection: gathering what to throw away is the same work as gathering what to keep.
     */
    const [selected, setSelected] = useState<Map<string, Capture>>(new Map());
    const [confirming, setConfirming] = useState(false);
    const [openId, setOpenId] = useState<string | null>(null);
    /** What just happened, in words, until the next selection replaces it. */
    const [done, setDone] = useState<string | null>(null);

    const discard = useDiscardCaptures();
    const rename = useRenameCapture();

    const { data, isLoading, error, refetch } = useCaptures({
        sort: view.sort,
        direction: view.direction ?? captureNaturalDirection(view.sort),
        search: view.search || undefined,
        page: view.page,
    });

    const items = useMemo(() => data?.items ?? [], [data?.items]);
    const byId = useMemo(
        () => new Map(items.map((capture) => [capture.artifactId, capture])),
        [items]
    );
    const allSelected = items.length > 0 && items.every((c) => selected.has(c.artifactId));
    const pageTouched = items.some((capture) => selected.has(capture.artifactId));

    /** Grouped by source item, in the order the query returned them, as `/clips` does. */
    const groups = useMemo(() => {
        const out = new Map<string, { title: string; captures: Capture[] }>();

        for (const capture of items) {
            const group = out.get(capture.mediaId) ?? { title: capture.mediaTitle, captures: [] };

            group.captures.push(capture);
            out.set(capture.mediaId, group);
        }

        return [...out.entries()];
    }, [items]);

    const pages = data ? Math.ceil(data.total / Math.max(1, data.pageSize)) : 0;
    const total = data?.total ?? 0;

    const toggle = (capture: Capture) =>
        setSelected((current) => {
            const next = new Map(current);

            if (next.has(capture.artifactId)) next.delete(capture.artifactId);
            else next.set(capture.artifactId, capture);

            return next;
        });

    const runDiscard = (ids: string[], onDone?: () => void) =>
        discard.mutate(ids, {
            onSuccess: (result) => {
                setSelected((current) => {
                    const next = new Map(current);

                    for (const id of ids) next.delete(id);

                    return next;
                });

                const failed = result.failed.length;

                setDone(
                    `Discarded ${result.succeeded}` +
                        (failed > 0 ? `; ${failed} could not be (${result.failed[0].reason})` : "")
                );
                onDone?.();
            },
        });

    /**
     * `auto-fill` with a floor, so the wall reflows from five across to one on a phone without
     * a breakpoint deciding it. 200px because these are the 640px renderings: there is detail
     * to spare, and a still is worth a little more room than a clip's sprite tile.
     */
    const wall = (captures: Capture[], showSource: boolean) => (
        <Box
            style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(min(200px, 100%), 1fr))",
                gap: "var(--mantine-spacing-xs)",
            }}
        >
            {captures.map((capture) => (
                <CaptureCard
                    key={capture.artifactId}
                    capture={capture}
                    selected={selected.has(capture.artifactId)}
                    onToggle={() => toggle(capture)}
                    onOpen={() => setOpenId(capture.artifactId)}
                    showSource={showSource}
                />
            ))}
        </Box>
    );

    const chosen = [...selected.values()];

    return (
        <Stack gap="md">
            {/* The letterhead every page wears, at the one size every page uses (§14). */}
            <PagePlate
                eyebrow={
                    data
                        ? `${total.toLocaleString()} ${total === 1 ? "still" : "stills"}`
                        : "Your stills"
                }
                title="Captures"
                lede={
                    <>
                        Stills you have grabbed. Press <kbd>s</kbd> while watching.
                    </>
                }
            />

            {/* See `/clips` for why this is one sticky bar of constant height. */}
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
                            value={view.sort}
                            onChange={(value) =>
                                apply({
                                    sort: (value as CaptureSort) ?? "created",
                                    direction: null,
                                    page: 0,
                                })
                            }
                            allowDeselect={false}
                            size="sm"
                            w={{ base: "100%", xs: 180 }}
                            aria-label="Sort"
                        />
                        <SearchInput
                            placeholder="Search captions and titles"
                            value={search}
                            onChange={setSearch}
                            size="sm"
                            w={{ base: "100%", xs: 220 }}
                            aria-label="Search captions and video titles"
                        />
                        {/* The two layouts, shown as the two of them, as on `/clips`. */}
                        <SegmentedControl
                            value={view.flat ? "flat" : "grouped"}
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
                        {/* Ticking takes the page; unticking drops everything, as on `/clips`. */}
                        <Checkbox
                            checked={allSelected}
                            indeterminate={!allSelected && pageTouched}
                            disabled={items.length === 0}
                            onChange={() =>
                                setSelected((current) => {
                                    if (pageTouched) return new Map();

                                    const next = new Map(current);

                                    for (const capture of items) {
                                        next.set(capture.artifactId, capture);
                                    }

                                    return next;
                                })
                            }
                            aria-label={
                                pageTouched
                                    ? "Clear the selection"
                                    : "Select everything on this page"
                            }
                        />

                        <Text
                            size="sm"
                            w={150}
                            lineClamp={1}
                            fw={selected.size > 0 ? 600 : undefined}
                            c={selected.size > 0 ? undefined : done ? "brass" : "dimmed"}
                            title={selected.size === 0 && done ? done : undefined}
                        >
                            {selected.size > 0
                                ? `${selected.size} selected`
                                : done
                                  ? done
                                  : !data
                                    ? ""
                                    : total === 0
                                      ? "No captures"
                                      : `${total} capture${total === 1 ? "" : "s"}`}
                        </Text>

                        {/* "Discard" rather than "Delete", as on the strip: nothing goes to the
                            trash and there is nothing to restore it from. */}
                        <Button
                            size="sm"
                            color="oxblood"
                            disabled={selected.size === 0}
                            loading={discard.isPending}
                            onClick={() => setConfirming(true)}
                        >
                            Discard…
                        </Button>
                    </Group>
                </Group>
            </Paper>

            {isLoading && <PageLoader />}

            {error && (
                <LoadFailed error={error} what="your captures" onRetry={() => void refetch()} />
            )}

            {data && items.length === 0 && (
                <EmptyState title={view.search ? "Nothing matches that" : "No captures yet"}>
                    {view.search
                        ? "Try another caption or title, or clear the search."
                        : "Pause a video and press s, or the camera button in the player."}
                </EmptyState>
            )}

            {!view.flat
                ? groups.map(([mediaId, group]) => (
                      <Stack key={mediaId} gap={6}>
                          <Anchor
                              component={Link}
                              href={`/media/${mediaId}`}
                              prefetch={false}
                              onClick={rememberReturn}
                              size="xs"
                              c="dimmed"
                              fw={600}
                          >
                              {group.title} · {group.captures.length}
                          </Anchor>
                          {wall(group.captures, false)}
                      </Stack>
                  ))
                : wall(items, true)}

            {pages > 1 && (
                <Group justify="center">
                    <Pagination
                        value={view.page + 1}
                        onChange={(value) => apply({ page: value - 1 })}
                        total={pages}
                        color="brass"
                    />
                </Group>
            )}

            {/*
             * A confirmation, which the strip's single discard does not ask for: that one is a
             * deliberate press on a picture you are looking at, and this is dozens gathered
             * across pages. Pictures rather than a count, because "Discard 23 captures?" does
             * not tell anybody which 23.
             */}
            <Modal
                opened={confirming}
                onClose={() => setConfirming(false)}
                title={`Discard ${selected.size} capture${selected.size === 1 ? "" : "s"}?`}
                centered
            >
                <Stack gap="md">
                    <SimpleGrid cols={{ base: 3, sm: 4 }} spacing={6}>
                        {chosen.slice(0, CONFIRM_PREVIEW).map((capture) => (
                            <Image
                                key={capture.artifactId}
                                src={capture.url}
                                alt={capture.label ?? `Capture from ${capture.mediaTitle}`}
                                radius="xs"
                                style={{ aspectRatio: "16 / 9", objectFit: "cover" }}
                            />
                        ))}
                    </SimpleGrid>
                    {chosen.length > CONFIRM_PREVIEW && (
                        <Text size="xs" c="dimmed">
                            and {chosen.length - CONFIRM_PREVIEW} more
                        </Text>
                    )}
                    <Text size="sm">
                        Nothing goes to the trash: they cannot be restored. An item using one as its
                        cover goes back to the generated cover.
                    </Text>
                    <Group justify="flex-end" gap="sm">
                        <Button variant="default" onClick={() => setConfirming(false)}>
                            Keep them
                        </Button>
                        <Button
                            color="oxblood"
                            loading={discard.isPending}
                            onClick={() =>
                                runDiscard([...selected.keys()], () => setConfirming(false))
                            }
                        >
                            Discard
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <FrameLightbox
                // The arrows walk the page on screen, in the order it is shown.
                frames={!view.flat ? groups.flatMap(([, group]) => group.captures) : items}
                openId={openId}
                onClose={() => setOpenId(null)}
                onOpenId={setOpenId}
                onDelete={(artifactId) => runDiscard([artifactId], () => setOpenId(null))}
                // Only asked of a frame with a position, so `at` is always a moment.
                seekHref={(frame) =>
                    `/media/${byId.get(frame.artifactId)?.mediaId}?at=${frame.atMs}`
                }
                onRename={(artifactId, label) => {
                    const capture = byId.get(artifactId);

                    if (capture) {
                        rename.mutate({ mediaId: capture.mediaId, artifactId, label });
                    }
                }}
                busy={discard.isPending}
            />
        </Stack>
    );
};
