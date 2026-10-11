"use client";

import { Group, Stack, Text } from "@mantine/core";

import { useFaceComparison } from "@/lib/api/faces";

import { FaceCropView } from "./FaceCropView";

/** How many of their items' faces are set beside the one asked about. */
const SHOWN = 4;

/**
 * A performer's face from a few of their other items, under one that may be them (§5f
 * "Suggestions"): the faces confirmed as them, or — none confirmed yet — the people most like
 * them on items tagged with them, which says so. Asked for when the closer look opens, once a
 * performer.
 */
export const FaceComparisonRow: React.FC<{
    tagId: string;
    name: string;
    /** The item being asked about, left out. */
    mediaId: string;
}> = ({ tagId, name, mediaId }) => {
    const { data, isPending } = useFaceComparison(tagId);
    const faces = (data?.faces ?? []).filter((face) => face.mediaId !== mediaId).slice(0, SHOWN);

    return (
        <Stack gap={4}>
            <Text size="xs" c="dimmed">
                {isPending
                    ? `${name} in other items…`
                    : faces.length === 0
                      ? `No face of ${name}'s from another item to compare with yet.`
                      : data?.confirmed
                        ? `${name} in other items`
                        : `${name} in other items — not confirmed: the people most like them where they are tagged`}
            </Text>
            {faces.length > 0 && (
                <Group gap={6}>
                    {faces.map((face) => (
                        <FaceCropView key={face.id} crop={face.crop} size={64} />
                    ))}
                </Group>
            )}
        </Stack>
    );
};
