"use client";

import Link from "next/link";
import { Anchor, Text } from "@mantine/core";

import type { TagCompanion } from "@private-stock/core";

import { rememberShelf } from "@/lib/returnTo";
import { FilmstripRow } from "@/components/browse/FilmstripRow";

/**
 * Somebody a performer appears with, and a strip of the items they share (§6 "Tags").
 *
 * The browse row's look -- name, strip, a control at the end -- because it is the same object:
 * a person and a glimpse of what they are in. Here the glimpse is narrowed to the items with
 * both people in, since that is the question a profile's "Appears with" answers.
 *
 * Three ways in, as on the browse row. The name goes to their own page; a thumbnail opens that
 * item with the strip as the set; "together" opens the grid of every item carrying both.
 */

interface CompanionRowProps {
    /** The performer whose page this is. */
    tagId: string;
    companion: TagCompanion;
    /** Carried to the companion's profile so its picture comes from the same shuffle. */
    seed: number;
    /** Whether the section keeps a column for portraits, some of its rows having one. */
    pictureSlot?: boolean;
}

export const CompanionRow: React.FC<CompanionRowProps> = ({
    tagId,
    companion,
    seed,
    pictureSlot,
}) => {
    const togetherHref = `/?${new URLSearchParams({
        view: "grid",
        tags: `${tagId},${companion.tagId}`,
    }).toString()}`;

    return (
        <FilmstripRow
            name={companion.name}
            href={`/tags/${companion.tagId}?seed=${seed}`}
            picture={companion.picture && { url: companion.picture.smallUrl, shape: "portrait" }}
            pictureSlot={pictureSlot}
            frames={companion.strip.map((item) => ({
                key: item.id,
                href: `/media/${item.id}`,
                coverUrl: item.coverUrl,
                title: item.title,
                onClick: () => rememberShelf(companion.strip),
            }))}
            actions={
                <Anchor
                    component={Link}
                    href={togetherHref}
                    size="sm"
                    c="brass.4"
                    underline="never"
                    // A thumb's worth on a phone, where this sits beside the name.
                    style={{ display: "inline-block", paddingBlock: 12, whiteSpace: "nowrap" }}
                    aria-label={`See all ${companion.shared.toLocaleString()} with ${companion.name}`}
                >
                    See all →
                </Anchor>
            }
        >
            <Text size="sm" c="dimmed">
                {companion.shared.toLocaleString()} together
            </Text>
        </FilmstripRow>
    );
};
