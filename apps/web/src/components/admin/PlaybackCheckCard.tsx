"use client";

import { Alert, Card, Stack, Switch, Text, Title } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";

import { useAdminSettings, useSaveAdminSettings } from "@/lib/api/adminSettings";
import { queryKeys } from "@/lib/api/queryKeys";

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That did not work.";

/**
 * The library's "Won't play in a browser" filter, switched on for a while (§8).
 *
 * A test bench, not a way of browsing: `assessPlayback` decides once for every device, and the
 * point of this is to open those files on the phones and computers that will actually play them
 * and see which of the verdicts are wrong. Off, the filter panel does not mention it at all.
 */
export const PlaybackCheckCard: React.FC = () => {
    const queryClient = useQueryClient();
    const { data } = useAdminSettings();
    const save = useSaveAdminSettings();
    const enabled = data?.settings.playbackCheck ?? false;

    const toggle = (next: boolean) =>
        save.mutate(
            { playbackCheck: next },
            {
                // The filter panel reads the switch from the polled stats; this saves the
                // admin who flicked it waiting for the next poll to see it.
                onSuccess: () =>
                    void queryClient.invalidateQueries({ queryKey: queryKeys.library.stats() }),
            }
        );

    return (
        <Card p="md">
            <Stack gap="sm">
                <Title order={4}>Playback check</Title>
                <Switch
                    label="Offer a “Won't play in a browser” filter"
                    description="In the library's filters, for everyone, until it is switched off. For trying those files on your own devices."
                    checked={enabled}
                    disabled={!data || save.isPending}
                    onChange={(event) => toggle(event.currentTarget.checked)}
                />
                {enabled && (
                    <Text size="sm" c="dimmed">
                        Open one, then use “Try the original” above the player. What plays here can
                        be played without converting it.
                    </Text>
                )}
                {save.isError && (
                    <Alert color="oxblood" variant="light">
                        {errorText(save.error)}
                    </Alert>
                )}
            </Stack>
        </Card>
    );
};
