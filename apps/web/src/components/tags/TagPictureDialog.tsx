"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    Alert,
    Box,
    Button,
    Group,
    Loader,
    Modal,
    Stack,
    Text,
    UnstyledButton,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import {
    centredCrop,
    pictureAroundFace,
    tagPictureAspect,
    type FaceCrop,
    type FaceMoments,
    type PictureCrop,
} from "@private-stock/core";

import { ApiError } from "@/lib/api/client";
import { faceMomentsQuery, matchedMoment } from "@/lib/api/faces";
import { useSetTagPicture } from "@/lib/api/tags";
import { spriteCropStyle } from "@/lib/spriteCrop";
import { formatTimecode } from "@/lib/timecode";

import classes from "./TagPictureDialog.module.scss";

/**
 * Framing a tag's picture from one moment of an item (§6 "A tag's picture").
 *
 * The moment is shown as read from the original (`/api/media/<id>/still`), with a box in the
 * shape the picture is drawn in -- a portrait for a performer, a landscape frame for anything
 * else -- to move and to size. Beside it, the picture as the browse tile and the small cards
 * will draw it, so what is chosen is seen at the sizes it will be seen at.
 *
 * Opened from a face, the box starts around that face, framed as the automatic picture would
 * be; from anywhere else, as large as the frame allows, centred.
 *
 * A video's face was found on a scrubber tile, and a tile is seldom the frame its time names (§9
 * "What a tile shows"). So from one, the frames it may be are read first, the one most like the
 * tile is framed, and the others are offered beside the tile to choose instead.
 */

interface TagPictureDialogProps {
    opened: boolean;
    onClose: () => void;
    tag: { id: string; name: string; kind: string };
    mediaId: string;
    /** The moment of a video; null for a photograph. */
    atMs: number | null;
    /** A face to start the box around, as fractions of the frame. */
    face?: PictureCrop | null;
    /**
     * A video's face, as cut from the sprite tile it was found on: `atMs` is then the tile's
     * moment, and the frame it really is is found before anything is framed.
     */
    faceTile?: FaceCrop | null;
    onDone?: (message: string) => void;
}

/** The smallest the box may be, as a share of the frame's width: past this it is a smudge. */
const MIN_WIDTH = 0.06;

const clamp = (value: number, low: number, high: number): number =>
    Math.min(Math.max(value, low), high);

interface Drag {
    mode: "move" | "size";
    startX: number;
    startY: number;
    from: PictureCrop;
    /** The image's size on screen, which the pointer's travel is a share of. */
    width: number;
    height: number;
}

/** How wide the frames to choose between are drawn: half a tile. */
const MOMENT_WIDTH = 100;

/**
 * The tile the face was found on, and the frames it may be: the one framed is marked, and any
 * other is a press away. A strip that scrolls sideways, so a phone keeps the frame above it.
 */
const MomentChoices: React.FC<{
    tile: FaceCrop;
    moments: FaceMoments["moments"];
    chosen: number;
    onChoose: (atMs: number) => void;
}> = ({ tile, moments, chosen, onChoose }) => {
    const height = Math.round((MOMENT_WIDTH * tile.frame.height) / tile.frame.width);

    return (
        <Stack gap={6}>
            <Text size="sm" c="dimmed">
                Which moment? The one most like the thumbnail the face was found on is chosen.
            </Text>
            <Group gap="xs" wrap="nowrap" align="flex-start" className={classes.moments}>
                <Stack gap={2} align="center" className={classes.tile}>
                    <Box
                        role="img"
                        aria-label="The thumbnail the face was found on"
                        style={{
                            width: MOMENT_WIDTH,
                            height,
                            borderRadius: 4,
                            ...spriteCropStyle(tile.url, tile.frame),
                        }}
                    />
                    <Text size="xs" c="dimmed">
                        Found on
                    </Text>
                </Stack>
                {moments.map((moment) => (
                    <UnstyledButton
                        key={moment.atMs}
                        className={classes.moment}
                        data-chosen={moment.atMs === chosen || undefined}
                        aria-pressed={moment.atMs === chosen}
                        aria-label={`The frame at ${formatTimecode(moment.atMs)}`}
                        onClick={() => onChoose(moment.atMs)}
                    >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={moment.thumbUrl} alt="" width={MOMENT_WIDTH} height={height} />
                        <Text size="xs" c="dimmed" ta="center">
                            {formatTimecode(moment.atMs)}
                        </Text>
                    </UnstyledButton>
                ))}
            </Group>
        </Stack>
    );
};

/**
 * A preview of the crop at a given width: the frame scaled so the crop fills it, and moved so the
 * crop is what shows. CSS rather than a canvas, because the still is already loaded.
 */
const CropPreview: React.FC<{
    src: string;
    crop: PictureCrop;
    width: number;
    aspect: number;
    label: string;
}> = ({ src, crop, width, aspect, label }) => (
    <Stack gap={4} align="center">
        <Box
            className={classes.preview}
            style={{
                width,
                height: width / aspect,
                backgroundImage: `url("${src}")`,
                backgroundSize: `${100 / crop.w}% ${100 / crop.h}%`,
                backgroundPosition: `${crop.w >= 1 ? 0 : (crop.x / (1 - crop.w)) * 100}% ${
                    crop.h >= 1 ? 0 : (crop.y / (1 - crop.h)) * 100
                }%`,
            }}
            role="img"
            aria-label={label}
        />
        <Text size="xs" c="dimmed">
            {label}
        </Text>
    </Stack>
);

export const TagPictureDialog: React.FC<TagPictureDialogProps> = ({
    opened,
    onClose,
    tag,
    mediaId,
    atMs,
    face,
    faceTile,
    onDone,
}) => {
    const aspect = tagPictureAspect(tag.kind);
    const finding = Boolean(faceTile) && atMs !== null;
    const moments = useQuery({
        ...faceMomentsQuery(mediaId, atMs ?? 0),
        enabled: opened && finding,
    });
    const [chosen, setChosen] = useState<number | null>(null);
    // The moment framed: the one pressed, else the match, else -- nothing could be read -- the
    // face's own. Undefined while the frames are still being read, so no still is asked for yet.
    const moment = !finding
        ? atMs
        : chosen !== null
          ? chosen
          : moments.data
            ? matchedMoment(moments.data, atMs!)
            : moments.isError
              ? atMs
              : undefined;
    const src =
        moment === undefined
            ? null
            : `/api/media/${encodeURIComponent(mediaId)}/still${
                  moment === null ? "" : `?at=${Math.max(0, Math.round(moment))}`
              }`;
    const imageRef = useRef<HTMLImageElement>(null);
    const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);
    const [crop, setCrop] = useState<PictureCrop | null>(null);
    const [failed, setFailed] = useState(false);
    const drag = useRef<Drag | null>(null);

    // A new moment is a new still: start again rather than keep a box drawn for another frame.
    useEffect(() => {
        setFrame(null);
        setCrop(null);
        setFailed(false);
    }, [src, opened]);

    // Another face, or the dialogue again: the match decides afresh.
    useEffect(() => {
        setChosen(null);
    }, [mediaId, atMs, opened]);

    const save = useSetTagPicture(tag.id, () => {
        onDone?.(`${tag.name} has a new picture`);
        onClose();
    });

    const onLoad = () => {
        const image = imageRef.current;

        if (!image?.naturalWidth || !image.naturalHeight) {
            return;
        }

        const size = { width: image.naturalWidth, height: image.naturalHeight };

        setFrame(size);
        setCrop((face && pictureAroundFace(face, size, aspect)) ?? centredCrop(size, aspect));
    };

    /** The crop's height for a width, keeping the picture's shape in the frame's pixels. */
    const heightFor = useCallback(
        (width: number): number => (frame ? (width * frame.width) / (frame.height * aspect) : 0),
        [aspect, frame]
    );

    const onPointerDown = (mode: Drag["mode"]) => (event: React.PointerEvent) => {
        const image = imageRef.current;

        if (!crop || !image) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        (event.target as Element).setPointerCapture(event.pointerId);

        const rect = image.getBoundingClientRect();

        drag.current = {
            mode,
            startX: event.clientX,
            startY: event.clientY,
            from: crop,
            width: rect.width,
            height: rect.height,
        };
    };

    const onPointerMove = (event: React.PointerEvent) => {
        const active = drag.current;

        if (!active) {
            return;
        }

        const dx = (event.clientX - active.startX) / active.width;
        const dy = (event.clientY - active.startY) / active.height;
        const { from } = active;

        if (active.mode === "move") {
            setCrop({
                ...from,
                x: clamp(from.x + dx, 0, 1 - from.w),
                y: clamp(from.y + dy, 0, 1 - from.h),
            });

            return;
        }

        // Sized from the corner under the pointer, the shape kept: the larger of the two moves
        // decides, and the frame's edges stop it.
        const wanted = Math.max(from.w + dx, from.w * ((from.h + dy) / from.h));
        const widest = Math.min(1 - from.x, (1 - from.y) / (heightFor(1) || 1));
        const w = clamp(wanted, MIN_WIDTH, widest);

        setCrop({ ...from, w, h: heightFor(w) });
    };

    const onPointerUp = () => {
        drag.current = null;
    };

    /** Arrow keys move the box, with Shift growing or shrinking it: framing without a mouse. */
    const onKeyDown = (event: React.KeyboardEvent) => {
        if (!crop) {
            return;
        }

        const step = 0.01;
        const moves: Record<string, [number, number]> = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
        };
        const move = moves[event.key];

        if (!move) {
            return;
        }

        event.preventDefault();

        if (event.shiftKey) {
            const grow = move[0] + -move[1];
            const widest = Math.min(1 - crop.x, (1 - crop.y) / (heightFor(1) || 1));
            const w = clamp(crop.w + grow, MIN_WIDTH, widest);

            setCrop({ ...crop, w, h: heightFor(w) });

            return;
        }

        setCrop({
            ...crop,
            x: clamp(crop.x + move[0], 0, 1 - crop.w),
            y: clamp(crop.y + move[1], 0, 1 - crop.h),
        });
    };

    const error =
        save.error instanceof ApiError
            ? save.error.message
            : save.error
              ? "The picture could not be saved."
              : null;

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={`Picture for ${tag.name}`}
            size="xl"
            centered
        >
            <Stack gap="md">
                <Box className={classes.layout}>
                    <Box
                        className={classes.stage}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={onPointerUp}
                    >
                        {failed ? (
                            <Alert color="oxblood" variant="light">
                                This moment could not be read from the file.
                            </Alert>
                        ) : !src ? (
                            <Box className={classes.loading}>
                                <Loader size="sm" color="brass" />
                            </Box>
                        ) : (
                            <>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                    ref={imageRef}
                                    src={src}
                                    alt=""
                                    className={classes.still}
                                    onLoad={onLoad}
                                    onError={() => setFailed(true)}
                                    draggable={false}
                                />
                                {!frame && (
                                    <Box className={classes.loading}>
                                        <Loader size="sm" color="brass" />
                                    </Box>
                                )}
                                {crop && (
                                    <Box
                                        className={classes.box}
                                        style={{
                                            left: `${crop.x * 100}%`,
                                            top: `${crop.y * 100}%`,
                                            width: `${crop.w * 100}%`,
                                            height: `${crop.h * 100}%`,
                                        }}
                                        onPointerDown={onPointerDown("move")}
                                        onKeyDown={onKeyDown}
                                        tabIndex={0}
                                        role="slider"
                                        aria-label="The part of the frame to keep. Arrow keys move it; with Shift they size it."
                                        aria-valuetext={`${Math.round(crop.w * 100)}% of the frame's width`}
                                    >
                                        <Box
                                            className={classes.handle}
                                            onPointerDown={onPointerDown("size")}
                                            aria-hidden
                                        />
                                    </Box>
                                )}
                            </>
                        )}
                    </Box>

                    {crop && src && (
                        <Stack className={classes.previews} gap="md" align="center">
                            <CropPreview
                                src={src}
                                crop={crop}
                                width={160}
                                aspect={aspect}
                                label="Tile"
                            />
                            <CropPreview
                                src={src}
                                crop={crop}
                                width={88}
                                aspect={aspect}
                                label="Card"
                            />
                        </Stack>
                    )}
                </Box>

                {faceTile && moments.data && typeof moment === "number" && (
                    <MomentChoices
                        tile={faceTile}
                        moments={moments.data.moments}
                        chosen={moment}
                        onChoose={setChosen}
                    />
                )}

                <Text size="sm" c="dimmed">
                    Drag the box to frame them, and its corner to size it. The picture is cut from
                    the file itself, so it is sharper than this preview.
                </Text>

                {error && (
                    <Alert color="oxblood" variant="light">
                        {error}
                    </Alert>
                )}

                <Group justify="flex-end">
                    <Button variant="default" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        color="brass"
                        disabled={!crop || moment === undefined}
                        loading={save.isPending}
                        onClick={() =>
                            crop &&
                            moment !== undefined &&
                            save.mutate({ mediaId, atMs: moment, crop })
                        }
                    >
                        Use this picture
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
};
