"use client";

import { Alert, Button, Card, Group, Stack, Text, Title } from "@mantine/core";

import { transcodeEnabled } from "@private-stock/core";

import { useAdminSettings } from "@/lib/api/adminSettings";
import { useRequeueTranscodes, useTranscodeQueue } from "@/lib/api/jobs";

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That did not work.";

/**
 * What transcoding is doing (§8), on the Transcoding tab beneath its settings.
 *
 * The depth, and one action: queue a copy of everything a browser cannot play that has none.
 * The worker's backfill does that every few minutes anyway; the button is for trying a changed
 * hardware setting now rather than at the next sweep. Failed conversions are listed with every
 * other failure, on the Activity tab.
 */
export const TranscodeQueueCard: React.FC = () => {
    const { data: settings } = useAdminSettings();
    const queue = useTranscodeQueue();
    const requeue = useRequeueTranscodes();
    const enabled = transcodeEnabled(settings?.settings.stagePolicy ?? {});

    const pending = queue.data?.pending ?? 0;
    const running = queue.data?.running ?? 0;

    return (
        <Card p="md">
            <Stack gap="sm">
                <Group justify="space-between" wrap="wrap" gap="sm">
                    <Stack gap={2}>
                        <Title order={4}>Queue</Title>
                        <Text size="sm" c="dimmed">
                            {!queue.data
                                ? "…"
                                : pending + running === 0
                                  ? "Nothing waiting."
                                  : `${running.toLocaleString()} converting, ${pending.toLocaleString()} waiting.`}
                        </Text>
                    </Stack>
                    <Button
                        variant="light"
                        color="brass"
                        disabled={!enabled}
                        title={enabled ? undefined : "Switch transcoding on first"}
                        loading={requeue.isPending}
                        onClick={() => requeue.mutate()}
                    >
                        Queue unplayable files
                    </Button>
                </Group>

                {requeue.data && (
                    <Text size="sm">
                        Queued {requeue.data.queued.toLocaleString()} of{" "}
                        {requeue.data.examined.toLocaleString()} looked at; the rest play already or
                        are queued.
                    </Text>
                )}
                {(requeue.isError || queue.isError) && (
                    <Alert color="oxblood" variant="light">
                        {errorText(requeue.error ?? queue.error)}
                    </Alert>
                )}
            </Stack>
        </Card>
    );
};
