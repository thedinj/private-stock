"use client";

import { useState } from "react";
import Link from "next/link";
import {
    Alert,
    Anchor,
    Badge,
    Button,
    Card,
    Group,
    Loader,
    Select,
    Stack,
    Text,
    Title,
    Tooltip,
} from "@mantine/core";

import type { FailedJob, RetryFailedJobsResult } from "@private-stock/core";

import { useFailedJobs, useRetryFailedJobs } from "@/lib/api/jobs";
import { formatBytes } from "@/lib/dupeTriage";
import { rememberReturn } from "@/lib/returnTo";

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That did not work.";

/** SQLite's UTC timestamp, in the reader's own time. */
const when = (at: string): string => {
    const date = new Date(`${at.replace(" ", "T")}Z`);

    return Number.isNaN(date.getTime())
        ? at
        : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

const outcomeText = (result: RetryFailedJobsResult): string =>
    [
        `${result.queued.toLocaleString()} queued again.`,
        result.skipped.length > 0
            ? `${result.skipped.length.toLocaleString()} could not be: ${[
                  ...new Set(result.skipped.map((skip) => skip.reason)),
              ].join("; ")}.`
            : "",
        result.remaining > 0 ? `${result.remaining.toLocaleString()} more remain.` : "",
    ]
        .filter(Boolean)
        .join(" ");

const FailedRow: React.FC<{ job: FailedJob; onRetry: () => void; busy: boolean }> = ({
    job,
    onRetry,
    busy,
}) => (
    <Group justify="space-between" wrap="nowrap" gap="sm" align="flex-start">
        {/*
         * Only the label gives way to a long filename. The badge and Retry keep their width, or
         * on a phone the label's width squeezes them to "SP…" and a lone "R".
         */}
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
            <Group gap="xs" wrap="nowrap">
                <Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
                    {job.kind}
                </Badge>
                {job.mediaId ? (
                    <Anchor
                        component={Link}
                        href={`/media/${job.mediaId}`}
                        prefetch={false}
                        onClick={rememberReturn}
                        size="sm"
                        truncate
                        style={{ minWidth: 0 }}
                    >
                        {job.label ?? job.mediaId}
                    </Anchor>
                ) : (
                    <Text size="sm">The whole library</Text>
                )}
            </Group>
            {/* The line that says why, with everything that was recorded behind it. The first
                line was usually the command ffmpeg was given, which is the same for every file. */}
            {job.lastError && (
                <Tooltip
                    label={job.lastError}
                    multiline
                    w={420}
                    openDelay={400}
                    style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                >
                    <Text size="xs" c="dimmed" lineClamp={1}>
                        {job.reason ?? job.lastError}
                    </Text>
                </Tooltip>
            )}
            <Text size="xs" c="dimmed">
                {when(job.failedAt)} · {job.attempts} {job.attempts === 1 ? "attempt" : "attempts"}
            </Text>
        </Stack>
        {job.retryable && (
            <Button
                size="compact-sm"
                variant="subtle"
                disabled={busy}
                onClick={onRetry}
                style={{ flexShrink: 0 }}
            >
                Retry
            </Button>
        )}
    </Group>
);

/**
 * Files the probe cannot read, said once rather than listed.
 *
 * Every stage fails on such a file, so it used to appear here three times with three Retry
 * buttons that could only fail again. What it needs is a decision about the file, which is
 * Review › Unreadable's to offer (§10g) -- largest first, with trash and purge.
 */
const UnreadableNote: React.FC<{ count: number; bytes: number }> = ({ count, bytes }) => (
    <Text size="sm" c="dimmed">
        {count === 1 ? "1 file" : `${count.toLocaleString()} files`} the probe cannot read,{" "}
        {formatBytes(bytes)} — not listed here, because retrying will not help.{" "}
        <Anchor component={Link} href="/review/unreadable" size="sm">
            Review {count === 1 ? "it" : "them"}
        </Anchor>
    </Text>
);

/**
 * Work that failed and has not been tried since (§13c), on the Activity tab.
 *
 * The progress card used to count these and offer nothing. Each row says what failed, on which
 * item and why, and offers Retry where it can be done here -- a stage on an item, or a
 * transcode. Absent entirely when nothing stands failed: an empty "Failed" card on a healthy
 * library is a worry with nothing behind it.
 *
 * Paged by cursor and filtered by kind, because a bad import can fail thousands of probes in an
 * afternoon. Retry all covers the filter's kind, or everything when none is picked: the first
 * production review found most standing failures were a since-fixed bug's, on files that were
 * fine, and the only sensible answer to those was all of them at once.
 */
export const FailedJobsCard: React.FC = () => {
    const [kind, setKind] = useState("");
    const failed = useFailedJobs(kind);
    const retry = useRetryFailedJobs();
    const [outcome, setOutcome] = useState<string | null>(null);

    const pages = failed.data?.pages ?? [];
    const jobs = pages.flatMap((page) => page.jobs);
    const kinds = pages[0]?.kinds ?? [];
    const total = kinds.reduce((sum, entry) => sum + entry.count, 0);
    const kindCount = kinds.find((entry) => entry.kind === kind)?.count ?? 0;
    const unreadable = pages[0]?.unreadable ?? { count: 0, bytes: 0 };

    if (failed.isPending) return null;

    if (failed.isError) {
        return (
            <Alert color="oxblood" variant="light">
                {errorText(failed.error)}
            </Alert>
        );
    }

    if (total === 0 && unreadable.count === 0 && !outcome) return null;

    const run = (input: Parameters<typeof retry.mutate>[0]) =>
        retry.mutate(input, {
            onSuccess: (result) => setOutcome(outcomeText(result)),
            onError: (error) => setOutcome(errorText(error)),
        });

    return (
        <Card p="md">
            <Stack gap="md">
                <Group justify="space-between" wrap="wrap" gap="sm">
                    <Title order={4}>Failed · {total.toLocaleString()}</Title>
                    <Group gap="xs" wrap="wrap">
                        {kinds.length > 1 && (
                            <Select
                                aria-label="Kind of work"
                                size="xs"
                                w={180}
                                data={[
                                    { value: "", label: "Every kind" },
                                    ...kinds.map((entry) => ({
                                        value: entry.kind,
                                        label: `${entry.kind} · ${entry.count.toLocaleString()}`,
                                    })),
                                ]}
                                value={kind}
                                onChange={(value) => setKind(value ?? "")}
                                allowDeselect={false}
                            />
                        )}
                        {/* Most of what stands after a fix ships is the old code's failures, which
                            is a reason to retry the lot rather than a kind at a time. */}
                        {(kind ? kindCount : total) > 1 && (
                            <Button
                                size="xs"
                                variant="light"
                                color="brass"
                                loading={retry.isPending}
                                onClick={() => run(kind ? { kind } : { all: true })}
                            >
                                Retry all {(kind ? kindCount : total).toLocaleString()}
                            </Button>
                        )}
                    </Group>
                </Group>

                {unreadable.count > 0 && <UnreadableNote {...unreadable} />}

                {outcome && (
                    <Alert
                        color="brass"
                        variant="light"
                        withCloseButton
                        onClose={() => setOutcome(null)}
                    >
                        {outcome}
                    </Alert>
                )}

                <Stack gap="sm">
                    {jobs.map((job) => (
                        <FailedRow
                            key={job.id}
                            job={job}
                            busy={retry.isPending}
                            onRetry={() => run({ jobIds: [job.id] })}
                        />
                    ))}
                </Stack>

                {failed.hasNextPage && (
                    <Button
                        variant="subtle"
                        size="xs"
                        w="fit-content"
                        loading={failed.isFetchingNextPage}
                        onClick={() => void failed.fetchNextPage()}
                    >
                        More
                    </Button>
                )}
                {failed.isFetching && !failed.isFetchingNextPage && <Loader size="xs" />}
            </Stack>
        </Card>
    );
};
