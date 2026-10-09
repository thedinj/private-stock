"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
    Alert,
    Button,
    Card,
    Group,
    Modal,
    NumberInput,
    Select,
    Stack,
    Switch,
    Text,
    Title,
} from "@mantine/core";

import { transcodeEnabled, type AdminSettings, type HwaccelProbeResult } from "@private-stock/core";

import { useAdminSettings, useSaveAdminSettings, useSettingsDraft } from "@/lib/api/adminSettings";
import { api } from "@/lib/api/client";

import { SaveRow } from "./SaveRow";

type Transcode = AdminSettings["transcode"];

/** Background web-safe copies for files a browser cannot play (§7). The Transcoding tab. */
export const TranscodingCard: React.FC = () => {
    const { data } = useAdminSettings();
    const save = useSaveAdminSettings();
    const { draft: transcode, set, dirty, reset } = useSettingsDraft(data?.settings.transcode);
    const [confirmingDisable, setConfirmingDisable] = useState(false);
    const policy = data?.settings.stagePolicy ?? {};
    const enabled = transcodeEnabled(policy);

    /**
     * On or off: transcoding's entry in the stage policy (§7b), saved at once like every other
     * stage switch rather than with the encoder settings below it. Switching off asks first,
     * because it deletes every converted copy -- hours of this machine's time to remake.
     */
    const setEnabled = (next: boolean) =>
        save.mutate({ stagePolicy: { ...policy, transcode: next } });

    /**
     * The hwaccel probe. A mutation rather than a query because it spawns ffmpeg: it runs when
     * asked and never on mount, refocus or retry, and `probe.reset()` on a dropdown change stops
     * an answer outliving the value it was about.
     */
    const probe = useMutation({
        mutationFn: (hwaccel: Transcode["hwaccel"]) =>
            api<HwaccelProbeResult>("/api/admin/transcode/probe", {
                method: "POST",
                body: JSON.stringify({ hwaccel }),
            }),
        retry: false,
    });

    const commit = () => transcode && save.mutate({ transcode }, { onSuccess: reset });

    const patch = (next: Partial<Transcode>) => transcode && set({ ...transcode, ...next });

    return (
        <Card p="md">
            <Stack gap="md">
                <Group justify="space-between" wrap="wrap" gap="sm" align="flex-start">
                    <Stack gap={2}>
                        <Title order={4}>Transcoding</Title>
                        <Text size="sm" c="dimmed">
                            Web-safe copies of files a browser cannot play. Originals are never
                            re-encoded.
                        </Text>
                    </Stack>
                    <Switch
                        label="Transcode in the background"
                        description={
                            enabled
                                ? undefined
                                : "Costs processor time and a second copy of each converted file"
                        }
                        checked={enabled}
                        disabled={!data || save.isPending}
                        onChange={(event) =>
                            event.currentTarget.checked
                                ? setEnabled(true)
                                : setConfirmingDisable(true)
                        }
                    />
                </Group>

                <NumberInput
                    label="Keep converted copies for (days)"
                    description="Unwatched copies are deleted and remade on demand. 0 keeps them."
                    min={0}
                    max={365}
                    w={{ base: "100%", xs: 260 }}
                    value={transcode?.retentionDays ?? 7}
                    onChange={(value) =>
                        patch({ retentionDays: typeof value === "number" ? value : 7 })
                    }
                />

                <Group grow align="flex-start">
                    <Stack gap="xs">
                        <Select
                            label="Hardware acceleration"
                            description="Not checked on save — test it"
                            data={["none", "vaapi", "qsv", "nvenc"]}
                            value={transcode?.hwaccel ?? "none"}
                            onChange={(value) => {
                                if (!value) return;
                                // A result describes the mode it was run for.
                                probe.reset();
                                patch({ hwaccel: value as Transcode["hwaccel"] });
                            }}
                        />

                        <Group gap="xs" align="center">
                            <Button
                                variant="default"
                                size="xs"
                                loading={probe.isPending}
                                onClick={() => transcode && probe.mutate(transcode.hwaccel)}
                            >
                                Test
                            </Button>
                            {probe.isPending && (
                                <Text size="xs" c="dimmed">
                                    Encoding a one-second test clip…
                                </Text>
                            )}
                        </Group>

                        {probe.data && (
                            <Alert
                                color={probe.data.ok ? "brass" : "oxblood"}
                                variant="light"
                                title={
                                    probe.data.ok
                                        ? `${probe.data.encoder} works here`
                                        : `${probe.data.encoder} is not usable here`
                                }
                            >
                                <Text size="xs">{probe.data.detail}</Text>
                                {!probe.data.ok && (
                                    <Text size="xs" mt={4}>
                                        Jobs would fail with this setting. Leave it on{" "}
                                        <strong>none</strong> unless a test passes.
                                    </Text>
                                )}
                            </Alert>
                        )}
                    </Stack>

                    <NumberInput
                        label="Maximum height"
                        description="Never upscaled"
                        min={240}
                        max={2160}
                        step={120}
                        value={transcode?.maxHeight ?? 1080}
                        onChange={(value) =>
                            patch({ maxHeight: typeof value === "number" ? value : 1080 })
                        }
                    />
                </Group>

                {/* Bottom-aligned: the two descriptions wrap to different heights on a phone. */}
                <Group grow align="flex-end">
                    <NumberInput
                        label="Quality (CRF)"
                        description="Lower is better and larger. Software only."
                        min={14}
                        max={35}
                        value={transcode?.crf ?? 21}
                        onChange={(value) => patch({ crf: typeof value === "number" ? value : 21 })}
                    />
                    <Select
                        label="Preset"
                        description="Slower is smaller, and much more CPU"
                        data={[
                            "ultrafast",
                            "superfast",
                            "veryfast",
                            "faster",
                            "fast",
                            "medium",
                            "slow",
                        ]}
                        value={transcode?.preset ?? "veryfast"}
                        onChange={(value) =>
                            value && patch({ preset: value as Transcode["preset"] })
                        }
                    />
                </Group>

                {transcode?.hwaccel !== "none" && (
                    <NumberInput
                        label="Hardware bitrate (kbps)"
                        description="Hardware encoders take a bitrate rather than a quality"
                        min={500}
                        max={20_000}
                        step={500}
                        w={{ base: "100%", xs: 260 }}
                        value={transcode?.hwBitrateKbps ?? 4_000}
                        onChange={(value) =>
                            patch({ hwBitrateKbps: typeof value === "number" ? value : 4_000 })
                        }
                    />
                )}

                <SaveRow
                    onSave={commit}
                    saving={save.isPending}
                    dirty={dirty}
                    note="Applies to work queued from now on."
                />
            </Stack>

            <Modal
                opened={confirmingDisable}
                onClose={() => setConfirmingDisable(false)}
                title="Switch off transcoding?"
                centered
            >
                <Stack gap="md">
                    <Text size="sm">
                        Every converted copy will be deleted and any conversion in progress stopped.
                        Files that need one will say they cannot be played.
                    </Text>
                    <Text size="sm" c="dimmed">
                        Nothing in your library is touched — only the copies this app made. Turning
                        it back on converts them again, which takes as long as it did the first
                        time.
                    </Text>
                    <Group justify="flex-end" gap="sm">
                        <Button
                            variant="subtle"
                            color="gray"
                            onClick={() => setConfirmingDisable(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            color="oxblood"
                            loading={save.isPending}
                            onClick={() => {
                                setEnabled(false);
                                setConfirmingDisable(false);
                            }}
                        >
                            Switch off and delete
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Card>
    );
};
