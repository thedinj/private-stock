"use client";

import { Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import type { MediaDetail } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * An item's file name, whole, and the folder it is in, dimmed below (§5f): what a preview of an
 * item names it by. The title can be a scraped one, and the file name is often where a performer
 * or a studio is written. Read from the item's detail, asked for only when this is drawn — inside a
 * closer look or a tooltip, once somebody opens one.
 */
export const FileName: React.FC<{ mediaId: string }> = ({ mediaId }) => {
    const { data } = useQuery({
        queryKey: queryKeys.media.detail(mediaId),
        queryFn: () => api<MediaDetail>(`/api/media/${encodeURIComponent(mediaId)}`),
    });

    if (!data) {
        return (
            <Text size="xs" c="dimmed">
                …
            </Text>
        );
    }

    const parts = data.relPath.split(/[\\/]/);
    const file = parts.pop() ?? data.relPath;

    return (
        <Stack gap={0}>
            <Text size="xs" style={{ overflowWrap: "anywhere" }}>
                {file}
            </Text>
            <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                {[data.rootLabel, ...parts].join(" / ")}
            </Text>
        </Stack>
    );
};
