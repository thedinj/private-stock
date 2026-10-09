"use client";

import {
    Badge,
    Card,
    CheckIcon,
    Group,
    Progress,
    Skeleton,
    Stack,
    Text,
    Title,
    Tooltip,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import { PROCESSING_POLL_MS, PROGRESS_STAGE_NAMES, processingIsActive } from "@private-stock/core";
import type { ProcessingStatus, StageProgressView } from "@private-stock/core";

import { useAuth } from "@/lib/api/AuthProvider";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * How far the library has been processed (§13c).
 *
 * Unpolished on purpose — this is the functional version, meant as the basis for the UX pass
 * rather than the end of it. What should survive that pass is the *shape*: one bar per stage
 * on a shared denominator, so the answer to "what is it actually doing" is a glance down the
 * left edge rather than arithmetic between four numbers.
 *
 * A single aggregate percentage was the obvious alternative and is strictly worse: it hides
 * that covers finished an hour ago and sprites have not started, which is the thing worth
 * knowing when a library looks half-built.
 */

/**
 * Whether to keep asking, and how often: at `PROCESSING_POLL_MS` while `processingIsActive`, and
 * not at all otherwise -- an idle library should not be asked what it is doing every two seconds
 * all night on a box whose disk is the binding constraint (§17, §20). The rule lives in core
 * because the server's cache of this answer reads it too.
 */
const activeInterval = (status: ProcessingStatus | undefined): number | false =>
    !status || processingIsActive(status) ? PROCESSING_POLL_MS : false;

const percent = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0);

/** An hour as the clock shows it, so "throttled until 2" cannot be read as a duration. */
const clock = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

/**
 * Whether the library is going slowly on purpose (§7c).
 *
 * Without this the feature working correctly is indistinguishable from the worker having
 * died: bars that barely move, a queue that does not drain. The liveness badge already
 * covers the other half of the same confusion, so the two share a line.
 */
const ThrottleNote: React.FC<{ throttle: NonNullable<ProcessingStatus["throttle"]> }> = ({
    throttle,
}) => (
    <Tooltip
        label={
            throttle.active
                ? `Background work is limited until ${clock(throttle.changesAtHour)}. Anything you ask for by hand runs at full speed regardless.`
                : `Running at full speed until ${clock(throttle.changesAtHour)}.`
        }
    >
        <Badge size="xs" color={throttle.active ? "oak.6" : "brass"} variant="light">
            {throttle.active ? "throttled" : "full speed"} until {clock(throttle.changesAtHour)}
        </Badge>
    </Tooltip>
);

/**
 * One stage, as a stacked bar.
 *
 * The segments are ordered settled-first so the filled portion grows from the left as a single
 * mass, rather than leaving gaps that make a half-done stage look like several separate ones.
 *
 * A finished stage is marked as finished rather than left to the bar. At 99.9% a bar is
 * visibly full, so "nearly done" and "done" looked the same; the check and the faded bar put
 * the difference in the label column, and leave the stages still working as the vivid ones.
 * "Finished" is nothing left to try -- failures included, which keep their own badge -- and
 * nothing queued: a repair or a re-run queued against a stage whose items all have an outcome
 * is work the stage is still doing, and the label says how much.
 */
const StageBar: React.FC<{ row: StageProgressView }> = ({ row }) => {
    const settled = row.done + row.empty + row.skipped;
    const complete = row.applicable > 0 && row.remaining === 0 && row.queued === 0;
    // Queued work over items that all have an outcome already: re-runs and repairs.
    const again = row.remaining === 0 && row.queued > 0;

    return (
        <div>
            <Group justify="space-between" gap="xs" wrap="nowrap" mb={4}>
                <Group gap={6} wrap="nowrap">
                    {complete && <CheckIcon size={11} color="var(--mantine-color-brass-5)" />}
                    <Tooltip label={row.describe} openDelay={400}>
                        <Text size="sm" fw={500} tt="capitalize">
                            {row.stage}
                        </Text>
                    </Tooltip>
                </Group>

                <Group gap="xs" wrap="nowrap">
                    {row.failed > 0 && (
                        <Badge size="xs" color="oxblood" variant="light">
                            {row.failed.toLocaleString()} failed
                        </Badge>
                    )}
                    <Text size="xs" c="dimmed">
                        {complete
                            ? `complete · ${row.applicable.toLocaleString()}`
                            : again
                              ? `${row.applicable.toLocaleString()} · ${row.queued.toLocaleString()} queued again`
                              : `${settled.toLocaleString()} / ${row.applicable.toLocaleString()}`}
                    </Text>
                </Group>
            </Group>

            {/* `Progress.Root` rather than a plain bar: the four outcomes are different facts
                and collapsing them would make a stage that produced nothing for half the
                library look identical to one that is half finished. */}
            <Progress.Root size="lg" style={complete ? { opacity: 0.45 } : undefined}>
                <Tooltip label={`${row.done.toLocaleString()} done`} disabled={row.done === 0}>
                    <Progress.Section value={percent(row.done, row.applicable)} color="brass" />
                </Tooltip>
                <Tooltip
                    label={`${row.empty.toLocaleString()} had nothing to produce`}
                    disabled={row.empty === 0}
                >
                    <Progress.Section value={percent(row.empty, row.applicable)} color="brass.8" />
                </Tooltip>
                <Tooltip
                    label={`${row.skipped.toLocaleString()} not applicable`}
                    disabled={row.skipped === 0}
                >
                    <Progress.Section value={percent(row.skipped, row.applicable)} color="oak.6" />
                </Tooltip>
                <Tooltip
                    label={`${row.failed.toLocaleString()} failed`}
                    disabled={row.failed === 0}
                >
                    <Progress.Section value={percent(row.failed, row.applicable)} color="oxblood" />
                </Tooltip>
            </Progress.Root>
        </div>
    );
};

/**
 * What time the server thinks it is.
 *
 * Shown whether or not quiet hours are switched on, which is the fix for a real omission:
 * this used to be nested inside the throttle block, so the library that had never configured
 * a window — every library, by default — showed nothing, while the quiet hours card told
 * people the server clock was on this card. It is most needed *before* the feature is turned
 * on, by whoever is deciding which hours to type in.
 *
 * The zone is named alongside it because the hour on its own is not checkable. "14:00" looks
 * plausible from any zone on earth; "14:00 America/Chicago" is either right or obviously
 * wrong, and a container left on UTC is the likeliest way this schedule misfires.
 */
export const ServerClock: React.FC<{ clock: ProcessingStatus["serverClock"] }> = ({
    clock: server,
}) => (
    <Tooltip
        label={
            server.source === "configured"
                ? `Quiet hours are read on this clock. ${server.timeZone}, ${server.offsetLabel} right now.`
                : `Quiet hours are read on the server's own clock, ${server.timeZone} (${server.offsetLabel}). Set a time zone in the quiet hours settings if that is not yours.`
        }
    >
        <Text size="xs" c="dimmed">
            server clock {clock(server.hour)} {server.timeZone}
        </Text>
    </Tooltip>
);

/**
 * The running scan.
 *
 * Two different widgets behind one component, because the data genuinely differs: a library's
 * first walk has no denominator — it does not know how many files it will find until it has
 * found them — so it gets a counter and an indeterminate bar. Every later scan is measured
 * against the same library's last completed walk. Inventing a total for the first case is
 * exactly how progress bars come to be distrusted.
 */
const ScanLine: React.FC<{ scan: NonNullable<ProcessingStatus["scan"]> }> = ({ scan }) => (
    <div>
        <Group justify="space-between" gap="xs" wrap="nowrap" mb={4}>
            <Text size="sm" fw={500}>
                Scanning {scan.rootLabel}
            </Text>
            <Text size="xs" c="dimmed">
                {scan.filesSeen.toLocaleString()}
                {scan.estimatedTotal ? ` / ~${scan.estimatedTotal.toLocaleString()}` : " files"}
            </Text>
        </Group>

        <Progress
            size="lg"
            color="brass"
            animated
            value={scan.estimatedTotal ? percent(scan.filesSeen, scan.estimatedTotal) : 100}
        />

        <Text size="xs" c="dimmed" mt={4}>
            {scan.filesAdded.toLocaleString()} added · {scan.filesChanged.toLocaleString()} changed
            · {scan.filesMoved.toLocaleString()} moved
            {scan.estimatedTotal === null &&
                " · no estimate until this library has been scanned once"}
        </Text>
    </div>
);

/**
 * The card before its first poll answers.
 *
 * Rendering nothing was the previous behaviour, and on a page whose other cards arrive
 * immediately it reads as a section that is not there rather than one that is coming — then
 * seven bars appear at once and shove everything below them down the page.
 *
 * The rows are the registry's, not a guessed count, so the placeholder is the right height
 * and the right length. The stage *names* are static too, so they are shown for real: what is
 * unknown is every number on this card, and only that is greyed out.
 *
 * No placeholder for the scan line. Whether a scan is running is exactly the sort of thing
 * this component does not know yet, and a bar that appears only sometimes is worse reserved
 * than not.
 */
const ProcessingSkeleton: React.FC = () => (
    <Card withBorder padding="md">
        <Group justify="space-between" mb="md">
            <Title order={4}>Progress</Title>
            <Skeleton height={20} width={110} radius="xl" />
        </Group>

        <Stack gap="sm">
            {/* The clock line, which is on this card at every hour and in every
                configuration, so leaving it out would reintroduce the reflow one row
                further up. */}
            <Skeleton height={12} width={180} />

            {PROGRESS_STAGE_NAMES.map((stage) => (
                <div key={stage}>
                    <Group justify="space-between" gap="xs" wrap="nowrap" mb={4}>
                        <Text size="sm" fw={500} tt="capitalize">
                            {stage}
                        </Text>
                        <Skeleton height={12} width={72} />
                    </Group>

                    {/* Matches `Progress` at size="lg", so nothing moves when the real bar
                        replaces it. */}
                    <Skeleton height={12} radius="sm" />
                </div>
            ))}
        </Stack>
    </Card>
);

/**
 * What the library is doing, polled while it is doing something.
 *
 * Shared by the Activity card, the Processing header's state, the sidebar's badge and the quiet
 * hours card's clock: one cache, so they can never disagree.
 */
export const useProcessingStatus = () => {
    const { hasScope } = useAuth();

    return useQuery({
        queryKey: queryKeys.admin.processing(),
        queryFn: () => api<ProcessingStatus>("/api/admin/processing"),
        refetchInterval: (query) => activeInterval(query.state.data),
        enabled: hasScope("admin"),
    });
};

export const ProcessingProgress: React.FC = () => {
    const { data, isLoading } = useProcessingStatus();

    /**
     * `isLoading` rather than `!data`, which is the same thing three ways: it is false for a
     * non-admin, whose query never runs and who would otherwise be shown a skeleton that
     * never resolves; false once a poll has failed, where a permanent skeleton claims the
     * request is still coming; and false on every refetch, so the card does not blink back to
     * placeholders every two seconds while work runs.
     */
    if (!data) {
        return isLoading ? <ProcessingSkeleton /> : null;
    }

    const outstanding = data.queue.pending + data.queue.claimed;

    return (
        <Card withBorder padding="md">
            <Group justify="space-between" mb="md">
                <Title order={4}>Progress</Title>

                {/* The one thing a bar cannot say. A stalled bar looks the same whether the
                    worker is grinding through a long transcode or died in the night, and
                    those call for opposite responses. */}
                {outstanding === 0 ? (
                    <Badge color="brass" variant="light">
                        up to date
                    </Badge>
                ) : (
                    <Tooltip
                        label={
                            data.queue.workerAlive
                                ? "A job has reported in within the last minute."
                                : "Nothing has reported in recently. The worker may be idle between jobs, or it may have stopped."
                        }
                    >
                        <Badge color={data.queue.workerAlive ? "brass" : "oxblood"} variant="light">
                            {outstanding.toLocaleString()} queued
                            {data.queue.workerAlive ? "" : " · not running?"}
                        </Badge>
                    </Tooltip>
                )}
            </Group>

            <Stack gap="sm">
                <Group gap="xs">
                    {data.throttle && <ThrottleNote throttle={data.throttle} />}
                    <ServerClock clock={data.serverClock} />
                </Group>

                {data.scan && <ScanLine scan={data.scan} />}

                {data.stages.map((row) => (
                    <StageBar key={row.stage} row={row} />
                ))}
            </Stack>

            {/* States what was observed, not what will happen next.

                This said "and will not be retried", which was a claim about the future and was
                wrong for one of the six jobs it was describing: a stage stops after its
                `maxAttempts`, but anything with its own backfill decides separately, so the
                sentence was true of five failures and false of the sixth. Reporting the count
                and leaving the prediction out is both shorter and correct. */}
            {data.queue.failed > 0 && (
                <Text size="xs" c="oxblood" mt="sm">
                    {data.queue.failed.toLocaleString()} job
                    {data.queue.failed === 1 ? " has" : "s have"} failed and not been tried since —
                    listed below.
                </Text>
            )}

            {data.queue.byKind.length > 0 && (
                <Text size="xs" c="dimmed" mt="sm">
                    Queued:{" "}
                    {data.queue.byKind
                        .map(
                            (kind) =>
                                `${kind.kind} ${(kind.pending + kind.claimed).toLocaleString()}`
                        )
                        .join(" · ")}
                </Text>
            )}
        </Card>
    );
};
