"use client";

import { Loader, Modal, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import type { MediaListItem } from "@private-stock/core";

import { mediaDetailQuery } from "@/lib/api/media";

import { TagPictureDialog } from "./TagPictureDialog";

/**
 * Keeping a stand-in as a tag's picture (§6 "A tag's picture"): the framing dialogue at the
 * moment an item's cover was taken from. Framing rather than a straight copy, because a cover is
 * 16:9 and a performer's picture a portrait.
 *
 * A list item does not say where its cover came from; its detail does, in the same request and
 * cache the item's page uses. A photograph is its own moment and needs nothing.
 */

interface KeepStandInDialogProps {
    item: MediaListItem;
    tag: { id: string; name: string; kind: string };
    onClose: () => void;
    onDone?: (message: string) => void;
}

export const KeepStandInDialog: React.FC<KeepStandInDialogProps> = ({
    item,
    tag,
    onClose,
    onDone,
}) => {
    const video = item.kind === "video";
    const { data, isLoading } = useQuery({
        ...mediaDetailQuery(item.id),
        enabled: video,
    });
    // Undefined while it is not known yet, or for a video whose cover has no moment.
    const atMs = video ? (data?.frames.find((frame) => frame.isCover)?.atMs ?? undefined) : null;

    if (atMs !== undefined) {
        return (
            <TagPictureDialog
                opened
                onClose={onClose}
                tag={tag}
                mediaId={item.id}
                atMs={atMs}
                onDone={onDone}
            />
        );
    }

    return (
        <Modal opened onClose={onClose} title={`Picture for ${tag.name}`} centered>
            {isLoading ? (
                <Loader size="sm" color="brass" />
            ) : (
                <Text size="sm" c="dimmed">
                    This cover has no moment to frame. Choose a picture from one of {tag.name}
                    &rsquo;s items instead.
                </Text>
            )}
        </Modal>
    );
};
