"use client";

import { Text } from "@mantine/core";

import type { TagBrowseRow, TagScope } from "@private-stock/core";

import { useTagFavorite } from "@/lib/api/tags";
import { rememberShelf } from "@/lib/returnTo";
import { FilmstripRow } from "@/components/browse/FilmstripRow";
import { FavoriteToggle } from "@/components/FavoriteToggle";
import { TagRowActions } from "@/components/tags/TagRowActions";

import { KindCounts } from "./KindCounts";

/**
 * One tag on a browse page: its name and counts, and a strip of what it is on (§6 "Tags").
 *
 * A row rather than a card, because a performer facet runs to hundreds: a row scans down a
 * long list, and the strip shows a person's range where a single cover would show one frame
 * of it.
 *
 * Three ways in, each to a different question. The name goes to the tag's own page; each
 * count goes straight to the grid of just those videos or just those photos; a thumbnail opens
 * that item, with the strip as the set so the viewer can step along it.
 *
 * The heart sits after the name, the thing it marks (§6 "Favourite tags"). No `H` here: a
 * page of thirty hearts has no single one a key could mean.
 */

interface TagFilmstripRowProps {
    row: TagBrowseRow;
    scope: TagScope;
    curator: boolean;
    /** Carried to the profile so its picture matches the strip it was opened from. */
    seed: number;
    onDone: (message: string) => void;
    /** Whether the list keeps a column for portraits, some of its rows having one. */
    pictureSlot?: boolean;
}

export const TagFilmstripRow: React.FC<TagFilmstripRowProps> = ({
    row,
    scope,
    curator,
    seed,
    onDone,
    pictureSlot,
}) => {
    const { tag } = row;
    const profileHref = `/tags/${tag.id}?seed=${seed}`;
    const { favorite, toggle, burstKey } = useTagFavorite(tag.id, row.favorite);

    return (
        <FilmstripRow
            name={tag.name}
            href={profileHref}
            pictureSlot={pictureSlot}
            picture={
                tag.picture && {
                    url: tag.kind === "performer" ? tag.picture.smallUrl : tag.picture.url,
                    shape: tag.kind === "performer" ? "portrait" : "frame",
                }
            }
            adornment={
                <FavoriteToggle
                    favorite={favorite}
                    onToggle={toggle}
                    burstKey={burstKey}
                    size="md"
                    subject={tag.name}
                />
            }
            frames={row.strip.map((item) => ({
                key: item.id,
                href: `/media/${item.id}`,
                coverUrl: item.coverUrl,
                title: item.title,
                onClick: () => rememberShelf(row.strip),
            }))}
            actions={
                <TagRowActions
                    tag={{ ...tag, mediaCount: row.videoCount + row.imageCount }}
                    scope={scope}
                    curator={curator}
                    onDone={onDone}
                    variant="menu"
                />
            }
        >
            {(tag.aliases?.length ?? 0) > 0 && (
                <Text size="xs" c="dimmed" lineClamp={1}>
                    also {tag.aliases?.join(", ")}
                </Text>
            )}
            <KindCounts tagId={tag.id} videoCount={row.videoCount} imageCount={row.imageCount} />
        </FilmstripRow>
    );
};
