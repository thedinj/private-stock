"use client";

import { useState } from "react";
import Link from "next/link";
import { Box, Text } from "@mantine/core";

import type { TagBrowseRow, TagScope } from "@private-stock/core";

import { useTagFavorite } from "@/lib/api/tags";
import { FavoriteToggle } from "@/components/FavoriteToggle";
import { TagRowActions } from "@/components/tags/TagRowActions";

import { KeepStandInDialog } from "./KeepStandInDialog";
import { KindCounts } from "./KindCounts";
import classes from "./TagTile.module.scss";

/**
 * One tag on a browse page as a card: one picture, the name set over it (§6 "Tags").
 *
 * The other half of the browse page's layout switch. The row shows a person's range; the tile
 * shows their face, larger than any thumbnail in the library grid, for somebody who knows the
 * library by sight rather than by name. It costs density, which is why rows stay the default.
 *
 * The picture is the tag's own where it has one (§6 "A tag's picture") -- chosen by somebody, or
 * read from a performer's confirmed faces -- and otherwise the strip's first item, which changes
 * with the seed exactly as the strip does. It opens the tag's page, as the name does -- not the
 * item, which is the strip's job: a card's one picture is the tag's portrait.
 *
 * Three controls sit over or under the picture rather than inside its link: the heart and the
 * ⋯ menu are buttons, and a button inside a link is two targets in one place.
 */

interface TagTileProps {
    row: TagBrowseRow;
    scope: TagScope;
    curator: boolean;
    /** Carried to the profile so its picture matches the tile it was opened from. */
    seed: number;
    onDone: (message: string) => void;
}

export const TagTile: React.FC<TagTileProps> = ({ row, scope, curator, seed, onDone }) => {
    const { tag } = row;
    const profileHref = `/tags/${tag.id}?seed=${seed}`;
    const { favorite, toggle, burstKey } = useTagFavorite(tag.id, row.favorite);
    const standIn = tag.picture ? null : (row.strip.find((item) => item.coverUrl) ?? null);
    const cover = tag.picture?.url ?? standIn?.coverUrl;
    const [keeping, setKeeping] = useState(false);

    return (
        <Box className={classes.tile}>
            <Box className={classes.frame} data-portrait={tag.kind === "performer" || undefined}>
                {/* The same destination as the name, so out of the tab order and hidden from a
                    screen reader: one link per tile is announced, not two. */}
                <Link href={profileHref} className={classes.picture} tabIndex={-1} aria-hidden>
                    {cover ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={cover} alt="" loading="lazy" decoding="async" />
                    ) : (
                        <Box className={classes.blank} />
                    )}
                </Link>
                <Box className={classes.scrim} />

                <Box className={classes.caption}>
                    <Box className={classes.nameLine}>
                        <Link href={profileHref} className={classes.name}>
                            {tag.name}
                        </Link>
                        <Box component="span" className={classes.heart}>
                            <FavoriteToggle
                                favorite={favorite}
                                onToggle={toggle}
                                burstKey={burstKey}
                                size="md"
                                subject={tag.name}
                            />
                        </Box>
                    </Box>
                    {(tag.aliases?.length ?? 0) > 0 && (
                        <Text size="xs" className={classes.aliases} lineClamp={1}>
                            also {tag.aliases?.join(", ")}
                        </Text>
                    )}
                </Box>
            </Box>

            <Box className={classes.foot}>
                <KindCounts
                    tagId={tag.id}
                    videoCount={row.videoCount}
                    imageCount={row.imageCount}
                />
                <TagRowActions
                    tag={{ ...tag, mediaCount: row.videoCount + row.imageCount }}
                    scope={scope}
                    curator={curator}
                    onDone={onDone}
                    variant="menu"
                    onKeepPicture={standIn ? () => setKeeping(true) : undefined}
                />
            </Box>

            {keeping && standIn && (
                <KeepStandInDialog
                    item={standIn}
                    tag={tag}
                    onClose={() => setKeeping(false)}
                    onDone={onDone}
                />
            )}
        </Box>
    );
};
