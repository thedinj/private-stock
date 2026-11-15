"use client";

import { useState } from "react";
import {
    ActionIcon,
    Alert,
    Button,
    Code,
    Group,
    Modal,
    Select,
    Stack,
    Table,
    Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useMutation } from "@tanstack/react-query";

import {
    formatFrameRate,
    frameRateKey,
    parseFrameRateKey,
    type ReelExportWarning,
} from "@private-stock/core";

import { CloseGlyph } from "@/components/media/Glyph";
import { downloadFile } from "@/lib/api/client";
import { useReelExportPreview } from "@/lib/api/reels";

/**
 * Taking a reel -- or the export cart's reels, a timeline each in one file -- to Resolve (§14d
 * "Editor export").
 *
 * One decision -- the timeline's frame rate -- made knowing what it will do: the reel's watching
 * time at each source rate is laid out beside the choice, and the rate covering the most of it
 * is picked already, since that is the footage that would otherwise be conformed. Anything that
 * will go wrong in Resolve is said here, named, before the file exists.
 */

/** Each warning as a sentence about `n` clips, so the verb agrees with the count. */
const WARNING_TEXT: Record<ReelExportWarning["kind"], (n: number) => string> = {
    mpegts: (n) =>
        `${n === 1 ? "1 clip is" : `${n} clips are`} from MPEG-TS (.ts) files. Resolve may not open these; remux them to MP4 if they come in offline.`,
    vfr: (n) =>
        `${n === 1 ? "1 clip is" : `${n} clips are`} from variable-frame-rate files, usually phones. Resolve conforms them, so a cut can land a frame from where it is here.`,
    inferredRate: (n) =>
        `${n === 1 ? "1 clip is" : `${n} clips are`} from files scanned before exact frame rates were recorded. The rate is read from a rounded value, which is right for standard rates and approximate for odd ones.`,
};

const percent = (part: number, whole: number): string =>
    whole === 0 ? "" : `${Math.round((part / whole) * 100)}%`;

/**
 * One frame rate for every timeline in the file: the reels of one export are going into one
 * project, which an editor conforms to one rate anyway, so the choice is made once across all
 * of their footage.
 */
export const ReelExportDialog: React.FC<{
    reelIds: string[];
    opened: boolean;
    onClose: () => void;
    /** From the cart: each reel can be taken out here. */
    onRemove?: (reelId: string) => void;
    onExported?: () => void;
}> = ({ reelIds, opened, onClose, onRemove, onExported }) => {
    const narrow = useMediaQuery("(max-width: 48em)") ?? false;
    const preview = useReelExportPreview(reelIds, opened);
    const several = reelIds.length > 1 || onRemove !== undefined;

    /** The rate somebody chose, or null while the recommendation stands. */
    const [picked, setPicked] = useState<string | null>(null);
    const data = preview.data;
    const rateKey = picked ?? (data ? frameRateKey(data.recommended) : null);

    const download = useMutation({
        mutationFn: (key: string) =>
            downloadFile(
                `/api/reels/export?ids=${encodeURIComponent(reelIds.join(","))}&rate=${encodeURIComponent(key)}`,
                "Timeline.fcpxml"
            ),
        onSuccess: () => {
            onExported?.();
            close();
        },
    });

    const close = () => {
        download.reset();
        setPicked(null);
        onClose();
    };

    const totalRunMs = data?.rates.reduce((sum, share) => sum + share.runMs, 0) ?? 0;
    const exported = data?.reels.filter((reel) => reel.clipCount > 0) ?? [];
    /** Asked for but not returned: deleted, or no longer shared, since it went in the cart. */
    const gone = data ? reelIds.length - data.reels.length : 0;
    const missing = data?.libraries.filter((library) => !library.networkPath) ?? [];

    return (
        <Modal
            opened={opened}
            onClose={close}
            title="Export for Resolve"
            centered
            fullScreen={narrow}
            size="lg"
        >
            {!data ? (
                preview.isError ? (
                    <Alert color="oxblood">
                        Couldn’t read the {several ? "reels" : "reel"}: {preview.error.message}
                    </Alert>
                ) : (
                    <Text size="sm" c="dimmed">
                        Reading the {several ? "reels" : "reel"}…
                    </Text>
                )
            ) : (
                <Stack gap="md">
                    {several ? (
                        <Text size="sm">
                            {exported.length} timeline{exported.length === 1 ? "" : "s"} in one
                            file, all at one frame rate, linking to the original files on the share.
                            In Resolve, File → Import → Timeline brings in one at a time: import the
                            file once per reel and pick each by name from the list.
                        </Text>
                    ) : (
                        <Text size="sm">
                            A timeline of {data.clipCount} clip{data.clipCount === 1 ? "" : "s"}{" "}
                            that links to the original files on the share. In Resolve: File → Import
                            → Timeline.
                        </Text>
                    )}

                    {several && (
                        <Stack gap={0}>
                            {data.reels.map((reel) => (
                                <Group
                                    key={reel.id}
                                    justify="space-between"
                                    wrap="nowrap"
                                    gap="xs"
                                    mih={44}
                                >
                                    <Stack gap={0} style={{ minWidth: 0 }}>
                                        <Text size="sm" lineClamp={1}>
                                            {reel.name}
                                        </Text>
                                        <Text size="xs" c="dimmed">
                                            {reel.clipCount === 0
                                                ? "No clips you can open — left out"
                                                : `${reel.clipCount} clip${reel.clipCount === 1 ? "" : "s"}`}
                                        </Text>
                                    </Stack>
                                    {onRemove && (
                                        <ActionIcon
                                            variant="subtle"
                                            color="gray"
                                            size={44}
                                            aria-label={`Take ${reel.name} out of the export`}
                                            onClick={() => onRemove(reel.id)}
                                        >
                                            <CloseGlyph size={16} />
                                        </ActionIcon>
                                    )}
                                </Group>
                            ))}
                            {gone > 0 && (
                                <Text size="xs" c="dimmed" mt="xs">
                                    {gone === 1 ? "1 reel is" : `${gone} reels are`} no longer there
                                    for you and {gone === 1 ? "is" : "are"} left out.
                                </Text>
                            )}
                        </Stack>
                    )}

                    {data.unreachableCount > 0 && (
                        <Text size="sm" c="dimmed">
                            {data.unreachableCount} clip
                            {data.unreachableCount === 1 ? " is" : "s are"} in libraries you can’t
                            open and won’t be in the timeline.
                        </Text>
                    )}

                    {data.rates.length > 0 && (
                        <Table withTableBorder={false} verticalSpacing={4} fz="sm">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>Source rate</Table.Th>
                                    <Table.Th ta="right">Clips</Table.Th>
                                    <Table.Th ta="right">
                                        {several ? "Of the reels" : "Of the reel"}
                                    </Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {data.rates.map((share) => (
                                    <Table.Tr key={frameRateKey(share.rate)}>
                                        <Table.Td>{formatFrameRate(share.rate)} fps</Table.Td>
                                        <Table.Td ta="right">{share.clipCount}</Table.Td>
                                        <Table.Td ta="right">
                                            {percent(share.runMs, totalRunMs)}
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    )}

                    <Select
                        label="Timeline frame rate"
                        description="Clips at other rates are conformed by Resolve."
                        data={data.options.map((rate) => {
                            const key = frameRateKey(rate);

                            return {
                                value: key,
                                label:
                                    key === frameRateKey(data.recommended)
                                        ? `${formatFrameRate(rate)} fps (recommended)`
                                        : `${formatFrameRate(rate)} fps`,
                            };
                        })}
                        value={rateKey}
                        onChange={(value) =>
                            setPicked(value && parseFrameRateKey(value) ? value : null)
                        }
                        allowDeselect={false}
                        comboboxProps={{ withinPortal: true }}
                    />

                    {data.warnings.map((warning) => (
                        <Alert key={warning.kind} color="brass" variant="light">
                            <Text size="sm">{WARNING_TEXT[warning.kind](warning.clipCount)}</Text>
                            <Text size="xs" c="dimmed" mt={4}>
                                {warning.files.join(", ")}
                                {warning.clipCount > warning.files.length ? ", …" : ""}
                            </Text>
                            {several && (
                                <Text size="xs" c="dimmed">
                                    In {warning.reels.join(", ")}
                                </Text>
                            )}
                        </Alert>
                    ))}

                    {missing.length > 0 ? (
                        <Alert color="oxblood" variant="light">
                            <Text size="sm">
                                Resolve won’t find the files until{" "}
                                {missing.map((library) => `“${library.label}”`).join(", ")}{" "}
                                {missing.length === 1 ? "has" : "have"} a network path. An
                                administrator sets it in Admin → Libraries, under Rename.
                            </Text>
                        </Alert>
                    ) : (
                        data.samplePath && (
                            <Stack gap={4}>
                                <Text size="xs" c="dimmed">
                                    Resolve will look for files like
                                </Text>
                                <Code
                                    block
                                    style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}
                                >
                                    {data.samplePath}
                                </Code>
                            </Stack>
                        )
                    )}

                    {download.isError && (
                        <Alert color="oxblood">Export failed: {download.error.message}</Alert>
                    )}

                    <Group justify="flex-end" gap="sm">
                        <Button variant="default" onClick={close} mih={44}>
                            Cancel
                        </Button>
                        <Button
                            mih={44}
                            disabled={missing.length > 0 || data.clipCount === 0 || !rateKey}
                            loading={download.isPending}
                            onClick={() => rateKey && download.mutate(rateKey)}
                        >
                            {exported.length > 1 ? "Download timelines" : "Download timeline"}
                        </Button>
                    </Group>
                </Stack>
            )}
        </Modal>
    );
};
