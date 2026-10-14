"use client";

import Link from "next/link";
import { ActionIcon, Box, Menu, Text } from "@mantine/core";

import type { MediaListItem, Tag, TagPicture } from "@private-stock/core";

import { useClearTagPicture } from "@/lib/api/tags";

import classes from "./TagPictureInset.module.scss";

/**
 * A tag's picture on its own page, beside its name (§6 "A tag's picture").
 *
 * An inset rather than the window behind the name: the window is wide and the picture of a
 * person is a portrait, and stretched across it a face is cropped to a forehead. The window keeps
 * the day's sample from their items; this is who they are.
 *
 * Pressing it opens the item it was taken from, at that moment, for as long as that item exists.
 * Its menu chooses another, and takes back a picture somebody chose -- the automatic one then
 * shows, if there is one.
 *
 * A tag with no picture at all shows a stand-in here instead: the cover of the window's item,
 * the same one its browse tile showed. It changes with the seed; the page's picture dialogue,
 * which the menu opens, keeps it when it happens to be right.
 */

type TagPictureInsetProps = {
    tag: Tag;
    /** Opens the page's picture dialogue, which also keeps a stand-in. */
    onChoose: () => void;
    onDone?: (message: string) => void;
} & (
    | { picture: TagPicture; standIn?: undefined }
    | { picture?: null; standIn: MediaListItem & { coverUrl: string } }
);

const originHref = (mediaId: string | null, atMs: number | null): string | null =>
    mediaId ? `/media/${encodeURIComponent(mediaId)}${atMs === null ? "" : `?at=${atMs}`}` : null;

export const TagPictureInset: React.FC<TagPictureInsetProps> = ({
    tag,
    picture,
    standIn,
    onChoose,
    onDone,
}) => {
    const clear = useClearTagPicture(tag.id, (next) =>
        onDone?.(
            next ? `${tag.name}'s automatic picture is back` : `${tag.name} has no picture now`
        )
    );
    const origin = picture
        ? originHref(picture.mediaId, picture.atMs)
        : originHref(standIn.id, null);
    const image = (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={picture ? picture.url : standIn.coverUrl} alt={tag.name} decoding="async" />
    );

    return (
        <Box className={classes.inset} data-portrait={tag.kind === "performer" || undefined}>
            {origin ? (
                <Link
                    href={origin}
                    className={classes.picture}
                    title="Open where this was taken"
                    // Lit while the item is on its way (§14, "Waiting").
                    data-open-frame
                >
                    {image}
                </Link>
            ) : (
                <Box className={classes.picture}>{image}</Box>
            )}

            <Menu position="bottom-end" shadow="md" withinPortal>
                <Menu.Target>
                    <ActionIcon
                        variant="filled"
                        color="dark"
                        size="lg"
                        radius="xl"
                        className={classes.more}
                        aria-label={`${tag.name}'s picture`}
                    >
                        <Text span fw={700} lh={1}>
                            ⋯
                        </Text>
                    </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                    <Menu.Label>
                        {!picture
                            ? "A stand-in from their items"
                            : picture.source === "user"
                              ? "Chosen picture"
                              : tag.kind === "performer"
                                ? "From their faces"
                                : "Picked from their items"}
                    </Menu.Label>
                    {origin && (
                        <Menu.Item component={Link} href={origin}>
                            Open where it was taken
                        </Menu.Item>
                    )}
                    <Menu.Item onClick={onChoose}>
                        {picture ? "Choose another…" : "Keep or choose a picture…"}
                    </Menu.Item>
                    {picture?.source === "user" && (
                        <Menu.Item
                            color="oxblood"
                            disabled={clear.isPending}
                            onClick={() => clear.mutate(undefined)}
                        >
                            Remove this picture
                        </Menu.Item>
                    )}
                </Menu.Dropdown>
            </Menu>
        </Box>
    );
};
