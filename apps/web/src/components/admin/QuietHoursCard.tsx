"use client";

import { useMemo } from "react";
import {
    Card,
    Group,
    NumberInput,
    Select,
    Slider,
    Stack,
    Switch,
    Text,
    Title,
} from "@mantine/core";

import { supportedTimeZones, systemTimeZone, timeZoneOffsetLabel } from "@private-stock/core";

import { useAdminSettings, useSaveAdminSettings, useSettingsDraft } from "@/lib/api/adminSettings";

import { edgeLabel } from "./edgeLabel";
import { ServerClock, useProcessingStatus } from "./ProcessingProgress";
import { SaveRow } from "./SaveRow";

/**
 * The sentinel for "whatever the host is set to", which is stored as null.
 *
 * Null rather than resolving to a concrete zone at save time, so a container given a correct
 * `TZ` needs no setting at all, and one corrected later is followed rather than overridden.
 */
const HOST_ZONE = "";

/**
 * The zone picker's options, from the engine rather than from a list we maintain (§7c).
 *
 * `Intl.supportedValuesOf` is the tz database the same engine converts with, so the picker
 * cannot offer a zone the schedule then fails to honour. The names may be the
 * backward-compatible ones (`Asia/Calcutta`); they convert correctly and are shown as they come,
 * since renaming them would store a value that does not match what was clicked. `UTC` is added
 * when the engine leaves it out. The offset is taken at this instant so a zone on summer time
 * says so.
 *
 * Memoised: this builds 400-odd `Intl` formatters, about 50ms -- visible on every keystroke.
 */
const useTimeZoneOptions = (current: string | null): { value: string; label: string }[] =>
    useMemo(() => {
        const now = new Date();
        const zones = supportedTimeZones();
        const withUtc = zones.includes("UTC") ? zones : ["UTC", ...zones];
        // A zone stored by a different engine would otherwise select nothing and read as "no
        // zone set" on a library that has one.
        const all = current && !withUtc.includes(current) ? [current, ...withUtc] : withUtc;

        return [
            { value: HOST_ZONE, label: `Server's own time zone (${systemTimeZone()})` },
            ...all.map((zone) => ({
                value: zone,
                label: `${zone} (${timeZoneOffsetLabel(zone, now)})`,
            })),
        ];
    }, [current]);

/** The hours the library may work flat out (§7c). On the Stages tab, beside what it slows. */
export const QuietHoursCard: React.FC = () => {
    const { data } = useAdminSettings();
    const save = useSaveAdminSettings();
    const { draft: throttle, set, dirty, reset } = useSettingsDraft(data?.settings.throttle);
    const timeZoneOptions = useTimeZoneOptions(throttle?.timeZone ?? null);
    // The clock the hours are read on, beside them -- it is most needed before the feature is
    // switched on, by whoever is deciding which hours to type in.
    const { data: status } = useProcessingStatus();

    return (
        <Card p="md">
            <Stack gap="md">
                <Stack gap={2}>
                    <Group justify="space-between" wrap="wrap" gap="xs">
                        <Title order={4}>Quiet hours</Title>
                        {status && <ServerClock clock={status.serverClock} />}
                    </Group>
                    <Text size="sm" c="dimmed">
                        Outside the window the library keeps working, slowly enough to leave the
                        machine usable. Anything you ask for by hand runs at full speed.
                    </Text>
                </Stack>

                <Switch
                    label="Limit background processing outside a set window"
                    checked={throttle?.enabled ?? false}
                    onChange={(event) =>
                        throttle && set({ ...throttle, enabled: event.currentTarget.checked })
                    }
                />

                {throttle?.enabled && (
                    <>
                        {/* Above the hours, because it is what makes them mean anything. */}
                        <Select
                            label="Time zone the hours are read in"
                            description="Daylight saving is followed automatically."
                            searchable
                            nothingFoundMessage="No zone by that name"
                            limit={50}
                            data={timeZoneOptions}
                            value={throttle.timeZone ?? HOST_ZONE}
                            onChange={(value) =>
                                set({ ...throttle, timeZone: value === HOST_ZONE ? null : value })
                            }
                        />

                        <Group grow>
                            <NumberInput
                                label="Full speed from"
                                description="Hour of the day, 0–23"
                                min={0}
                                max={23}
                                value={throttle.startHour}
                                onChange={(value) =>
                                    set({
                                        ...throttle,
                                        startHour: typeof value === "number" ? value : 2,
                                    })
                                }
                            />
                            <NumberInput
                                label="Until"
                                description="Exclusive, so 2 to 8 is six hours"
                                min={0}
                                max={23}
                                value={throttle.endHour}
                                onChange={(value) =>
                                    set({
                                        ...throttle,
                                        endHour: typeof value === "number" ? value : 8,
                                    })
                                }
                            />
                        </Group>

                        {/* The only lever that actually caps a transcode: that job runs one at
                            a time at every hour, so there is no concurrency to reduce. */}
                        <Stack gap={4}>
                            <Text size="sm" fw={500}>
                                Encoder cores outside the window
                            </Text>
                            <Slider
                                min={0.1}
                                max={1}
                                step={0.1}
                                value={throttle.threadShare}
                                onChange={(value) => set({ ...throttle, threadShare: value })}
                                marks={[
                                    { value: 0.25, label: "¼" },
                                    { value: 0.5, label: "half" },
                                    { value: 1, label: edgeLabel("all", "end") },
                                ]}
                            />
                            <Text size="xs" c="dimmed" mt="xs">
                                Lower means encodes take longer and leave more for everything else;
                                the finished file looks the same.
                            </Text>
                        </Stack>
                    </>
                )}

                <SaveRow
                    onSave={() => throttle && save.mutate({ throttle }, { onSuccess: reset })}
                    saving={save.isPending}
                    dirty={dirty}
                />
            </Stack>
        </Card>
    );
};
