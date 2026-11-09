"use client";

import Link from "next/link";
import { Group, Text } from "@mantine/core";

import classes from "./KindCounts.module.scss";

/**
 * "34 videos · 212 photos", each half a way straight into the grid of just those.
 *
 * The shortest path to what somebody came to a person's row for. A kind with none is left
 * out rather than shown as "0 photos": it cannot be clicked into, and it is not news.
 */

interface KindCountsProps {
    tagId: string;
    videoCount: number;
    imageCount: number;
    /** Your clips carrying it (§14e): a way into the Clips tab, after the items. */
    clipCount?: number;
    size?: "sm" | "lg";
}

const plural = (count: number, one: string, many: string): string =>
    `${count.toLocaleString()} ${count === 1 ? one : many}`;

export const KindCounts: React.FC<KindCountsProps> = ({
    tagId,
    videoCount,
    imageCount,
    clipCount = 0,
    size = "sm",
}) => {
    const href = (kind: "video" | "image" | "clip") =>
        `/?view=grid&tags=${encodeURIComponent(tagId)}&kind=${kind}`;

    const parts = [
        videoCount > 0 && (
            <Link key="video" href={href("video")} className={classes.count} data-size={size}>
                {plural(videoCount, "video", "videos")}
            </Link>
        ),
        imageCount > 0 && (
            <Link key="image" href={href("image")} className={classes.count} data-size={size}>
                {plural(imageCount, "photo", "photos")}
            </Link>
        ),
        clipCount > 0 && (
            <Link key="clip" href={href("clip")} className={classes.count} data-size={size}>
                {plural(clipCount, "clip", "clips")}
            </Link>
        ),
    ].filter(Boolean);

    return (
        <Group gap={8} wrap="wrap" className={classes.counts}>
            {parts.map((part, index) => (
                <Group key={index} gap={8} wrap="nowrap">
                    {index > 0 && (
                        <Text span c="dimmed" size="xs" aria-hidden>
                            ·
                        </Text>
                    )}
                    {part}
                </Group>
            ))}
        </Group>
    );
};
