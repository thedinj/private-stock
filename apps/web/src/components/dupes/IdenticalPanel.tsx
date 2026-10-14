"use client";

import { useRef, useState } from "react";
import {
    Alert,
    Box,
    Button,
    Card,
    Center,
    Group,
    Modal,
    Pagination,
    Paper,
    Progress,
    SimpleGrid,
    Stack,
    Text,
    Title,
} from "@mantine/core";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
    BulkActionFailure,
    DupeGroup,
    DupeReviewInput,
    IdenticalListResponse,
    IdenticalTrashResponse,
    MediaKind,
} from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { invalidateListable } from "@/lib/api/trash";
import { formatBytes, removable } from "@/lib/dupeTriage";
import { settling } from "@/lib/settling";
import { DupeSheet } from "@/components/dupes/DupeSheet";
import { LoadFailed } from "@/components/LoadFailed";
import { MiddleEllipsis } from "@/components/MiddleEllipsis";
import { EmptyState } from "@/components/shell/EmptyState";
import { PageLoader } from "@/components/shell/PageLoader";

/**
 * Identical files, decided by a rule rather than a page at a time (§10e).
 *
 * Byte-identical copies leave nothing to judge — the only question is which path stays — so
 * paging through hundreds of them was a chore with no decisions in it. The rule is stated once:
 * keep a copy on a read-only library if there is one, otherwise the one catalogued first; delete
 * every other copy outright -- they bypass the trash, since the copy kept has the same bytes. One button applies it to every pending identical group, including the ones
 * never shown.
 *
 * **What the rule will not decide is kept apart and shown as the ordinary sheet**: groups whose
 * doomed copies have clips on them, and groups whose copies are no longer provably the same
 * bytes. The rest are cards, one picture each — they are the same picture — so a glance can
 * still catch the one that should not go, and "Keep all" takes it out of the run.
 */

const CARDS_PER_PAGE = 48;

/** How many groups each request decides. See `identicalTrashRequestSchema`. */
const BATCH = 50;

const plural = (count: number, one: string, many: string): string =>
    `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** Where the run has got to, and what it has refused. */
interface Run {
    decided: number;
    trashed: number;
    failed: BulkActionFailure[];
    /** Set by the Stop button; the batch in flight finishes and no other starts. */
    stopped: boolean;
    done: boolean;
}

/** One routine group: one picture, and what the rule keeps and trashes. */
const IdenticalCard: React.FC<{
    group: DupeGroup;
    onKeepAll: (() => void) | null;
    keeping: boolean;
}> = ({ group, onKeepAll, keeping }) => {
    const keeper = group.members.find((member) => member.id === group.suggestedKeepId);
    const going = keeper ? removable(group, keeper.id) : [];
    const cover = keeper?.coverUrl ?? group.members.find((member) => member.coverUrl)?.coverUrl;
    const freed = going.reduce((total, member) => total + (member.sizeBytes ?? 0), 0);

    return (
        <Card withBorder padding="xs" radius="md">
            <Card.Section>
                {cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={cover}
                        alt=""
                        loading="lazy"
                        style={{
                            display: "block",
                            width: "100%",
                            aspectRatio: "16 / 9",
                            objectFit: "cover",
                        }}
                    />
                ) : (
                    <Box style={{ aspectRatio: "16 / 9", background: "var(--ps-well)" }} />
                )}
            </Card.Section>

            <Stack gap={2} mt="xs">
                {/* Copies of one item are named alike by definition: the end is what differs. */}
                <MiddleEllipsis text={keeper?.title ?? "Untitled"} size="sm" fw={600} />
                <Text size="xs" c="dimmed">
                    {plural(group.members.length, "copy", "copies")} · frees {formatBytes(freed)}
                </Text>
                {/* The one decision the rule made, said where it can be checked. */}
                <Text
                    size="xs"
                    c="dimmed"
                    truncate="start"
                    title={keeper ? `${keeper.rootLabel} · ${keeper.relPath}` : undefined}
                >
                    Keeps {keeper ? `${keeper.rootLabel} · ${keeper.relPath}` : "—"}
                </Text>
            </Stack>

            {onKeepAll && (
                <Button
                    mt="xs"
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    loading={keeping}
                    onClick={onKeepAll}
                >
                    Keep all
                </Button>
            )}
        </Card>
    );
};

export const IdenticalPanel: React.FC<{
    canDelete: boolean;
    /** The cards' page, one-based, owned by the page so it lives in the address (§14b). */
    page: number;
    onPage: (page: number) => void;
    /** The "Needs a look" sheet's page, kept apart: the two page independently. */
    sheetPage: number;
    onSheetPage: (page: number) => void;
    /** Groups of videos or of photos only, from the page's kind control; both when absent. */
    media: MediaKind | undefined;
}> = ({ canDelete, page, onPage, sheetPage, onSheetPage, media }) => {
    const queryClient = useQueryClient();
    const [confirming, setConfirming] = useState(false);
    const [run, setRun] = useState<Run | null>(null);
    const stopRef = useRef(false);

    // The summary, the cards and the run all follow the kind control: the button deletes what
    // the summary above it counted, and no more.
    const only: Record<string, string> = media ? { media } : {};
    const params = new URLSearchParams({
        view: "routine",
        ...only,
        limit: String(CARDS_PER_PAGE),
        offset: String((page - 1) * CARDS_PER_PAGE),
    }).toString();

    const { data, isLoading, isPlaceholderData, error, refetch } = useQuery({
        queryKey: queryKeys.dupes.identical(params),
        queryFn: () => api<IdenticalListResponse>(`/api/dupes/identical?${params}`),
        placeholderData: keepPreviousData,
    });

    const review = useMutation({
        mutationFn: (input: DupeReviewInput) =>
            api("/api/dupes/review", { method: "POST", body: JSON.stringify(input) }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.dupes.all() }),
    });

    /**
     * Trashes every identical copy, a batch at a time (§10e).
     *
     * The server re-plans every batch, so a group edited, given clips or kept since the page
     * loaded is judged as it is when its turn comes. Each group is tried once: the cursor moves
     * past a group whether or not all of it went.
     */
    const trashAll = useMutation({
        mutationFn: async () => {
            stopRef.current = false;

            let after: string | null = null;
            let state: Run = { decided: 0, trashed: 0, failed: [], stopped: false, done: false };

            setRun(state);

            do {
                const batch: IdenticalTrashResponse = await api<IdenticalTrashResponse>(
                    "/api/dupes/identical",
                    { method: "POST", body: JSON.stringify({ after, limit: BATCH, media }) }
                );

                after = batch.cursor;
                state = {
                    ...state,
                    decided: state.decided + batch.groups,
                    trashed: state.trashed + batch.trashed,
                    failed: [...state.failed, ...batch.failed],
                };
                setRun(state);
            } while (after !== null && !stopRef.current);

            setRun({ ...state, stopped: stopRef.current, done: true });
        },
        onSettled: () => {
            onPage(1);
            // Every group it decided left the queue, and every copy left the library.
            void queryClient.invalidateQueries({ queryKey: queryKeys.dupes.all() });
            invalidateListable(queryClient);
        },
    });

    const summary = data?.summary;
    const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / CARDS_PER_PAGE));
    const running = trashAll.isPending;
    // Against the count when the run began: the summary is not refetched until it ends.
    const progress =
        run && summary && summary.groups > 0
            ? Math.min(100, (run.decided / summary.groups) * 100)
            : 0;

    if (isLoading) {
        return <PageLoader />;
    }

    if (error || !summary) {
        return (
            <LoadFailed error={error} what="the identical files" onRetry={() => void refetch()} />
        );
    }

    return (
        <Stack gap="xl">
            {/* The whole queue in one line, and the one button that clears it. */}
            {summary.groups > 0 || running ? (
                <Paper withBorder radius="md" p="lg">
                    <Stack gap="sm">
                        <Title order={3}>
                            {plural(summary.copies, "identical copy", "identical copies")} to clear
                        </Title>
                        <Text size="sm">
                            {plural(summary.groups, "group", "groups")} · frees{" "}
                            {formatBytes(summary.bytes)} in your libraries.
                        </Text>
                        <Text size="sm" c="dimmed">
                            In each group the copy in a read-only library stays, or else the one
                            catalogued first; every other copy is deleted outright. They bypass the
                            trash — the copy that stays has the same bytes — so there is nothing to
                            restore and nothing waits on the data volume.
                        </Text>
                        {summary.attention > 0 && (
                            <Text size="sm" c="dimmed">
                                {plural(summary.attention, "group is", "groups are")} left out and
                                listed below for you to decide.
                            </Text>
                        )}

                        {running && (
                            <Stack gap={4}>
                                <Progress value={progress} color="oxblood" animated />
                                <Text size="xs" c="dimmed">
                                    {plural(run?.trashed ?? 0, "copy", "copies")} deleted from{" "}
                                    {plural(run?.decided ?? 0, "group", "groups")}…
                                </Text>
                            </Stack>
                        )}

                        {canDelete && (
                            <Group>
                                {running ? (
                                    <Button
                                        variant="default"
                                        onClick={() => {
                                            stopRef.current = true;
                                        }}
                                    >
                                        Stop after this batch
                                    </Button>
                                ) : (
                                    <Button color="oxblood" onClick={() => setConfirming(true)}>
                                        Delete{" "}
                                        {plural(
                                            summary.copies,
                                            "identical copy",
                                            "identical copies"
                                        )}{" "}
                                        {/* "Forever", because these bypass the trash (§10e):
                                            a twin stays, so there is nothing to restore. */}
                                        forever…
                                    </Button>
                                )}
                            </Group>
                        )}
                    </Stack>
                </Paper>
            ) : null}

            {/* What the last run did — failures named by reason, since the copies are gone
                from the page they were on. */}
            {run?.done && (
                <Alert
                    color={run.failed.length > 0 ? "oxblood" : "brass"}
                    variant="light"
                    withCloseButton
                    onClose={() => setRun(null)}
                    title={`${plural(run.trashed, "copy", "copies")} deleted from ${plural(run.decided, "group", "groups")}${run.stopped ? " — stopped" : ""}`}
                >
                    <Stack gap={4}>
                        {run.failed.length === 0 ? (
                            <Text size="sm">
                                The copies that stayed hold the same bytes, and everything recorded
                                about the ones that went.
                            </Text>
                        ) : (
                            <>
                                <Text size="sm">
                                    {plural(run.failed.length, "copy", "copies")} could not be
                                    deleted and{" "}
                                    {run.failed.length === 1
                                        ? "its group stays"
                                        : "their groups stay"}{" "}
                                    in the queue:
                                </Text>
                                {Object.entries(
                                    run.failed.reduce<Record<string, number>>(
                                        (counts, failure) => ({
                                            ...counts,
                                            [failure.reason]: (counts[failure.reason] ?? 0) + 1,
                                        }),
                                        {}
                                    )
                                ).map(([reason, count]) => (
                                    <Text key={reason} size="sm">
                                        {count.toLocaleString()} × {reason}
                                    </Text>
                                ))}
                            </>
                        )}
                    </Stack>
                </Alert>
            )}

            {trashAll.error && (
                <Alert color="oxblood" variant="light" title="The run stopped">
                    {trashAll.error.message} Whatever was deleted before it stopped stays deleted;
                    starting again picks up the rest.
                </Alert>
            )}

            {/* What the rule leaves for a person: the ordinary sheet, fed from this view. */}
            {summary.attention > 0 && (
                <Stack gap="sm">
                    <Title order={4}>Needs a look · {summary.attention.toLocaleString()}</Title>
                    <DupeSheet
                        endpoint="/api/dupes/identical"
                        params={{ view: "attention", ...only }}
                        keyFor={queryKeys.dupes.identical}
                        canDelete={canDelete}
                        emptyTitle="Nothing needs a look"
                        emptyText="Every identical group can be decided by the rule."
                        page={sheetPage}
                        onPage={onSheetPage}
                    />
                </Stack>
            )}

            {data.total > 0 ? (
                <Stack gap="sm">
                    <Title order={4}>Decided by the rule · {data.total.toLocaleString()}</Title>
                    <Text size="xs" c="dimmed">
                        Biggest first. Keep all takes a group out of the run and marks it reviewed.
                    </Text>
                    {/* The last page stays up and settles while the next one loads. */}
                    <SimpleGrid
                        cols={{ base: 2, sm: 3, md: 4, lg: 6 }}
                        spacing="sm"
                        {...settling(isPlaceholderData)}
                    >
                        {data.groups.map((group) => (
                            <IdenticalCard
                                key={group.id}
                                group={group}
                                keeping={
                                    review.isPending && review.variables?.groupIds[0] === group.id
                                }
                                onKeepAll={
                                    running
                                        ? null
                                        : () =>
                                              review.mutate({
                                                  groupIds: [group.id],
                                                  reviewed: true,
                                              })
                                }
                            />
                        ))}
                    </SimpleGrid>

                    {pageCount > 1 && (
                        <Center>
                            <Pagination
                                value={page}
                                onChange={onPage}
                                total={pageCount}
                                color="brass"
                            />
                        </Center>
                    )}
                </Stack>
            ) : summary.attention === 0 ? (
                <EmptyState title="No identical files waiting">
                    Anything already decided is on the Reviewed tab.
                </EmptyState>
            ) : null}

            <Modal
                opened={confirming}
                onClose={() => setConfirming(false)}
                title="Delete every identical copy?"
                centered
            >
                <Stack gap="md">
                    <Text size="sm">
                        {plural(summary.copies, "copy", "copies")} from{" "}
                        {plural(summary.groups, "group", "groups")}{" "}
                        {summary.copies === 1 ? "is" : "are"} deleted — including groups on pages
                        you have not looked at. One copy of each stays: the one in a read-only
                        library, or else the one catalogued first.
                    </Text>
                    <Text size="sm">
                        Ratings, tags, notes and playlist places move to the copy that stays. The
                        deleted copies bypass the trash and cannot be restored — the copy that stays
                        has the same bytes — so {formatBytes(summary.bytes)} is freed at once.
                    </Text>
                    {summary.attention > 0 && (
                        <Text size="sm" c="dimmed">
                            {plural(summary.attention, "group", "groups")} needing a look{" "}
                            {summary.attention === 1 ? "is" : "are"} not included.
                        </Text>
                    )}

                    <Group justify="flex-end">
                        {/* Cancel has the focus: this is every group at once, including the
                            ones nobody has looked at, and a reflexive Enter must not start it. */}
                        <Button
                            variant="default"
                            onClick={() => setConfirming(false)}
                            data-autofocus
                        >
                            Cancel
                        </Button>
                        {/* Closes as the run starts, so the progress on the card is what shows. */}
                        <Button
                            color="oxblood"
                            onClick={() => {
                                setConfirming(false);
                                trashAll.mutate();
                            }}
                        >
                            Delete {plural(summary.copies, "copy", "copies")}
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Stack>
    );
};
