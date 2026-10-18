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
    DupeSortInput,
    DupeSortResponse,
} from "@private-stock/core";

import { ApiError, api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { invalidateListable } from "@/lib/api/trash";
import {
    allApart,
    decidedOneByOne,
    defaultKeep,
    formatBytes,
    nextSet,
    oneApart,
    removable,
    sortedDecisions,
    startSorting,
    tickedByDefault,
    toResolveItem,
    toSortInput,
    type Sorting,
} from "@/lib/dupeTriage";
import { prefersReducedMotion } from "@/lib/motion";
import { settling } from "@/lib/settling";
import { isTypingTarget } from "@/lib/typingTarget";
import { useFlipGrid } from "@/lib/useFlipGrid";
import { DupeResolveDialog, type Decision } from "@/components/dupes/DupeResolveDialog";
import { DupeRow } from "@/components/dupes/DupeRow";
import { DupeViewDrawer } from "@/components/dupes/DupeViewDrawer";
import { LoadFailed } from "@/components/LoadFailed";
import { EmptyState } from "@/components/shell/EmptyState";
import { PageLoader } from "@/components/shell/PageLoader";

import barClasses from "@/components/library/SelectionBar.module.scss";

/**
 * A triage sheet of duplicate groups (§10c).
 *
 * The queue runs to hundreds of groups, and nearly all of them are decided by a glance at the
 * pictures and the resolution. So the sheet is built for the glance: a page of compact rows,
 * the recommended copy already chosen, and one button that trashes what the page decided. The
 * old screen asked for one confirmation per group; this one asks for one per page.
 *
 * **Identical rows are decided by the page, look-alikes one at a time** (§10c). An identical row
 * starts ticked unless a glance could get it wrong, and "Tick all" and "Mark reviewed" reach it.
 * A look-alike starts unticked and nothing in bulk touches it: `y` (or "These are the same") says
 * its copies are, which ticks it and folds it to a line, and the keyboard moves to the next.
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
    /**
     * Groups resolved and playing their merge, with the keeper each was resolved to (§14,
     * "Motion"). Held here because resolving clears the per-row choices, and the merge has to
     * slide the copies into the keeper that was chosen, not into the default it reverts to.
     */
    const [merging, setMerging] = useState<Record<string, string>>({});
    /** Rows being sorted into sets of the same thing (§10i), and how far each has got. */
    const [sortings, setSortings] = useState<Record<string, Sorting>>({});
    /** A sorting waiting on the trash confirmation. */
    const [confirmingSort, setConfirmingSort] = useState<DupeGroup | null>(null);
    /** What the last sorting did, said once on the sheet. */
    const [recorded, setRecorded] = useState<string | null>(null);
    /** A copy playing beside the sheet, and the row it belongs to. */
    const [viewing, setViewing] = useState<{ groupId: string; memberId: string } | null>(null);
    const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

    const params = new URLSearchParams({
        ...baseParams,
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
    });

    const { data, isLoading, isPlaceholderData, error, refetch } = useQuery({
        queryKey: keyFor(params.toString()),
        queryFn: () => api<{ groups: DupeGroup[]; total: number }>(`${endpoint}?${params}`),
        // The rows stay put while the next page or a post-resolve refresh loads, rather than
        // the sheet blanking to a spinner under the reviewer's pointer; they settle meanwhile.
        placeholderData: keepPreviousData,
    });

    /** A different set of rows: every per-row choice belonged to the old one. */
    const startOver = (): void => {
        setKeeps({});
        setTicks({});
        setFocused(0);
        setSettled(new Set());
        setMerging({});
        setSortings({});
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

            const done = new Set(
                response.groups.filter((group) => group.reviewed).map((group) => group.groupId)
            );

            // Under reduced motion they leave at once, as they always did; otherwise each plays
            // its merge first and is settled when that is over (`settle` below).
            if (prefersReducedMotion()) {
                setSettled(done);
            } else {
                setMerging(
                    Object.fromEntries(
                        decisions
                            .filter(({ group }) => done.has(group.id))
                            .map(({ group, keepId }) => [group.id, keepId])
                    )
                );
            }

            // The library lost items and the bin gained them; see docs/CACHE_KEYS.md.
            void queryClient.invalidateQueries({ queryKey: queryKeys.dupes.all() });
            invalidateListable(queryClient);
        },
    });

    /**
     * Sorting a group into what is the same and what is not (§10i), from the row's sort mode,
     * "None match" or a copy's "Not the same as the others". The group is replaced by one per
     * set, which the refetch brings in; sets the reviewer also resolved go as a row's would.
     */
    const sort = useMutation({
        mutationFn: (input: DupeSortInput) =>
            api<DupeSortResponse>("/api/dupes/sort", {
                method: "POST",
                body: JSON.stringify(input),
            }),
        onSuccess: (response, input) => {
            setConfirmingSort(null);
            setSortings((current) =>
                Object.fromEntries(Object.entries(current).filter(([id]) => id !== input.groupId))
            );

            const together = input.sets.filter((set) => set.ids.length > 1).length;
            const alone = input.sets.length - together;
            const trashed = response.groups.reduce((total, group) => total + group.trashed, 0);
            const failed = response.groups.flatMap((group) => group.failed).length;

            setRecorded(
                [
                    together === 0
                        ? "Kept apart: none of those copies will be offered as duplicates of each other again."
                        : `Recorded ${together === 1 ? "one set" : `${together} sets`} of the same thing${alone > 0 ? ` and ${alone === 1 ? "one copy" : `${alone} copies`} on its own` : ""}.`,
                    trashed > 0
                        ? `${trashed === 1 ? "One copy" : `${trashed} copies`} went to the trash.`
                        : null,
                    failed > 0
                        ? `${failed === 1 ? "One copy" : `${failed} copies`} could not be removed; their set stays in the queue.`
                        : null,
                    "Any sorting can be taken back from the Reviewed tab.",
                ]
                    .filter(Boolean)
                    .join(" ")
            );

            void queryClient.invalidateQueries({ queryKey: queryKeys.dupes.all() });

            if (trashed > 0) invalidateListable(queryClient);
        },
    });

    const groups = (data?.groups ?? []).filter((group) => !settled.has(group.id));
    // A settled group leaves and the rows below close ranks (§14, "Motion").
    const flip = useFlipGrid(groups.map((group) => group.id));

    /** A merge has finished playing: the row may go now. */
    const settle = (groupId: string): void => {
        setSettled((current) => new Set(current).add(groupId));
        setMerging((current) =>
            Object.fromEntries(Object.entries(current).filter(([id]) => id !== groupId))
        );
    };
    const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

    const keepFor = (group: DupeGroup): string => keeps[group.id] ?? defaultKeep(group);
    // A row being sorted is decided by its own buttons, not by the page's.
    const tickedFor = (group: DupeGroup): boolean =>
        canDelete &&
        !(group.id in sortings) &&
        removable(group, keepFor(group)).length > 0 &&
        (ticks[group.id] ?? tickedByDefault(group, keepFor(group)));

    const ticked = groups.filter(tickedFor);
    // What the page's own buttons reach: never a look-alike, which is decided where it stands.
    const tickable = groups.filter(
        (group) =>
            !decidedOneByOne(group) &&
            !(group.id in sortings) &&
            removable(group, keepFor(group)).length > 0
    );
    const unticked = groups.filter(
        (group) =>
            !decidedOneByOne(group) &&
            !group.reviewed &&
            !(group.id in sortings) &&
            !tickedFor(group)
    );
    const oneByOne = groups.some(decidedOneByOne);

    const sortable = (group: DupeGroup): boolean => group.kind === "near";
    const startSort = (group: DupeGroup): void => {
        setRecorded(null);
        sort.reset();
        setSortings((current) => ({ ...current, [group.id]: startSorting(group) }));
    };
    const cancelSort = (group: DupeGroup): void =>
        setSortings((current) =>
            Object.fromEntries(Object.entries(current).filter(([id]) => id !== group.id))
        );
    const cycleSet = (group: DupeGroup, memberId: string): void =>
        setSortings((current) => {
            const sorting = current[group.id];

            return sorting
                ? {
                      ...current,
                      [group.id]: {
                          ...sorting,
                          assign: {
                              ...sorting.assign,
                              [memberId]: nextSet(group, sorting, memberId),
                          },
                      },
                  }
                : current;
        });
    const keepInSet = (group: DupeGroup, memberId: string): void =>
        setSortings((current) => {
            const sorting = current[group.id];

            return sorting
                ? {
                      ...current,
                      [group.id]: {
                          ...sorting,
                          keepers: [memberId, ...sorting.keepers.filter((id) => id !== memberId)],
                      },
                  }
                : current;
        });
    const submitSort = (group: DupeGroup, resolve: boolean): void => {
        const sorting = sortings[group.id];

        if (!sorting) return;

        setRecorded(null);

        if (resolve) {
            // Trashing goes through the same confirmation as a page, one set to a line.
            setConfirmingSort(group);
        } else {
            sort.mutate(toSortInput(group, sorting, false));
        }
    };
    const apart = (group: DupeGroup, memberId: string | null): void => {
        setRecorded(null);
        sort.mutate(memberId === null ? allApart(group) : oneApart(group, memberId));
    };
    const viewingGroup = viewing ? groups.find((group) => group.id === viewing.groupId) : undefined;
    const going = ticked.flatMap((group) => removable(group, keepFor(group)));
    const freed = going.reduce((total, member) => total + (member.sizeBytes ?? 0), 0);

    const chooseKeep = (group: DupeGroup, memberId: string): void =>
        setKeeps((current) => ({ ...current, [group.id]: memberId }));
    const setTick = (group: DupeGroup, value: boolean): void =>
        setTicks((current) => ({ ...current, [group.id]: value }));
    /** "These are the same": the row goes with the page's trash, and folds out of the way. */
    const decideSame = (group: DupeGroup): void => {
        if (removable(group, keepFor(group)).length > 0) setTick(group, true);
    };
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
     * The sheet from the keyboard: `j`/`k` between rows, a digit to choose the keeper, `y` for
     * "these are the same" and on to the next, `n` for "none match", `x` to tick or untick,
     * Shift+Enter to confirm. Read through a ref so the listener is attached once and still sees
     * this render's rows.
     */
    const onKeyRef = useRef<(event: KeyboardEvent) => void>(() => undefined);

    onKeyRef.current = (event: KeyboardEvent) => {
        if (
            confirming !== null ||
            confirmingSort !== null ||
            viewing !== null ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            isTypingTarget(event.target) ||
            groups.length === 0
        ) {
            return;
        }

        const row = groups[Math.min(focused, groups.length - 1)];
        const rowSorting = row ? sortings[row.id] : undefined;

        /**
         * A row being sorted (§10i) takes the keys that would otherwise choose: a digit moves that
         * copy to the next set, Enter records, Escape stops sorting.
         */
        if (row && rowSorting) {
            const member = /^[1-9]$/.test(event.key)
                ? row.members[Number(event.key) - 1]
                : undefined;

            if (member) {
                cycleSet(row, member.id);
            } else if (event.key === "Enter" && !event.shiftKey) {
                submitSort(row, false);
            } else if (event.key === "Escape" || event.key === "s") {
                cancelSort(row);
            } else if (!["j", "k", "p"].includes(event.key)) {
                // Ticking and trashing the page are not this row's business while it is sorted.
                return;
            }

            if (!["j", "k", "p"].includes(event.key)) {
                event.preventDefault();
                return;
            }
        }

        if (event.key === "p" && row) {
            // Play the row's copies beside the sheet, starting with the one it would keep.
            setViewing({ groupId: row.id, memberId: keepFor(row) });
        } else if (event.key === "s" && row && sortable(row) && row.members.length > 2) {
            startSort(row);
        } else if (event.key === "j") {
            moveFocus(focused + 1);
        } else if (event.key === "k") {
            moveFocus(focused - 1);
        } else if (canDelete && row && /^[1-9]$/.test(event.key)) {
            const member = row.members[Number(event.key) - 1];

            if (member) chooseKeep(row, member.id);
        } else if (canDelete && row && event.key === "y") {
            decideSame(row);
            moveFocus(focused + 1);
        } else if (row && event.key === "n" && sortable(row) && !sort.isPending) {
            apart(row, null);
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
                    choose the copy to keep · <kbd>y</kbd> the same: trash the rest
                    {oneByOne && (
                        <>
                            {" "}
                            · <kbd>n</kbd> none match · <kbd>s</kbd> sort into sets
                        </>
                    )}{" "}
                    · <kbd>p</kbd> play the copies · <kbd>x</kbd> tick or untick · <kbd>Shift</kbd>+
                    <kbd>Enter</kbd> trash what is ticked
                </Text>
            )}

            {recorded && (
                <Alert
                    color="brass"
                    variant="light"
                    withCloseButton
                    onClose={() => setRecorded(null)}
                >
                    <Text size="sm">{recorded}</Text>
                </Alert>
            )}

            {sort.error && (
                <Alert color="oxblood" variant="light" withCloseButton onClose={() => sort.reset()}>
                    <Text size="sm">
                        {sort.error instanceof ApiError
                            ? sort.error.message
                            : "The sorting could not be recorded."}
                    </Text>
                </Alert>
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
                <div ref={flip.ref} {...settling(isPlaceholderData)}>
                    {groups.map((group, index) => (
                        <DupeRow
                            key={group.id}
                            ref={(element) => {
                                rowRefs.current[index] = element;
                            }}
                            group={group}
                            keepId={merging[group.id] ?? keepFor(group)}
                            ticked={group.id in merging || tickedFor(group)}
                            folded={decidedOneByOne(group) && tickedFor(group)}
                            onSame={
                                canDelete && decidedOneByOne(group) ? () => decideSame(group) : null
                            }
                            merging={group.id in merging}
                            onMerged={() => settle(group.id)}
                            focused={index === focused}
                            onFocus={() => setFocused(index)}
                            onPlay={(member) =>
                                setViewing({ groupId: group.id, memberId: member.id })
                            }
                            sorting={sortings[group.id] ?? null}
                            onSortStart={sortable(group) ? () => startSort(group) : null}
                            onSortCycle={(memberId) => cycleSet(group, memberId)}
                            onSortCancel={() => cancelSort(group)}
                            onSortSubmit={(resolve) => submitSort(group, resolve)}
                            onApart={sortable(group) ? (memberId) => apart(group, memberId) : null}
                            sortBusy={sort.isPending && sort.variables?.groupId === group.id}
                            onKeep={
                                group.id in sortings
                                    ? (memberId) => keepInSet(group, memberId)
                                    : canDelete
                                      ? (memberId) => chooseKeep(group, memberId)
                                      : null
                            }
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
                                    : oneByOne
                                      ? "Nothing decided yet: say which groups are the same"
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

            {/* A sorting's trash, confirmed like a page: each set of the same thing is a line. */}
            <DupeResolveDialog
                decisions={
                    confirmingSort && sortings[confirmingSort.id]
                        ? sortedDecisions(confirmingSort, sortings[confirmingSort.id]!).filter(
                              ({ group, keepId }) => removable(group, keepId).length > 0
                          )
                        : null
                }
                onCancel={() => setConfirmingSort(null)}
                onConfirm={() => {
                    const sorting = confirmingSort && sortings[confirmingSort.id];

                    if (confirmingSort && sorting) {
                        sort.mutate(toSortInput(confirmingSort, sorting, true));
                    }
                }}
                busy={sort.isPending}
                error={sort.error}
            />

            <DupeViewDrawer
                members={viewingGroup?.members ?? []}
                viewingId={viewingGroup ? (viewing?.memberId ?? null) : null}
                onView={(memberId) =>
                    setViewing((current) => (current ? { ...current, memberId } : current))
                }
                onClose={() => setViewing(null)}
            />
        </Stack>
    );
};
