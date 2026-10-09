"use client";

import { Group, NumberInput, Slider, Stack, Text } from "@mantine/core";

import { PHASH_MAX_INDEXED_DISTANCE } from "@private-stock/core";

import { useAdminSettings, useSaveAdminSettings, useSettingsDraft } from "@/lib/api/adminSettings";

import { edgeLabel } from "./edgeLabel";
import { SaveRow } from "./SaveRow";

/**
 * How alike two files must be to be offered for review (§10c).
 *
 * In the Duplicates queue's Rules drawer, beside the groups these numbers produce, rather than
 * on a settings page several clicks from them.
 */
export const DupeRulesForm: React.FC = () => {
    const { data } = useAdminSettings();
    const save = useSaveAdminSettings();
    const { draft: dupes, set, dirty, reset } = useSettingsDraft(data?.settings.dupes);

    return (
        <Stack gap="md">
            <Stack gap={4}>
                <Text size="sm" fw={500}>
                    Image similarity
                </Text>
                <Text size="xs" c="dimmed">
                    Bits two pictures may differ by. Higher finds more, and more of it is wrong.
                </Text>
                <Slider
                    min={0}
                    max={PHASH_MAX_INDEXED_DISTANCE}
                    step={1}
                    marks={[
                        { value: 0, label: edgeLabel("identical", "start") },
                        {
                            value: PHASH_MAX_INDEXED_DISTANCE,
                            label: edgeLabel("loose", "end"),
                        },
                    ]}
                    value={dupes?.imageDistance ?? 4}
                    onChange={(value) => dupes && set({ ...dupes, imageDistance: value })}
                    mb="lg"
                />
            </Stack>

            {/* Bottom-aligned, so the two boxes share a line however their labels wrap. */}
            <Group grow align="flex-end">
                <NumberInput
                    label="Video frame distance"
                    description="Bits two frames may differ by"
                    min={0}
                    max={PHASH_MAX_INDEXED_DISTANCE}
                    value={dupes?.frameDistance ?? 4}
                    onChange={(value) =>
                        dupes &&
                        set({ ...dupes, frameDistance: typeof value === "number" ? value : 4 })
                    }
                />
                <NumberInput
                    label="Minimum matching frames"
                    description="Below this, a pair is not shown"
                    min={1}
                    value={dupes?.minMatchingFrames ?? 3}
                    onChange={(value) =>
                        dupes &&
                        set({
                            ...dupes,
                            minMatchingFrames: typeof value === "number" ? value : 3,
                        })
                    }
                />
            </Group>

            <NumberInput
                label="Frame match ratio"
                description="Share of the shorter video's frames that must pair, 0.1 to 1"
                min={0.1}
                max={1}
                step={0.05}
                decimalScale={2}
                value={dupes?.videoFrameRatio ?? 0.6}
                onChange={(value) =>
                    dupes &&
                    set({ ...dupes, videoFrameRatio: typeof value === "number" ? value : 0.6 })
                }
            />

            <SaveRow
                onSave={() => dupes && save.mutate({ dupes }, { onSuccess: reset })}
                saving={save.isPending}
                dirty={dirty}
                note="Used by the next check; existing groups stay until then."
            />
        </Stack>
    );
};
