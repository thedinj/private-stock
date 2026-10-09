"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ActionIcon, Anchor, Button, Group, Menu, Modal, Paper, Stack, Text } from "@mantine/core";

import { LoadFailed } from "@/components/LoadFailed";
import { ReelPlayer } from "@/components/reel/ReelPlayer";
import { EmptyState } from "@/components/shell/EmptyState";
import { PageLoader } from "@/components/shell/PageLoader";
import { PagePlate } from "@/components/shell/PagePlate";
import { ClipThumb } from "@/components/media/ClipThumb";
import {
    useDeleteReel,
    useMoveReelItem,
    useReel,
    useReelItems,
    useRemoveReelItem,
    useUpdateReel,
} from "@/lib/api/reels";
import { ArrowDownGlyph, ArrowUpGlyph, CloseGlyph, MoreGlyph } from "@/components/media/Glyph";
import { useRememberedHref } from "@/lib/rememberedPages";

/**
 * One reel: watching it, and arranging it (§14d).
 *
 * **Its own page, not a position in a set.** The viewer at `/media/:id` is a page about one
 * item — its title, rating, tags, note, captures — and a span has none of those; `/media/:id`
 * cannot express "the 00:12–00:31 of this" either, and `useViewerSequence` is built on finding a
 * media id in a page of ids, which is ambiguous the moment a reel holds one item twice. So a reel
 * is something you press play on and watch to the end, and the set machinery is left alone.
 *
 * Arranging is a **list rather than a grid**, and each row carries a drag handle *and* a pair of
 * arrows. Ordering is the task, and a grid asks you to reason about a sequence in two dimensions;
 * the arrows are there because HTML drag events do not fire for touch, so a drag-only version
 * would make arranging a reel impossible on a phone (§14b).
 */

const formatRun = (ms: number): string => {
    const total = Math.round(ms / 1000);
    const minutes = Math.floor(total / 60);

    return `${minutes}:${String(total % 60).padStart(2, "0")}`;
};

const ReelPage: React.FC<{ params: Promise<{ id: string }> }> = ({ params }) => {
    const { id } = use(params);
    const router = useRouter();

    const [arranging, setArranging] = useState(false);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [dragging, setDragging] = useState<string | null>(null);

    const reel = useReel(id);
    const items = useReelItems(id);
    const update = useUpdateReel();
    const remove = useRemoveReelItem();
    const move = useMoveReelItem();
    /**
     * Back to the index rather than into the grid: a reel is not a position in a set. To the
     * index as it was left (§14b), not its plain address -- the filter and page you opened this
     * reel from.
     */
    const reelsHref = useRememberedHref("/reels");
    const destroy = useDeleteReel(() => router.push(reelsHref));
    const back = { href: reelsHref, label: "Reels" };

    // The plate stays up while the reel is on its way or has failed (§14, "house rules").
    if (reel.isLoading || items.isLoading) {
        return (
            <Stack gap="lg">
                <PagePlate eyebrow="Reel" title="…" back={back} />
                <PageLoader />
            </Stack>
        );
    }

    if (!reel.data || !items.data) {
        return (
            <Stack gap="lg">
                <PagePlate eyebrow="Reel" title="This reel" back={back} />
                <LoadFailed
                    error={reel.error ?? items.error}
                    what="this reel"
                    onRetry={() => {
                        void reel.refetch();
                        void items.refetch();
                    }}
                />
            </Stack>
        );
    }

    const entries = items.data.items;
    const editable = reel.data.editable;

    return (
        <Stack gap="md">
            {/*
             * The plate every page wears (§14, "house rules"). Its state is
             * the eyebrow -- how many clips, how long it runs, whether it is shared, and whose it
             * is when it is not yours -- and the reel's own actions sit where every page keeps
             * them. No Play: the player is the page.
             */}
            <PagePlate
                eyebrow={[
                    `${reel.data.itemCount} clip${reel.data.itemCount === 1 ? "" : "s"}`,
                    formatRun(reel.data.runningMs),
                    reel.data.visibility === "shared" ? "Shared" : null,
                    editable ? null : reel.data.ownerName,
                ]
                    .filter(Boolean)
                    .join(" · ")}
                title={reel.data.name}
                back={back}
                actions={
                    editable ? (
                        <Group gap="xs" wrap="nowrap">
                            {/* The same control the playlist page uses for the same job. */}
                            <Button
                                variant={arranging ? "light" : "default"}
                                color={arranging ? "brass" : undefined}
                                onClick={() => setArranging((on) => !on)}
                            >
                                {arranging ? "Done arranging" : "Arrange"}
                            </Button>

                            <Menu position="bottom-end" withinPortal>
                                <Menu.Target>
                                    <Button variant="subtle" color="gray" aria-label="Reel actions">
                                        <MoreGlyph size={18} />
                                    </Button>
                                </Menu.Target>
                                <Menu.Dropdown>
                                    {/* Sharing is an administrator's; unsharing is not. The
                                        service is where the rule is true (§14c). */}
                                    <Menu.Item
                                        onClick={() =>
                                            update.mutate({
                                                id,
                                                patch: {
                                                    visibility:
                                                        reel.data.visibility === "shared"
                                                            ? "private"
                                                            : "shared",
                                                },
                                            })
                                        }
                                    >
                                        {reel.data.visibility === "shared"
                                            ? "Make private"
                                            : "Share with everyone"}
                                    </Menu.Item>
                                    <Menu.Divider />
                                    <Menu.Item
                                        color="oxblood"
                                        onClick={() => setConfirmingDelete(true)}
                                    >
                                        Delete reel…
                                    </Menu.Item>
                                </Menu.Dropdown>
                            </Menu>
                        </Group>
                    ) : undefined
                }
            />

            {entries.length === 0 ? (
                <EmptyState title="Nothing in this reel yet">
                    Gather spans from{" "}
                    <Anchor component={Link} href="/clips">
                        Clips
                    </Anchor>
                    : tick the ones you want and choose Add to reel.
                </EmptyState>
            ) : (
                !arranging && <ReelPlayer entries={entries} runningMs={items.data.runningMs} />
            )}

            {arranging && (
                <Stack gap={4}>
                    {entries.map((entry, index) => (
                        <Paper
                            key={entry.id}
                            withBorder
                            p="xs"
                            radius="sm"
                            draggable
                            onDragStart={() => setDragging(entry.id)}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={() => {
                                if (dragging && dragging !== entry.id) {
                                    move.mutate({ id, itemId: dragging, toIndex: index });
                                }

                                setDragging(null);
                            }}
                        >
                            <Group gap="sm" wrap="nowrap">
                                <Text c="dimmed" size="sm" w={24} ta="right">
                                    {index + 1}
                                </Text>
                                <ClipThumb
                                    clip={entry.clip}
                                    width={96}
                                    fallbackUrl={entry.media.coverUrl}
                                />
                                <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                                    <Text size="sm" fw={600} lineClamp={1}>
                                        {entry.clip.label ?? entry.media.title}
                                    </Text>
                                    <Text size="xs" c="dimmed" lineClamp={1}>
                                        {entry.media.title} · {formatRun(entry.clip.runMs)}
                                        {entry.clip.speed !== null && ` · ${entry.clip.speed}×`}
                                    </Text>
                                </Stack>

                                {/* The pair, deliberately: drag is the natural gesture and is
                                    unavailable to anyone on a phone. */}
                                <ActionIcon
                                    variant="subtle"
                                    size="sm"
                                    aria-label="Move up"
                                    disabled={index === 0}
                                    onClick={() =>
                                        move.mutate({ id, itemId: entry.id, toIndex: index - 1 })
                                    }
                                >
                                    <ArrowUpGlyph size={16} />
                                </ActionIcon>
                                <ActionIcon
                                    variant="subtle"
                                    size="sm"
                                    aria-label="Move down"
                                    disabled={index === entries.length - 1}
                                    onClick={() =>
                                        move.mutate({ id, itemId: entry.id, toIndex: index + 1 })
                                    }
                                >
                                    <ArrowDownGlyph size={16} />
                                </ActionIcon>
                                <ActionIcon
                                    variant="subtle"
                                    color="oxblood"
                                    size="sm"
                                    aria-label="Remove from reel"
                                    onClick={() => remove.mutate({ id, itemId: entry.id })}
                                >
                                    <CloseGlyph size={14} />
                                </ActionIcon>
                            </Group>
                        </Paper>
                    ))}
                </Stack>
            )}

            {/* Deleting a reel asks first, as deleting a playlist does: it was one click on a
                small red word, with nothing to bring it back. The clips are not touched. */}
            <Modal
                opened={confirmingDelete}
                onClose={() => setConfirmingDelete(false)}
                title="Delete this reel?"
                centered
            >
                <Stack gap="md">
                    <Text size="sm">
                        The reel and its order are deleted. The clips it was made from stay in
                        Clips, ready for another.
                    </Text>
                    <Group justify="flex-end" gap="sm">
                        <Button variant="default" onClick={() => setConfirmingDelete(false)}>
                            Keep it
                        </Button>
                        <Button
                            color="oxblood"
                            loading={destroy.isPending}
                            onClick={() => destroy.mutate(id)}
                        >
                            Delete reel
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Stack>
    );
};

export default ReelPage;
