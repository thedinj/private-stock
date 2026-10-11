"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader, Menu, Text, UnstyledButton } from "@mantine/core";

import type { TagPicture } from "@private-stock/core";

import type { ItemTagChip as Chip } from "@/lib/api/itemTags";
import { CloseGlyph } from "@/components/media/Glyph";

import { TagPictureDialog } from "./TagPictureDialog";
import classes from "./ItemTagChip.module.scss";

/**
 * One tag on an item, as something to follow as well as something to take off (§5b).
 *
 * Mantine's `TagsInput` drew these as pills whose only gesture was ×, so the tags on an item
 * were a dead end: seeing "Jane Doe" on one video gave no way to the rest of hers. The name is
 * now the way in and × is a target of its own, so a tap meant to explore cannot delete.
 *
 * **The name opens a menu rather than going somewhere at once.** There are two places worth
 * going -- the library narrowed to this tag, and the tag's own page -- and neither is so much
 * the obvious one that the other should cost a trip through it. Both are real links, so a
 * middle-click or a long-press opens them in a new tab like any other.
 *
 * **A tag with a picture is a card, not a chip** (§6 "A tag's picture"): the picture at 88
 * pixels across, 72 on a phone, with the name beside it. Never at a chip's height, where a face
 * is a smudge and worse than the name alone. The menu and the × are the chip's.
 *
 * Where the page has a moment to offer -- the playhead, or the photograph itself -- the menu
 * also takes it as the tag's picture, framed in a dialogue first.
 *
 * A chip still being saved has no tag id yet, so it is drawn but goes nowhere: a link to a tag
 * that may yet fail to be created would be a link to a 404.
 *
 * **A performer's × asks how** (§5f "People in this item"): "Remove tag" only takes it off, and
 * the faces may suggest them again; "Not them" also says they are not in it, so nothing puts them
 * back. And where the faces found them in the item, the card carries that face (`face`), so who is
 * tagged and who was seen are one card, not two lists.
 */

/** The moment of the item on screen, for "use this as their picture". */
export interface ItemMoment {
    mediaId: string;
    kind: "video" | "image";
    /** Where the playhead is now, in milliseconds; null for a photograph. */
    atMs: () => number | null;
}

interface ItemTagChipProps {
    chip: Chip;
    /** `notThem` is the choice `removeChoice` offers; absent, the server's default. */
    onRemove: (name: string, notThem?: boolean) => void;
    /** Ask "Remove tag" or "Not them" rather than taking it off at once: a performer's. */
    removeChoice?: boolean;
    /** Their face in the item, under the name; a chip with one is drawn as a card. */
    face?: React.ReactNode;
    /** The tag's facet, which decides the picture's shape. */
    kind?: string;
    picture?: TagPicture | null;
    moment?: ItemMoment;
}

export const ItemTagChip: React.FC<ItemTagChipProps> = ({
    chip,
    onRemove,
    removeChoice,
    face,
    kind,
    picture,
    moment,
}) => {
    const { name, tagId, pending, source } = chip;
    const [framing, setFraming] = useState<number | null | undefined>(undefined);

    const menu = (target: React.ReactNode) => (
        <Menu position="bottom-start" shadow="md" withinPortal>
            <Menu.Target>{target}</Menu.Target>
            <Menu.Dropdown>
                {/* The menu opens over the box below, so it says which tag it is for. */}
                <Menu.Label>{name}</Menu.Label>
                <Menu.Item
                    component={Link}
                    href={`/?${new URLSearchParams({ view: "grid", tags: tagId ?? "" })}`}
                >
                    Show in library
                </Menu.Item>
                <Menu.Item component={Link} href={`/tags/${encodeURIComponent(tagId ?? "")}`}>
                    Tag page
                </Menu.Item>
                {moment && kind && (
                    <Menu.Item onClick={() => setFraming(moment.atMs())}>
                        {moment.kind === "video"
                            ? "Use this frame as their picture…"
                            : "Use this photo as their picture…"}
                    </Menu.Item>
                )}
            </Menu.Dropdown>
        </Menu>
    );

    const remove = pending ? (
        <span className={classes.end} aria-label="Saving">
            <Loader size={10} color="brass" />
        </span>
    ) : removeChoice ? (
        <Menu position="bottom-end" shadow="md" withinPortal>
            <Menu.Target>
                <UnstyledButton className={classes.end} aria-label={`Remove ${name}…`}>
                    <CloseGlyph size={10} />
                </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown maw={280}>
                <Menu.Label>{name}</Menu.Label>
                <Menu.Item onClick={() => onRemove(name, false)}>
                    Remove tag
                    <Text size="xs" c="dimmed">
                        Only take it off. Their face may be suggested again.
                    </Text>
                </Menu.Item>
                <Menu.Item onClick={() => onRemove(name, true)}>
                    Not them
                    <Text size="xs" c="dimmed">
                        They are not in this item: never suggest or tag them on it again.
                    </Text>
                </Menu.Item>
            </Menu.Dropdown>
        </Menu>
    ) : (
        <UnstyledButton
            className={classes.end}
            aria-label={`Remove ${name}`}
            onClick={() => onRemove(name)}
        >
            <CloseGlyph size={10} />
        </UnstyledButton>
    );

    const dialog = moment && kind && tagId && framing !== undefined && (
        <TagPictureDialog
            opened
            onClose={() => setFraming(undefined)}
            tag={{ id: tagId, name, kind }}
            mediaId={moment.mediaId}
            atMs={framing}
        />
    );

    if ((picture || face) && tagId) {
        return (
            <span
                className={classes.card}
                data-portrait={kind === "performer" || undefined}
                data-source={source}
            >
                {picture &&
                    menu(
                        <UnstyledButton className={classes.cardPicture} title={name}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={picture.smallUrl} alt="" loading="lazy" decoding="async" />
                        </UnstyledButton>
                    )}
                <span className={classes.cardBody}>
                    {menu(
                        <UnstyledButton className={classes.cardName} title={name}>
                            <span className={classes.cardLabel}>{name}</span>
                        </UnstyledButton>
                    )}
                    {face}
                </span>
                {remove}
                {dialog}
            </span>
        );
    }

    return (
        <span className={classes.chip} data-pending={pending || undefined} data-source={source}>
            {tagId ? (
                menu(
                    <UnstyledButton className={classes.name} title={name}>
                        <span className={classes.label}>{name}</span>
                    </UnstyledButton>
                )
            ) : (
                <span className={classes.name} title={name}>
                    <span className={classes.label}>{name}</span>
                </span>
            )}

            {remove}
            {dialog}
        </span>
    );
};
