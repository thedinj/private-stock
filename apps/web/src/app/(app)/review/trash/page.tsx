"use client";

import { Suspense, useEffect, useState } from "react";
import Image from "next/image";
import {
    Alert,
    Anchor,
    Badge,
    Button,
    Card,
    Group,
    Modal,
    Pagination,
    SegmentedControl,
    Stack,
    Text,
    Tooltip,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
    EmptyTrashResponse,
    TrashEntry,
    TrashListResponse,
    TrashSettings,
} from "@private-stock/core";

import { RulesDrawer } from "@/components/admin/RulesDrawer";
import { TrashRulesForm } from "@/components/admin/TrashRulesForm";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { invalidateListable } from "@/lib/api/trash";
import { LoadFailed } from "@/components/LoadFailed";
import { EmptyState } from "@/components/shell/EmptyState";
import { PageLoader } from "@/components/shell/PageLoader";
import { PagePlate } from "@/components/shell/PagePlate";
import { UnreadableSheet } from "@/components/unreadable/UnreadableSheet";
import { defineView, enumField, flagField, pageField, useUrlView } from "@/lib/urlView";

/**
 * The recycle bin (§10).
 *
 * Admin only, and deliberately plain. Every row here is a file someone decided to remove, so
 * the screen's job is to make two things obvious: how long is left before it goes for good,
 * and which button is the irreversible one.
 */

const PAGE_SIZE = 50;

/**
 * The page, the filter and the rules drawer, all in the address -- so the unreadable-files page
 * can link straight to its half of the bin, and the empty state straight to the rules.
 *
 * **Unreadable only** is the bin narrowed to files the probe could not read, largest first with
 * ticks, which is how that list is worked through (§10g). It used to be a tab on the unreadable
 * page: a second copy of the trash, reached from somewhere else.
 */
const trashView = defineView("/review/trash", {
    filter: enumField("filter", ["all", "unreadable"], "all"),
    page: pageField(),
    rules: flagField("rules"),
});

const formatBytes = (bytes: number): string => {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

/**
 * How long is left, in words.
 *
 * Phrased as a deadline rather than a date because that is the decision being made — whether
 * to act now — and "in 2 days" needs no arithmetic from the reader.
 */
const timeLeft = (purgeAfter: string): { label: string; urgent: boolean } => {
    // SQLite stores UTC without a zone marker, so it has to be said explicitly or the browser
    // reads it as local time and the countdown is wrong by the offset.
    const deadline = new Date(`${purgeAfter.replace(" ", "T")}Z`).getTime();
    const hours = Math.round((deadline - Date.now()) / 3_600_000);

    if (hours <= 0) return { label: "due for purge", urgent: true };
    if (hours < 24) return { label: `${hours}h left`, urgent: true };

    return { label: `${Math.round(hours / 24)}d left`, urgent: false };
};

interface TrashResponse extends TrashListResponse {
    settings: TrashSettings;
}

const TrashRow: React.FC<{
    entry: TrashEntry;
    onRestore: () => void;
    onPurge: () => void;
    busy: boolean;
}> = ({ entry, onRestore, onPurge, busy }) => {
    const remaining = timeLeft(entry.purgeAfter);

    return (
        <Card withBorder p="sm">
            <Group justify="space-between" wrap="wrap" gap="sm">
                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                    {entry.coverUrl ? (
                        <Image
                            src={entry.coverUrl}
                            alt=""
                            width={64}
                            height={40}
                            unoptimized
                            style={{ objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
                        />
                    ) : (
                        <div
                            style={{
                                width: 64,
                                height: 40,
                                borderRadius: 4,
                                flexShrink: 0,
                                background: "var(--ps-well)",
                            }}
                        />
                    )}

                    <Stack gap={2} style={{ minWidth: 0 }}>
                        <Text fw={600} truncate>
                            {entry.title ?? entry.relPath}
                        </Text>
                        <Text size="xs" c="dimmed" truncate>
                            {entry.rootLabel} · {entry.relPath}
                        </Text>
                        <Text size="xs" c="dimmed">
                            {formatBytes(entry.bytes)} · deleted by {entry.deletedBy}
                        </Text>
                    </Stack>
                </Group>

                <Group gap="xs" wrap="nowrap">
                    {entry.pending && (
                        <Tooltip label="The file is still being moved into the trash">
                            <Badge color="brass" variant="light">
                                Moving
                            </Badge>
                        </Tooltip>
                    )}

                    {/* The palette's own warning colours: oxblood for a clock that is nearly
                        out, oak for one that is not. Mantine's red and grey were the only
                        off-palette hues in the app. */}
                    <Badge color={remaining.urgent ? "oxblood" : "oak"} variant="light">
                        {remaining.label}
                    </Badge>

                    {/* Ordinary buttons: the coarse-pointer rule in globals.scss is what gives
                        them a thumb's height on a phone, rather than a 44px minimum forced onto
                        a desktop too. */}
                    <Button
                        size="sm"
                        variant="light"
                        color="brass"
                        onClick={onRestore}
                        disabled={busy}
                    >
                        Restore
                    </Button>

                    <Button
                        size="sm"
                        color="oxblood"
                        variant="subtle"
                        onClick={onPurge}
                        disabled={busy}
                    >
                        Delete forever…
                    </Button>
                </Group>
            </Group>
        </Card>
    );
};

const TrashQueue: React.FC = () => {
    const queryClient = useQueryClient();
    const [view, apply] = useUrlView(trashView);
    const openRules = () => apply({ rules: true });
    const [confirming, setConfirming] = useState<TrashEntry | null>(null);

    // Paged rather than the first fifty and nothing after: a cleared-out folder fills the bin
    // with hundreds of rows in one stroke.
    const { data, isLoading, error, refetch } = useQuery({
        queryKey: queryKeys.trashPage(view.page),
        queryFn: () =>
            api<TrashResponse>(`/api/trash?limit=${PAGE_SIZE}&offset=${view.page * PAGE_SIZE}`),
    });

    // The item returns to, or finally leaves, the library.
    const invalidate = () => invalidateListable(queryClient);

    const restore = useMutation({
        mutationFn: (id: string) => api(`/api/trash/${id}/restore`, { method: "POST" }),
        onSuccess: invalidate,
    });

    const purge = useMutation({
        mutationFn: (id: string) => api(`/api/trash/${id}`, { method: "DELETE" }),
        onSuccess: () => {
            setConfirming(null);
            invalidate();
        },
    });

    /**
     * Everything in the bin, for good, now (§10).
     *
     * One confirmation for the lot, stating the count, the space and that nothing comes back --
     * the same weight as deleting one item forever, because it is that decision taken for every
     * item at once. What it reports afterwards is what was queued: purges are jobs, and an
     * entry still being moved in is left for a later empty rather than orphaning its file.
     */
    const [emptying, setEmptying] = useState(false);
    const empty = useMutation({
        mutationFn: () => api<EmptyTrashResponse>("/api/trash", { method: "DELETE" }),
        onSuccess: () => {
            setEmptying(false);
            invalidate();
        },
    });

    const entries = data?.entries ?? [];
    const total = data?.total ?? 0;
    const pages = Math.ceil(total / PAGE_SIZE);

    // Restoring or purging the last rows of the last page leaves it empty; step back a page
    // rather than calling a bin with things still in it empty.
    useEffect(() => {
        if (data && pages > 0 && view.page >= pages) {
            apply({ page: pages - 1 });
        }
    }, [data, pages, view.page, apply]);
    const retention = data?.settings.retentionDays ?? 7;

    /**
     * The plate, whatever state the list is in -- so the page does not blink its heading in
     * once the data lands (§14, "house rules"). Its eyebrow is the bin's state; there is no back
     * link, because a page the navigation reaches directly has nowhere to go back to.
     */
    const plate = (
        <PagePlate
            eyebrow={
                !data
                    ? "Held, not yet gone"
                    : total === 0
                      ? "Nothing held"
                      : `${total.toLocaleString()} ${total === 1 ? "item" : "items"} held`
            }
            title="Trash"
            lede={
                data && total > 0
                    ? `${formatBytes(data.heldBytes ?? 0)} on the data volume, waiting to be purged or restored.`
                    : undefined
            }
            actions={
                <>
                    {total > 0 && (
                        <Button
                            color="oxblood"
                            variant="light"
                            onClick={() => {
                                empty.reset();
                                setEmptying(true);
                            }}
                        >
                            Empty trash…
                        </Button>
                    )}
                    <RulesDrawer
                        title="Trash rules"
                        opened={view.rules}
                        onOpen={openRules}
                        onClose={() => apply({ rules: false })}
                    >
                        <TrashRulesForm />
                    </RulesDrawer>
                </>
            }
        />
    );

    if (isLoading) {
        return (
            <Stack gap="lg">
                {plate}
                <PageLoader />
            </Stack>
        );
    }

    if (error) {
        return (
            <Stack gap="lg">
                {plate}
                <LoadFailed error={error} what="the trash" onRetry={() => void refetch()} />
            </Stack>
        );
    }

    return (
        <Stack gap="lg">
            {plate}

            <SegmentedControl
                value={view.filter}
                onChange={(value) =>
                    apply({
                        filter: trashView.parse(new URLSearchParams({ filter: value })).filter,
                        page: 0,
                    })
                }
                data={[
                    { value: "all", label: "Everything" },
                    { value: "unreadable", label: "Unreadable only" },
                ]}
                color="brass"
                size="xs"
                w="fit-content"
            />

            {/* What the last empty started. Purges run as jobs, so the list catches up as
                they land; an entry still moving in was left, and saying so is what makes
                "empty" not look broken when a few rows remain. */}
            {empty.data && (
                <Alert
                    color="brass"
                    variant="light"
                    withCloseButton
                    onClose={() => empty.reset()}
                    title={`${empty.data.queued.toLocaleString()} ${empty.data.queued === 1 ? "item is" : "items are"} being deleted for good`}
                >
                    {empty.data.freedBytes > 0 &&
                        `${formatBytes(empty.data.freedBytes)} goes back to the data volume as the purges run. `}
                    {empty.data.waiting > 0 &&
                        `${empty.data.waiting.toLocaleString()} ${empty.data.waiting === 1 ? "is" : "are"} still being moved into the trash and ${empty.data.waiting === 1 ? "was" : "were"} left; empty again once ${empty.data.waiting === 1 ? "it lands" : "they land"}.`}
                </Alert>
            )}

            {/* The retention window, said once.

                This page used to state it four times before you reached the list — in the
                header, again under it, and again inside the empty state, in three different
                alignments. It is one fact, and it belongs wherever you are actually looking:
                in the empty state when there is nothing here, and above the list when there
                is something whose clock is running. */}
            {view.filter === "unreadable" ? (
                <UnreadableSheet tab="trash" />
            ) : entries.length === 0 ? (
                <EmptyState title="The trash is empty">
                    Deleted items are kept for {retention} day
                    {retention === 1 ? "" : "s"}, then purged. Change that in the{" "}
                    <Anchor component="button" onClick={openRules}>
                        rules
                    </Anchor>
                    .
                </EmptyState>
            ) : (
                <Stack gap="xs">
                    {/* Said here, because the setting reads as if it controls the whole bin. */}
                    <Text size="xs" c="dimmed">
                        Kept for {retention} day{retention === 1 ? "" : "s"} from deletion — see the{" "}
                        <Anchor component="button" size="xs" onClick={openRules}>
                            rules
                        </Anchor>
                        .
                    </Text>

                    {entries.map((entry) => (
                        <TrashRow
                            key={entry.id}
                            entry={entry}
                            busy={restore.isPending || purge.isPending}
                            onRestore={() => restore.mutate(entry.id)}
                            onPurge={() => setConfirming(entry)}
                        />
                    ))}

                    {pages > 1 && (
                        <Pagination
                            total={pages}
                            value={view.page + 1}
                            onChange={(page) => apply({ page: page - 1 })}
                            color="brass"
                            mt="sm"
                        />
                    )}
                </Stack>
            )}

            {/*
             * A confirmation, because this is the one action in the app that cannot be
             * undone. Restore has no dialog on purpose: it is reversible, and a prompt in
             * front of a safe action teaches people to dismiss prompts.
             */}
            <Modal
                opened={confirming !== null}
                onClose={() => setConfirming(null)}
                title="Delete forever?"
                centered
            >
                <Stack gap="md">
                    <Text size="sm">
                        {confirming?.title ?? confirming?.relPath} will be removed from disk along
                        with everything recorded about it — tags, rating and history. This cannot be
                        undone.
                    </Text>

                    <Group justify="flex-end">
                        <Button variant="default" onClick={() => setConfirming(null)}>
                            Cancel
                        </Button>
                        <Button
                            color="oxblood"
                            loading={purge.isPending}
                            onClick={() => confirming && purge.mutate(confirming.id)}
                        >
                            Delete forever
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal
                opened={emptying}
                onClose={() => setEmptying(false)}
                title="Empty the trash?"
                centered
            >
                <Stack gap="md">
                    <Text size="sm">
                        {total === 1
                            ? "The item in the trash will be removed from disk, with everything recorded about it"
                            : `All ${total.toLocaleString()} items in the trash will be removed from disk, with everything recorded about them`}{" "}
                        — tags, ratings, notes, clips and history.
                        {data && data.heldBytes > 0
                            ? ` ${formatBytes(data.heldBytes)} goes back to the data volume.`
                            : ""}
                    </Text>
                    <Text size="sm" fw={600}>
                        Nothing can be restored afterwards.
                    </Text>

                    {empty.error && (
                        <Text size="sm" c="red">
                            {empty.error.message}
                        </Text>
                    )}

                    {/* Cancel has the focus: a reflexive Enter must not be what empties it. */}
                    <Group justify="flex-end">
                        <Button variant="default" onClick={() => setEmptying(false)} data-autofocus>
                            Cancel
                        </Button>
                        <Button
                            color="oxblood"
                            loading={empty.isPending}
                            onClick={() => empty.mutate()}
                        >
                            Delete {total.toLocaleString()} forever
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Stack>
    );
};

/** `useUrlView` reads the search parameters, which Next requires to sit under a boundary. */
const TrashPage: React.FC = () => (
    <Suspense>
        <TrashQueue />
    </Suspense>
);

export default TrashPage;
