"use client";

import { Text } from "@mantine/core";

import type { ClipTag } from "@private-stock/core";

/**
 * A clip's tags as one clamped line of names, for a card (§14d "Tagging clips").
 *
 * Words rather than pills: the cards are narrow and already carry the name and the source, and a
 * row of pills would wrap into a second line on every card that had more than two.
 */
export const ClipTagLine: React.FC<{ tags: ClipTag[] }> = ({ tags }) =>
    tags.length === 0 ? null : (
        <Text size="xs" c="dimmed" lineClamp={1} title={tags.map((tag) => tag.name).join(", ")}>
            {tags.map((tag) => tag.name).join(" · ")}
        </Text>
    );
