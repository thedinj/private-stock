"use client";

import { Button, Group, Paper, Stack, Text, UnstyledButton } from "@mantine/core";

import type { ItemSuspect, MentionField } from "@private-stock/core";

import { SectionLabel } from "@/components/media/SectionLabel";
import { useDecideItemSuspect, useItemSuspects } from "@/lib/api/faces";
import { formatTimecode } from "@/lib/timecode";

import { FaceCropView } from "./FaceCropView";

const FIELD_WORDS: Record<MentionField, string> = {
    filename: "filename",
    title: "title",
    screen: "on screen",
};

const why = (suspect: ItemSuspect): string =>
    [
        suspect.strongFaces >= 2
            ? `${suspect.strongFaces} moments look like them`
            : suspect.face
              ? "a face looks like them"
              : null,
        suspect.mentions.length > 0
            ? `named in the ${suspect.mentions.map((field) => FIELD_WORDS[field]).join(", ")}`
            : null,
    ]
        .filter(Boolean)
        .join(" · ");

const SuspectCard: React.FC<{
    mediaId: string;
    suspect: ItemSuspect;
    onSeek: (atMs: number) => void;
}> = ({ mediaId, suspect, onSeek }) => {
    const decide = useDecideItemSuspect(mediaId);
    const pending = (verdict: "add" | "refuse"): boolean =>
        decide.isPending && decide.variables?.verdict === verdict;
    const atMs = suspect.face?.kind === "video" ? suspect.face.atMs : null;

    return (
        <Paper withBorder radius="md" p="xs">
            <Group gap="sm" wrap="nowrap" align="center">
                {suspect.face &&
                    (atMs !== null ? (
                        <UnstyledButton
                            onClick={() => onSeek(atMs)}
                            aria-label={`Go to ${formatTimecode(atMs)}, where this face is`}
                            title={`Go to ${formatTimecode(atMs)}`}
                        >
                            <FaceCropView crop={suspect.face.crop} size={56} />
                        </UnstyledButton>
                    ) : (
                        <FaceCropView crop={suspect.face.crop} size={56} />
                    ))}
                <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" fw={600} truncate>
                        {suspect.name}?
                    </Text>
                    <Text size="xs" c="dimmed">
                        {why(suspect)}
                        {atMs !== null && ` · at ${formatTimecode(atMs)}`}
                    </Text>
                    <Group gap="xs" mt={4}>
                        <Button
                            size="compact-sm"
                            color="brass"
                            variant="light"
                            disabled={decide.isPending}
                            loading={pending("add")}
                            onClick={() =>
                                decide.mutate({
                                    tagId: suspect.tagId,
                                    verdict: "add",
                                    faceId: suspect.face?.id ?? null,
                                })
                            }
                        >
                            Add
                        </Button>
                        <Button
                            size="compact-sm"
                            variant="default"
                            disabled={decide.isPending}
                            loading={pending("refuse")}
                            onClick={() =>
                                decide.mutate({
                                    tagId: suspect.tagId,
                                    verdict: "refuse",
                                    faceId: null,
                                })
                            }
                        >
                            Not them
                        </Button>
                    </Group>
                </Stack>
            </Group>
        </Paper>
    );
};

/**
 * "Maybe in this item" (§5f "In the viewer"): library performers the item does not carry whose face
 * looks like one in it, or whose name it shows — each with the face, which goes to its moment, and
 * "Add" or "Not them". Opening an item becomes a chance to tag it. Nothing shown when there is
 * nobody to suggest.
 */
export const SuspectsPanel: React.FC<{ mediaId: string; onSeek: (atMs: number) => void }> = ({
    mediaId,
    onSeek,
}) => {
    const { data } = useItemSuspects(mediaId, true);

    if (!data || data.suspects.length === 0) return null;

    return (
        <Stack gap="xs">
            <SectionLabel>Maybe in this item</SectionLabel>
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                    gap: "var(--mantine-spacing-sm)",
                }}
            >
                {data.suspects.map((suspect) => (
                    <SuspectCard
                        key={suspect.tagId}
                        mediaId={mediaId}
                        suspect={suspect}
                        onSeek={onSeek}
                    />
                ))}
            </div>
        </Stack>
    );
};
