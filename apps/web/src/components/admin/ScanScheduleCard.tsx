"use client";

import { Alert, Button, Card, Group, NumberInput, Stack, Switch, Text, Title } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";

import { useAdminSettings, useSaveAdminSettings, useSettingsDraft } from "@/lib/api/adminSettings";
import { queryKeys } from "@/lib/api/queryKeys";

import { SaveRow } from "./SaveRow";

const DAILY = 60 * 24;

/**
 * Finding new files (§4): filesystem events, with a periodic scan as the safety net.
 *
 * Read and saved through the settings contract like every other card. It used to read the scan
 * route and keep its own dirty flag, which made it the one card that behaved differently.
 */
export const ScanScheduleCard: React.FC = () => {
    const queryClient = useQueryClient();
    const { data } = useAdminSettings();
    const save = useSaveAdminSettings();
    const { draft: scan, set, dirty, reset } = useSettingsDraft(data?.settings.scan);

    const watch = scan?.watch ?? true;
    const periodicOff = scan?.intervalMinutes === 0;

    return (
        <Card p="md">
            <Stack gap="md">
                <Stack gap={2}>
                    <Title order={4}>Finding new files</Title>
                    <Text size="sm" c="dimmed">
                        Changes are normally picked up from filesystem events within seconds. The
                        periodic scan catches what events cannot see.
                    </Text>
                </Stack>

                <Switch
                    checked={watch}
                    onChange={(event) =>
                        scan && set({ ...scan, watch: event.currentTarget.checked })
                    }
                    label="Watch the filesystem for changes"
                    description="Works for local disks; a remote mount cannot report writes made by another machine."
                />

                <Group gap="xs" align="flex-end">
                    <NumberInput
                        label="Periodic scan interval"
                        description="Minutes between scans. 0 switches it off."
                        value={scan?.intervalMinutes ?? DAILY}
                        onChange={(value) =>
                            scan &&
                            set({
                                ...scan,
                                intervalMinutes: typeof value === "number" ? value : 0,
                            })
                        }
                        min={0}
                        max={DAILY * 30}
                        step={60}
                        w={{ base: "100%", xs: 260 }}
                    />
                    <Button
                        variant="light"
                        size="xs"
                        onClick={() => scan && set({ ...scan, intervalMinutes: DAILY })}
                    >
                        Daily
                    </Button>
                    <Button
                        variant="light"
                        size="xs"
                        onClick={() => scan && set({ ...scan, intervalMinutes: 0 })}
                    >
                        Off
                    </Button>
                </Group>

                {/* Both off means the library silently stops updating, which looks like a bug
                    rather than a setting. */}
                {periodicOff && !watch && (
                    <Alert color="oxblood" variant="light">
                        Watching and periodic scanning are both off. Nothing new will be found until
                        someone presses Scan now.
                    </Alert>
                )}

                <SaveRow
                    onSave={() =>
                        scan &&
                        save.mutate(
                            { scan },
                            {
                                onSuccess: () => {
                                    reset();
                                    void queryClient.invalidateQueries({
                                        queryKey: queryKeys.admin.scan(),
                                    });
                                },
                            }
                        )
                    }
                    saving={save.isPending}
                    dirty={dirty}
                    note="Applies on the worker's next cycle."
                />
            </Stack>
        </Card>
    );
};
