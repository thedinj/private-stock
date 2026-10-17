"use client";

import Link from "next/link";
import { Alert, Button, Card, Group, Stack, Switch, Text, Title } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";

import { useAdminSettings, useSaveAdminSettings } from "@/lib/api/adminSettings";
import { queryKeys } from "@/lib/api/queryKeys";

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That did not work.";

/**
 * Finding out which "unplayable" videos the household's devices play anyway (§8).
 *
 * `assessPlayback` decides once for every device. The check page tries samples of each kind in
 * whichever browser opens it; the switch adds a "Won't play in a browser" filter to the library
 * for looking at the files themselves. A test bench rather than a way of browsing, so the
 * filter is off by default, and while it is off the filter panel does not mention it.
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
                <Text size="sm" c="dimmed">
                    Tries a few of each kind of file a browser is expected to refuse, on whichever
                    device opens it. Open it on each phone and computer you watch on.
                </Text>
                <Group>
                    <Button
                        component={Link}
                        href="/admin/playback-check"
                        variant="light"
                        color="brass"
                    >
                        Check this device
                    </Button>
                </Group>
                <Switch
                    label="Offer a “Won't play in a browser” filter"
                    description="In the library's filters, for everyone, until it is switched off."
                    checked={enabled}
                    disabled={!data || save.isPending}
                    onChange={(event) => toggle(event.currentTarget.checked)}
                />
                {save.isError && (
                    <Alert color="oxblood" variant="light">
                        {errorText(save.error)}
                    </Alert>
                )}
            </Stack>
        </Card>
    );
};
