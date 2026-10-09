"use client";

import { useState } from "react";
import {
    Box,
    Button,
    Group,
    Loader,
    Modal,
    SegmentedControl,
    Skeleton,
    Stack,
    Text,
    UnstyledButton,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import type { FaceReviewFace, MediaDetail, MediaListItem } from "@private-stock/core";

import { LoadFailed } from "@/components/LoadFailed";
import { FaceCropView } from "@/components/faces/FaceCropView";
import { useConfirmedFaces } from "@/lib/api/faces";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";

import { KeepStandInDialog } from "./KeepStandInDialog";
import { TagPictureDialog } from "./TagPictureDialog";
import classes from "./TagPicturePicker.module.scss";

/**
 * Choosing a tag's picture (§6 "A tag's picture"): the one place it is chosen from, whichever
 * menu opened it.
 *
 * - **Their faces**, for a library performer, to an administrator: every face confirmed as them,
 *   every moment, largest first, a page at a time -- the best picture is often a second look in
 *   the same video. The box starts around the face pressed.
 * - **Their items**: one of the tag's items, then one of that item's frames -- the generated
 *   ones along the video and anybody's captures, the moments already worth a look. A photograph
 *   goes straight to the framing. Any other moment of a video is chosen on the item itself, from
 *   the tag's menu, where the player is. The items are the page's own shelves, so this asks for
 *   nothing new.
 * - **The stand-in** shown while the tag has no picture, kept as it is -- when it happens to be
 *   right, that is the quickest picture there is.
 */

type Source = "faces" | "items";

interface TagPicturePickerProps {
    opened: boolean;
    onClose: () => void;
    tag: { id: string; name: string; kind: string };
    items: MediaListItem[];
    /** Offer the faces confirmed as them: a library performer, to an administrator. */
    faces: boolean;
    /** The picture shown while the tag has none, to keep as it is. */
    standIn: (MediaListItem & { coverUrl: string }) | null;
    onDone?: (message: string) => void;
}

const FrameChoices: React.FC<{
    mediaId: string;
    onPick: (atMs: number) => void;
}> = ({ mediaId, onPick }) => {
    const { data, isLoading } = useQuery({
        queryKey: queryKeys.media.detail(mediaId),
        queryFn: () => api<MediaDetail>(`/api/media/${mediaId}`),
    });

    if (isLoading || !data) {
        return <Loader size="sm" color="brass" />;
    }

    const frames = data.frames.filter((frame) => frame.atMs !== null);

    if (frames.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                This video has no frames yet. Open it and use the tag&rsquo;s menu there.
            </Text>
        );
    }

    return (
        <Box className={classes.grid}>
            {frames.map((frame) => (
                <UnstyledButton
                    key={frame.artifactId}
                    className={classes.choice}
                    onClick={() => onPick(frame.atMs!)}
                    aria-label="Use this moment"
                >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={frame.url} alt="" loading="lazy" decoding="async" />
                </UnstyledButton>
            ))}
        </Box>
    );
};

const FaceChoices: React.FC<{
    tagId: string;
    name: string;
    onPick: (face: FaceReviewFace) => void;
}> = ({ tagId, name, onPick }) => {
    const { data, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
        useConfirmedFaces(tagId, true);
    const faces = data?.pages.flatMap((page) => page.faces) ?? [];

    if (error) {
        return <LoadFailed error={error} what="their faces" onRetry={() => void refetch()} />;
    }

    if (!data) {
        return <Skeleton height={72} radius="md" />;
    }

    if (faces.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                No face is confirmed as {name} yet. Confirm some on their Organise page, or choose
                from their items.
            </Text>
        );
    }

    return (
        <Stack gap="xs">
            <Group gap={6} wrap="wrap">
                {faces.map((face, index) => (
                    <UnstyledButton
                        key={`${face.mediaId}:${face.atMs ?? ""}:${index}`}
                        onClick={() => onPick(face)}
                        aria-label={`Use this face as ${name}'s picture`}
                        style={{ borderRadius: 4 }}
                    >
                        <FaceCropView crop={face.crop} size={72} />
                    </UnstyledButton>
                ))}
            </Group>
            {hasNextPage && (
                <Group>
                    <Button
                        variant="default"
                        h={44}
                        loading={isFetchingNextPage}
                        onClick={() => void fetchNextPage()}
                    >
                        Show more · {(data.pages[0].total - faces.length).toLocaleString()} left
                    </Button>
                </Group>
            )}
        </Stack>
    );
};

export const TagPicturePicker: React.FC<TagPicturePickerProps> = ({
    opened,
    onClose,
    tag,
    items,
    faces,
    standIn,
    onDone,
}) => {
    const [source, setSource] = useState<Source>(faces ? "faces" : "items");
    const [item, setItem] = useState<MediaListItem | null>(null);
    const [moment, setMoment] = useState<number | null | undefined>(undefined);
    const [face, setFace] = useState<FaceReviewFace | null>(null);
    const [keeping, setKeeping] = useState(false);

    const close = () => {
        setItem(null);
        setMoment(undefined);
        setFace(null);
        setKeeping(false);
        onClose();
    };

    const pickItem = (chosen: MediaListItem) => {
        setItem(chosen);

        // A photograph is its own moment.
        if (chosen.kind !== "video") {
            setMoment(null);
        }
    };

    if (!opened) {
        return null;
    }

    if (keeping && standIn) {
        return <KeepStandInDialog item={standIn} tag={tag} onClose={close} onDone={onDone} />;
    }

    if (face) {
        return (
            <TagPictureDialog
                opened
                onClose={close}
                tag={tag}
                mediaId={face.mediaId}
                atMs={face.atMs}
                face={face.box}
                onDone={onDone}
            />
        );
    }

    if (item && moment !== undefined) {
        return (
            <TagPictureDialog
                opened
                onClose={close}
                tag={tag}
                mediaId={item.id}
                atMs={moment}
                onDone={onDone}
            />
        );
    }

    return (
        <Modal opened onClose={close} title={`Picture for ${tag.name}`} size="xl" centered>
            <Stack gap="md">
                {standIn && (
                    <Group gap="sm" wrap="nowrap">
                        <Text size="sm" c="dimmed" style={{ flex: 1 }}>
                            The picture shown now is a stand-in, from one of {tag.name}&rsquo;s
                            items.
                        </Text>
                        <Button
                            variant="light"
                            color="brass"
                            h={44}
                            onClick={() => setKeeping(true)}
                        >
                            Keep it…
                        </Button>
                    </Group>
                )}

                {faces && (
                    <SegmentedControl
                        value={source}
                        onChange={(value) => {
                            setSource(value as Source);
                            setItem(null);
                        }}
                        data={[
                            { value: "faces", label: "Their faces" },
                            { value: "items", label: "Their items" },
                        ]}
                    />
                )}

                {source === "faces" && faces ? (
                    <>
                        <Text size="sm" c="dimmed">
                            Pick a face; it is framed from the file itself.
                        </Text>
                        <FaceChoices tagId={tag.id} name={tag.name} onPick={setFace} />
                    </>
                ) : item ? (
                    <>
                        <Group justify="space-between" wrap="nowrap">
                            <Text size="sm" truncate>
                                A moment of {item.title}
                            </Text>
                            <Button variant="subtle" color="gray" onClick={() => setItem(null)}>
                                ← Another item
                            </Button>
                        </Group>
                        <FrameChoices mediaId={item.id} onPick={setMoment} />
                    </>
                ) : items.length === 0 ? (
                    <Text size="sm" c="dimmed">
                        Nothing carrying {tag.name} can be shown here.
                    </Text>
                ) : (
                    <>
                        <Text size="sm" c="dimmed">
                            Pick one of {tag.name}&rsquo;s items, then the moment to frame.
                        </Text>
                        <Box className={classes.grid}>
                            {items.map((candidate) => (
                                <UnstyledButton
                                    key={candidate.id}
                                    className={classes.choice}
                                    onClick={() => pickItem(candidate)}
                                    title={candidate.title}
                                >
                                    {candidate.coverUrl ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                            src={candidate.coverUrl}
                                            alt=""
                                            loading="lazy"
                                            decoding="async"
                                        />
                                    ) : (
                                        <Box className={classes.blank} />
                                    )}
                                </UnstyledButton>
                            ))}
                        </Box>
                    </>
                )}
            </Stack>
        </Modal>
    );
};
