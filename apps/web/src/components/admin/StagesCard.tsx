"use client";

import Link from "next/link";
import { Anchor, Badge, Card, Group, Stack, Text, Title, Tooltip } from "@mantine/core";

import { transcodeEnabled } from "@private-stock/core";

import { useAdminSettings } from "@/lib/api/adminSettings";

import { StageSwitch } from "./StageSwitch";

/**
 * Stages that have a tab of their own on the Processing page.
 *
 * Their switch lives there, at the top of the rest of their configuration, so the list here
 * says whether they are on and points across rather than offering a second switch.
 */
const CONFIGURED_ELSEWHERE: Record<string, { href: string; label: string }> = {
    ocr: { href: "/admin/processing?tab=ocr", label: "OCR settings" },
};

/** What runs across the whole library (§7b): one row per stage in the registry. */
export const StagesCard: React.FC = () => {
    const { data } = useAdminSettings();

    return (
        <Card p="md">
            <Stack gap="md">
                <Stack gap={2}>
                    <Title order={4}>Stages</Title>
                    <Text size="sm" c="dimmed">
                        What runs across the whole library. A stage switched off can still be run on
                        one item from its page.
                    </Text>
                </Stack>

                <Stack gap="xs">
                    {data?.stages.map((stage) => {
                        const elsewhere = CONFIGURED_ELSEWHERE[stage.name];

                        return (
                            <Group key={stage.name} justify="space-between" wrap="nowrap">
                                <Stack gap={0} style={{ minWidth: 0 }}>
                                    <Group gap="xs">
                                        <Text size="sm" fw={500}>
                                            {stage.name}
                                        </Text>
                                        {stage.mode === "optIn" && (
                                            <Tooltip label="Expensive, so it stays off until you turn it on">
                                                <Badge size="xs" variant="light" color="brass">
                                                    opt-in
                                                </Badge>
                                            </Tooltip>
                                        )}
                                        {stage.mode === "perItem" && (
                                            <Tooltip label="Only ever run on a single item, from that item's page">
                                                <Badge size="xs" variant="light" color="gray">
                                                    per item only
                                                </Badge>
                                            </Tooltip>
                                        )}
                                    </Group>
                                    <Text size="xs" c="dimmed">
                                        {stage.describe}
                                    </Text>
                                    {/* The size of the commitment, where there is one to make.
                                        Absent once a stage runs: a number that only counts
                                        down is progress, which is the Activity tab's. */}
                                    {stage.pending !== null && stage.pending > 0 && (
                                        <Text size="xs" c="brass.4">
                                            {stage.pending.toLocaleString()}{" "}
                                            {stage.pending === 1 ? "item" : "items"} waiting
                                        </Text>
                                    )}
                                </Stack>

                                {elsewhere ? (
                                    <Group gap="xs" wrap="nowrap">
                                        <Text size="xs" c="dimmed">
                                            {stage.enabled ? "On" : "Off"}
                                        </Text>
                                        <Anchor component={Link} href={elsewhere.href} size="xs">
                                            {elsewhere.label} →
                                        </Anchor>
                                    </Group>
                                ) : (
                                    // A per-item stage has no sweep to switch, so no switch.
                                    stage.mode !== "perItem" && <StageSwitch stage={stage} />
                                )}
                            </Group>
                        );
                    })}

                    {/* Transcoding is not a registry stage -- it has its own job and its own
                        backfill -- but whether it runs is the same decision, stored in the same
                        policy (§7b, §8), so it is listed with the rest. Its switch is on its tab,
                        beside what it costs. */}
                    {data && (
                        <Group justify="space-between" wrap="nowrap">
                            <Stack gap={0} style={{ minWidth: 0 }}>
                                <Group gap="xs">
                                    <Text size="sm" fw={500}>
                                        transcode
                                    </Text>
                                    <Tooltip label="Expensive, so it stays off until you turn it on">
                                        <Badge size="xs" variant="light" color="brass">
                                            opt-in
                                        </Badge>
                                    </Tooltip>
                                </Group>
                                <Text size="xs" c="dimmed">
                                    Web-safe copies of files a browser cannot play
                                </Text>
                            </Stack>
                            <Group gap="xs" wrap="nowrap">
                                <Text size="xs" c="dimmed">
                                    {transcodeEnabled(data.settings.stagePolicy) ? "On" : "Off"}
                                </Text>
                                <Anchor
                                    component={Link}
                                    href="/admin/processing?tab=transcoding"
                                    size="xs"
                                >
                                    Transcoding settings →
                                </Anchor>
                            </Group>
                        </Group>
                    )}
                </Stack>

                <Text size="xs" c="dimmed">
                    Switching one back on queues the work gradually; nothing that already succeeded
                    is redone.
                </Text>
            </Stack>
        </Card>
    );
};
