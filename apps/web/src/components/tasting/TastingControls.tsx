"use client";

import { ActionIcon, Popover, SegmentedControl, Stack, Text, Tooltip } from "@mantine/core";

import {
    CloseGlyph,
    FullscreenGlyph,
    MutedGlyph,
    NextGlyph,
    OpenGlyph,
    PauseGlyph,
    PlayGlyph,
    PreviousGlyph,
    SoundGlyph,
    TimerGlyph,
} from "@/components/media/Glyph";
import { MiddleEllipsis } from "@/components/MiddleEllipsis";
import {
    TASTING_LENGTH_DATA,
    snapTastingSeconds,
    type TastingSeconds,
} from "@/lib/tasting/lengths";

import classes from "./Tasting.module.scss";

/**
 * The tasting's transport (§14g): what it shows and nothing it decides.
 *
 * Two pills, like the showcase's one: the ways out at the top, where the showcase keeps them,
 * and the show's own controls at the bottom, where every player keeps them. Every target is
 * 44px, because this is as likely to be run from a phone propped on a table as from a desk.
 */

interface TastingControlsProps {
    title: string | null;
    held: boolean;
    muted: boolean;
    /** The item on stage for the item-shaped controls to act on, if there is one. */
    itemId: string | null;
    isFullscreen: boolean;
    clipSeconds: TastingSeconds;
    photoSeconds: TastingSeconds;
    lengthsOpen: boolean;
    onLengthsOpen: (open: boolean) => void;
    onClipSeconds: (value: TastingSeconds) => void;
    onPhotoSeconds: (value: TastingSeconds) => void;
    onTogglePlay: () => void;
    onPrevious: () => void;
    onNext: () => void;
    onToggleMute: () => void;
    onOpen: () => void;
    onToggleFullscreen: () => void;
    onClose: () => void;
    /** The pointer is over a pill, which holds the controls up. */
    onPointerOnControls: (on: boolean) => void;
}

export const TastingControls: React.FC<TastingControlsProps> = ({
    title,
    held,
    muted,
    itemId,
    isFullscreen,
    clipSeconds,
    photoSeconds,
    lengthsOpen,
    onLengthsOpen,
    onClipSeconds,
    onPhotoSeconds,
    onTogglePlay,
    onPrevious,
    onNext,
    onToggleMute,
    onOpen,
    onToggleFullscreen,
    onClose,
    onPointerOnControls,
}) => {
    const hasItem = itemId !== null;
    const pointer = {
        onPointerEnter: () => onPointerOnControls(true),
        onPointerLeave: () => onPointerOnControls(false),
        // Clicks on the controls are not clicks on the picture, which holds the show.
        onClick: (event: React.MouseEvent) => event.stopPropagation(),
        onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
    };

    return (
        <>
            {title && <MiddleEllipsis text={title} className={classes.title} size="sm" />}

            <div className={classes.chrome} {...pointer}>
                <Tooltip label="Open this item (O)" position="bottom">
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size={44}
                        aria-label="Open this item"
                        // Which item this opens, so pressing or resting on it warms that item
                        // before the click arrives (`useItemWarming`, §14 "Waiting").
                        data-warm-item={itemId ?? undefined}
                        onClick={onOpen}
                        disabled={!hasItem}
                    >
                        <OpenGlyph />
                    </ActionIcon>
                </Tooltip>
                <Tooltip
                    label={isFullscreen ? "Leave full screen (F)" : "Full screen (F)"}
                    position="bottom"
                >
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size={44}
                        aria-label="Toggle full screen"
                        onClick={onToggleFullscreen}
                    >
                        <FullscreenGlyph />
                    </ActionIcon>
                </Tooltip>
                <Tooltip label="Close (Esc)" position="bottom">
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size={44}
                        aria-label="Close the tasting"
                        onClick={onClose}
                    >
                        <CloseGlyph />
                    </ActionIcon>
                </Tooltip>
            </div>

            <div className={classes.transport} {...pointer}>
                <Tooltip label="Previous (←)">
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size={44}
                        aria-label="Previous"
                        onClick={onPrevious}
                        disabled={!hasItem}
                    >
                        <PreviousGlyph />
                    </ActionIcon>
                </Tooltip>
                <Tooltip label={held ? "Play (Space)" : "Pause (Space)"}>
                    <ActionIcon
                        variant="subtle"
                        color="brass"
                        size={44}
                        aria-label={held ? "Play" : "Pause"}
                        onClick={onTogglePlay}
                        disabled={!hasItem}
                    >
                        {held ? <PlayGlyph /> : <PauseGlyph />}
                    </ActionIcon>
                </Tooltip>
                <Tooltip label="Next (→)">
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size={44}
                        aria-label="Next"
                        onClick={onNext}
                        disabled={!hasItem}
                    >
                        <NextGlyph />
                    </ActionIcon>
                </Tooltip>
                <Tooltip label={muted ? "Unmute (M)" : "Mute (M)"}>
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size={44}
                        aria-label={muted ? "Unmute" : "Mute"}
                        onClick={onToggleMute}
                    >
                        {muted ? <MutedGlyph /> : <SoundGlyph />}
                    </ActionIcon>
                </Tooltip>

                <Popover
                    opened={lengthsOpen}
                    onChange={onLengthsOpen}
                    position="top"
                    withArrow
                    shadow="md"
                >
                    <Popover.Target>
                        <ActionIcon
                            variant="subtle"
                            color="gray"
                            size={44}
                            aria-label="How long each item is shown"
                            onClick={() => onLengthsOpen(!lengthsOpen)}
                        >
                            <TimerGlyph />
                        </ActionIcon>
                    </Popover.Target>
                    <Popover.Dropdown {...pointer}>
                        <Stack gap="sm">
                            <div>
                                <Text size="xs" c="dimmed" mb={4}>
                                    Video clips
                                </Text>
                                <SegmentedControl
                                    size="sm"
                                    value={String(clipSeconds)}
                                    onChange={(value) =>
                                        onClipSeconds(snapTastingSeconds(value, clipSeconds))
                                    }
                                    data={TASTING_LENGTH_DATA}
                                />
                            </div>
                            <div>
                                <Text size="xs" c="dimmed" mb={4}>
                                    Photos
                                </Text>
                                <SegmentedControl
                                    size="sm"
                                    value={String(photoSeconds)}
                                    onChange={(value) =>
                                        onPhotoSeconds(snapTastingSeconds(value, photoSeconds))
                                    }
                                    data={TASTING_LENGTH_DATA}
                                />
                            </div>
                        </Stack>
                    </Popover.Dropdown>
                </Popover>
            </div>
        </>
    );
};
