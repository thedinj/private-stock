"use client";

import { useState } from "react";
import { Button, Group, Modal, Stack, Switch, Text } from "@mantine/core";

import type { StageSetting } from "@private-stock/core";

import { useAdminSettings, useSaveAdminSettings } from "@/lib/api/adminSettings";

/**
 * Whether one stage runs across the whole library (§7b).
 *
 * Its own component because the switch is in two places that must behave identically: the
 * Stages tab, and the top of the OCR tab, where OCR's switch now sits beside the rest of its
 * configuration. Both write `stages.policy` through the same patch, so there is still one writer.
 *
 * Turning an opt-in stage on commits the whole library to it, so it asks first and says how many
 * items that is. Everything else applies at once: switching a stage off costs nothing and is undone
 * by switching it back on.
 */
export const StageSwitch: React.FC<{ stage: StageSetting; label?: React.ReactNode }> = ({
    stage,
    label,
}) => {
    const { data } = useAdminSettings();
    const save = useSaveAdminSettings();
    const [confirming, setConfirming] = useState(false);

    /**
     * Only the deviations are stored (§7b), so this writes one key rather than rebuilding the
     * set. A stage switched back to its default stays an explicit entry: "I decided this" and "I
     * never said" are different states.
     */
    const toggle = (enabled: boolean) =>
        save.mutate({
            stagePolicy: { ...(data?.settings.stagePolicy ?? {}), [stage.name]: enabled },
        });

    return (
        <>
            <Switch
                label={label}
                checked={stage.enabled}
                disabled={save.isPending}
                onChange={(event) => {
                    const enabled = event.currentTarget.checked;

                    if (enabled && stage.mode === "optIn") {
                        setConfirming(true);
                        return;
                    }

                    toggle(enabled);
                }}
            />

            <Modal
                opened={confirming}
                onClose={() => setConfirming(false)}
                title={`Run ${stage.name} across the whole library?`}
                centered
            >
                <Stack gap="md">
                    <Text size="sm">
                        {stage.describe}.{" "}
                        {stage.pending
                            ? `${stage.pending.toLocaleString()} ${
                                  stage.pending === 1 ? "item needs" : "items need"
                              } it.`
                            : "Nothing is outstanding right now."}
                    </Text>
                    {/* What they are agreeing to: a queue that drains over days inside the hours
                        already chosen, not a button that finishes. */}
                    <Text size="sm" c="dimmed">
                        It runs at the lowest priority, inside your quiet hours. Switching it off
                        again stops new work; anything finished is kept.
                    </Text>

                    <Group justify="flex-end" gap="sm">
                        <Button variant="subtle" color="gray" onClick={() => setConfirming(false)}>
                            Cancel
                        </Button>
                        <Button
                            color="brass"
                            loading={save.isPending}
                            onClick={() => {
                                toggle(true);
                                setConfirming(false);
                            }}
                        >
                            Turn it on
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
};
