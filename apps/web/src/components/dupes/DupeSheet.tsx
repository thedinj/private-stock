"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Alert, Button, Center, Group, Pagination, Paper, Stack, Text } from "@mantine/core";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
    DupeGroup,
    DupeResolveInput,
    DupeResolveResponse,
    DupeReviewInput,
} from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { invalidateListable } from "@/lib/api/trash";
import {
    defaultKeep,
    formatBytes,
    removable,
    tickedByDefault,
    toResolveItem,
} from "@/lib/dupeTriage";
import { isTypingTarget } from "@/lib/typingTarget";
import { DupeResolveDialog, type Decision } from "@/components/dupes/DupeResolveDialog";
import { DupeRow } from "@/components/dupes/DupeRow";
import { LoadFailed } from "@/components/LoadFailed";
import { EmptyState } from "@/components/shell/EmptyState";
import { PageLoader } from "@/components/shell/PageLoader";

import barClasses from "@/components/library/SelectionBar.module.scss";

/**
 * A triage sheet of duplicate groups (§10c).
 *
 * The queue runs to hundreds of groups, and nearly all of them are decided by a glance at the
 * pictures and the resolution. So the sheet is built for the glance: a page of compact rows,
 * the recommended copy already chosen, every row that a glance could get wrong left unticked,
 * and one button that trashes the rest of the page. The old screen asked for one confirmation
 * per group; this one asks for one per page.
 *
 * **It still takes a side (§10c).** Each row is ordered best first, says why its keeper won, and
 * marks what each other copy would cost. Pressing a copy makes it the keeper instead, and the
 * row then says the choice is the reviewer's, not the app's.
 *
 * **Judging stays separate from deleting.** Marking a group reviewed touches no file; trashing
 * has its own confirmation, which calls out every override and every row ticked past a
 * caution; and the files land in the bin under the ordinary retention window (§18.1) --
 * except an identical copy, which is deleted outright, its bytes being the keeper's (§10e).
 *
 * One component for every tab that shows groups to decide — pending look-alikes, the identical
 * groups the rule leaves for a person (§10e), and the reviewed ones — told only where its rows
 * come from. Mounted one at a time, because its keys are bound to the window.
 */

/** Fixed: the picker was there to get through identical groups faster, which §10e now does. */
const PAGE_SIZE = 50;

/** A finished resolve, held on the sheet so the report outlives the rows it was about. */
interface Outcome {
    response: DupeResolveResponse;
    /** Titles captured before the deletion, because failures are named rather than counted. */
    titles: Record<string, string>;
}

const plural = (count: number, one: string, many: string): string =>
    `${count.toLocaleString()} ${count === 1 ? one : many}`;

interface DupeSheetProps {
    /** The endpoint serving `{ groups, total }` pages. */
    endpoint: string;
    /** What narrows it, besides the page. */
    params: Record<string, string>;
    /** The cache key for one page, from the `queryKeys` factory. */
    keyFor: (params: string) => readonly unknown[];
    canDelete: boolean;
    emptyTitle: string;
    emptyText: string;
    /**
     * One-based, and owned by the page so it lives in the address (§14b): opening an item and
     * coming back returns to the page of rows you were working through, not the first.
     */
    page: number;
    onPage: (page: number) => void;
}

export const DupeSheet: React.FC<DupeSheetProps> = ({
    endpoint,
    params: baseParams,
    keyFor,
    canDelete,
    emptyTitle,
    emptyText,
    page,
    onPage,
}) => {
    const queryClient = useQueryClient();

    /**
     * The reviewer's departures from the defaults, per group.
     *
     * Only what they changed is stored; everything else is derived from the group, so a row
     * whose keeper they move re-derives whether it should be ticked — unless they have ticked
     * or unticked it themselves, which then stands.
     */
    const [keeps, setKeeps] = useState<Record<string, string>>({});
    const [ticks, setTicks] = useState<Record<string, boolean>>({});

    const [focused, setFocused] = useState(0);
    const [confirming, setConfirming] = useState<Decision[] | null>(null);
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    /** Groups just resolved, hidden until the refetch that drops them lands. */
    const [settled, setSettled] = useState<Set<string>>(new Set());
    const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

    const params = new URLSearchParams({
        ...baseParams,
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
    });

    const { data, isLoading, error, refetch } = useQuery({
        queryKey: keyFor(params.toString()),
        queryFn: () => api<{ groups: DupeGroup[]; total: number }>(`${endpoint}?${params}`),
        // The rows stay put while the next page or a post-resolve refresh loads, rather than
        // the sheet blanking to a spinner under the reviewer's pointer.
        placeholderData: keepPreviousData,
    });

    /** A different set of rows: every per-row choice belonged to the old one. */
    const startOver = (): void => {
        setKeeps({});
        setTicks({});
        setFocused(0);
        setSettled(new Set());
    };

    const review = useMutation({
        mutationFn: (input: DupeReviewInput) =>
            api("/api/dupes/review", { method: "POST", body: JSON.stringify(input) }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.dupes.all() }),
    });

    const resolve = useMutation({
        mutationFn: (decisions: Decision[]) => {
            const input: DupeResolveInput = {
                items: decisions.flatMap(({ group, keepId }) => {
                    const item = toResolveItem(group, keepId);

                    return item ? [item] : [];
                }),
            };

            return api<DupeResolveResponse>("/api/dupes/resolve", {
                method: "POST",
                body: JSON.stringify(input),
            });
        },
        onSuccess: (response, decisions) => {
            setConfirming(null);

            /**
             * Reported on the sheet rather than in the dialogue, because the resolved rows leave
             * as soon as the caches refresh. The partial outcome is exactly the one worth
             * reading.
             */
            setOutcome({
                response,
                titles: Object.fromEntries(
                    decisions.flatMap(({ group }) =>
                        group.members.map((member) => [member.id, member.title])
                    )
                ),
            });
            setKeeps({});
            setTicks({});
            setSettled(
                new Set(
                    response.groups.filter((group) => group.reviewed).map((group) => group.groupId)
                )
            );

            // The library lost items and the bin gained them; see docs/CACHE_KEYS.md.
            void queryClient.invalidateQueries({ queryKey: queryKeys.dupes.all() });
            invalidateListable(queryClient);
        },
    });

    const groups = (data?.groups ?? []).filter((group) => !settled.has(group.id));
    const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

    const keepFor = (group: DupeGroup): string => keeps[group.id] ?? defaultKeep(group);
    const tickedFor = (group: DupeGroup): boolean =>
        canDelete &&
        removable(group, keepFor(group)).length > 0 &&
        (ticks[group.id] ?? tickedByDefault(group, keepFor(group)));

    const ticked = groups.filter(tickedFor);
    const tickable = groups.filter((group) => removable(group, keepFor(group)).length > 0);
    const unticked = groups.filter((group) => !group.reviewed && !tickedFor(group));
    const going = ticked.flatMap((group) => removable(group, keepFor(group)));
    const freed = going.reduce((total, member) => total + (member.sizeBytes ?? 0), 0);

    const chooseKeep = (group: DupeGroup, memberId: string): void =>
        setKeeps((current) => ({ ...current, [group.id]: memberId }));
    const setTick = (group: DupeGroup, value: boolean): void =>
        setTicks((current) => ({ ...current, [group.id]: value }));
    const tickAll = (value: boolean): void =>
        setTicks(Object.fromEntries(tickable.map((group) => [group.id, value])));

    const openConfirm = (): void => {
        if (ticked.length === 0) return;

        // A previous page's report would otherwise sit above a confirmation about this one.
        setOutcome(null);
        resolve.reset();
        setConfirming(ticked.map((group) => ({ group, keepId: keepFor(group) })));
    };

    const moveFocus = (next: number): void => {
        const index = Math.min(Math.max(next, 0), groups.length - 1);

        setFocused(index);
        rowRefs.current[index]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };

    /**
     * The sheet from the keyboard: `j`/`k` between rows, a digit to choose the keeper, `x` to
     * tick, Shift+Enter to confirm. Read through a ref so the listener is attached once and
     * still sees this render's rows.
     */
    const onKeyRef = useRef<(event: KeyboardEvent) => void>(() => undefined);

    onKeyRef.current = (event: KeyboardEvent) => {
        if (
            confirming !== null ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            isTypingTarget(event.target) ||
            groups.length === 0
        ) {
            return;
        }

        const row = groups[Math.min(focused, groups.length - 1)];

        if (event.key === "j") {
            moveFocus(focused + 1);
        } else if (event.key === "k") {
            moveFocus(focused - 1);
        } else if (canDelete && row && /^[1-9]$/.test(event.key)) {
            const member = row.members[Number(event.key) - 1];

            if (member) chooseKeep(row, member.id);
        } else if (canDelete && row && event.key === "x") {
            if (removable(row, keepFor(row)).length > 0) setTick(row, !tickedFor(row));
        } else if (canDelete && event.key === "Enter" && event.shiftKey) {
            openConfirm();
        } else {
            return;
        }

        event.preventDefault();
    };

    useEffect(() => {
        const listener = (event: KeyboardEvent) => onKeyRef.current(event);

        window.addEventListener("keydown", listener);

        return () => window.removeEventListener("keydown", listener);
    }, []);

    const refused = outcome?.response.groups.filter((group) => group.refused !== null) ?? [];
    const failures = outcome?.response.groups.flatMap((group) => group.failed) ?? [];
    const grown =
        outcome?.response.groups.filter(
            (group) => group.refused === null && group.failed.length === 0 && !group.reviewed
        ) ?? [];
    const trashedTotal =
        outcome?.response.groups.reduce((total, group) => total + group.trashed, 0) ?? 0;

    return (
        <Stack gap="lg">
            {canDelete && groups.length > 0 && (
                <Text size="xs" c="dimmed" visibleFrom="sm">
                    <kbd>j</kbd> / <kbd>k</kbd> move between groups · <kbd>1</kbd>–<kbd>9</kbd>{" "}
                    choose the copy to keep · <kbd>x</kbd> tick · <kbd>Shift</kbd>+<kbd>Enter</kbd>{" "}
                    trash what is ticked
                </Text>
            )}

            {outcome && (
                <Alert
                    color={failures.length > 0 || refused.length > 0 ? "oxblood" : "brass"}
                    variant="light"
                    title={
                        trashedTotal > 0
                            ? `${plural(trashedTotal, "copy", "copies")} removed`
                            : "Nothing was removed"
                    }
                    withCloseButton
                    onClose={() => setOutcome(null)}
                >
                    <Stack gap={4}>
                        <Text size="sm">
                            Identical copies are deleted outright; the rest are kept in{" "}
                            <Link href="/review/trash">the trash</Link>, where an administrator can
                            restore them until the retention window closes.
                        </Text>

                        {/* Named, not counted: "two could not be deleted" leaves the reviewer to
                            find out which by inspection (§14b). */}
                        {failures.map((failure) => (
                            <Text key={failure.mediaId} size="sm">
                                {outcome.titles[failure.mediaId] ?? failure.mediaId} —{" "}
                                {failure.reason}
                            </Text>
                        ))}

                        {refused.map((group) => (
                            <Text key={group.groupId} size="sm">
                                {outcome.titles[group.keptId] ?? group.keptId} — {group.refused}.
                                Nothing in that group was touched.
                            </Text>
                        ))}

                        {grown.length > 0 && (
                            <Text size="sm">
                                {plural(grown.length, "group has", "groups have")} gained a copy
                                since the page loaded. It was left alone, and the{" "}
                                {grown.length === 1 ? "group stays" : "groups stay"} in the queue.
                            </Text>
                        )}
                    </Stack>
                </Alert>
            )}

            {isLoading ? (
                <PageLoader />
            ) : error ? (
                <LoadFailed error={error} what="the duplicates" onRetry={() => void refetch()} />
            ) : groups.length === 0 ? (
                page > 1 && pageCount < page ? (
                    // Resolving the last page's rows can leave it past the end.
                    <EmptyState title="This page is empty now">
                        <Button
                            variant="light"
                            color="brass"
                            onClick={() => {
                                onPage(pageCount);
                                startOver();
                            }}
                        >
                            Go to page {pageCount}
                        </Button>
                    </EmptyState>
                ) : (
                    <EmptyState title={emptyTitle}>{emptyText}</EmptyState>
                )
            ) : (
                <div>
                    {groups.map((group, index) => (
                        <DupeRow
                            key={group.id}
                            ref={(element) => {
                                rowRefs.current[index] = element;
                            }}
                            group={group}
                            keepId={keepFor(group)}
                            ticked={tickedFor(group)}
                            focused={index === focused}
                            onFocus={() => setFocused(index)}
                            onKeep={canDelete ? (memberId) => chooseKeep(group, memberId) : null}
                            onTick={canDelete ? (value) => setTick(group, value) : null}
                            onReview={(reviewed) =>
                                review.mutate({ groupIds: [group.id], reviewed })
                            }
                            reviewing={
                                review.isPending &&
                                review.variables?.groupIds.length === 1 &&
                                review.variables.groupIds[0] === group.id
                            }
                        />
                    ))}
                </div>
            )}

            {pageCount > 1 && (
                <Center>
                    <Pagination
                        value={page}
                        onChange={(next) => {
                            onPage(next);
                            startOver();
                        }}
                        total={pageCount}
                        color="brass"
                    />
                </Center>
            )}

            {/* The page's totals and its one destructive button, pinned while scrolling — the
                same bar as the library's selection, for the same reasons (§14b). */}
            {groups.length > 0 && (
                <Paper className={barClasses.bar} shadow="md" radius="md" withBorder>
                    <Group gap="sm" wrap="wrap" justify="center">
                        {canDelete && (
                            <Text size="sm">
                                {ticked.length > 0
                                    ? `${plural(going.length, "copy", "copies")} from ${plural(ticked.length, "group", "groups")} · frees ${formatBytes(freed)}`
                                    : "Nothing ticked on this page"}
                            </Text>
                        )}

                        {canDelete && tickable.length > 0 && (
                            <Button
                                size="compact-sm"
                                variant="subtle"
                                color="brass"
                                onClick={() => tickAll(ticked.length < tickable.length)}
                            >
                                {ticked.length < tickable.length ? "Tick all" : "Untick all"}
                            </Button>
                        )}

                        {/* The rows left unticked are the ones the reviewer has decided to keep
                            as they are — or has not decided about yet, which is why this is its
                            own press rather than part of trashing. */}
                        {unticked.length > 0 && (
                            <Button
                                size="compact-sm"
                                variant="light"
                                color="brass"
                                loading={
                                    review.isPending && (review.variables?.groupIds.length ?? 0) > 1
                                }
                                onClick={() =>
                                    review.mutate({
                                        groupIds: unticked.map((group) => group.id),
                                        reviewed: true,
                                    })
                                }
                            >
                                Mark {canDelete ? `${unticked.length} unticked` : unticked.length}{" "}
                                reviewed
                            </Button>
                        )}

                        {canDelete && going.length > 0 && (
                            <Button size="compact-sm" color="oxblood" onClick={openConfirm}>
                                Trash {plural(going.length, "copy", "copies")}…
                            </Button>
                        )}
                    </Group>
                </Paper>
            )}

            <DupeResolveDialog
                decisions={confirming}
                onCancel={() => setConfirming(null)}
                onConfirm={() => confirming && resolve.mutate(confirming)}
                busy={resolve.isPending}
                error={resolve.error}
            />
        </Stack>
    );
};
