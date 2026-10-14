import Link from "next/link";
import { HoverCard } from "@mantine/core";

import type { OcrBox, OcrFrame } from "@private-stock/core";

import { rememberReturn } from "@/lib/returnTo";

import classes from "./OcrReview.module.scss";

interface OcrThumbProps {
    mediaId: string;
    /** The sprite tile for the moment, when the item has sprites. */
    frame: OcrFrame | null;
    coverUrl: string | null;
    /** Where the text sits, as fractions of the frame. Drawn only over a frame. */
    box: OcrBox | null;
    atMs: number | null;
    /** Rendered width in pixels; the height follows the frame. */
    width: number;
    /** Names the picture for a screen reader, and on hover. */
    label: string;
}

const BOX_PAD = 3;

/** A tile of a sprite sheet, scaled to `width`, with the text's box drawn over it. */
const Tile: React.FC<{ frame: OcrFrame; box: OcrBox | null; width: number }> = ({
    frame,
    box,
    width,
}) => {
    const scale = width / frame.width;

    return (
        <span
            className={classes.tile}
            style={{
                width,
                height: frame.height * scale,
                backgroundImage: `url(${frame.url})`,
                backgroundSize: `${frame.sheetWidth * scale}px ${frame.sheetHeight * scale}px`,
                backgroundPosition: `${-frame.x * scale}px ${-frame.y * scale}px`,
            }}
        >
            {/* Padded out from the text by a few pixels: a line of watermark is a couple of
                percent of the frame, which on a thumbnail is a box two pixels tall that reads
                as a stray line rather than as a frame around something. */}
            {box && (
                <span
                    className={classes.box}
                    style={{
                        left: `calc(${box.x * 100}% - ${BOX_PAD}px)`,
                        top: `calc(${box.y * 100}% - ${BOX_PAD}px)`,
                        width: `calc(${box.w * 100}% + ${BOX_PAD * 2}px)`,
                        height: `calc(${box.h * 100}% + ${BOX_PAD * 2}px)`,
                    }}
                />
            )}
        </span>
    );
};

/**
 * The picture beside a string: what the engine was looking at when it read it (§5d).
 *
 * A tile of the item's own sprite sheet at the moment the string was first read — so judging a
 * reading costs a glance rather than opening the player, and producing it costs nothing because
 * the sheets already exist for the scrubber. The text's box is drawn on it, which is often the
 * whole answer: a box over a face is not a watermark.
 *
 * Without sprites (a still, or a video not yet processed) the cover stands in, without a box:
 * the cover is a different moment, and a box drawn on it would point at the wrong thing.
 *
 * Opens the item at that moment. Hovering on a desktop shows the tile larger.
 */
export const OcrThumb: React.FC<OcrThumbProps> = ({
    mediaId,
    frame,
    coverUrl,
    box,
    atMs,
    width,
    label,
}) => {
    const href = atMs === null ? `/media/${mediaId}` : `/media/${mediaId}?at=${atMs}`;

    const picture = frame ? (
        <Tile frame={frame} box={box} width={width} />
    ) : coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={coverUrl}
            alt=""
            loading="lazy"
            className={classes.cover}
            style={{ width, height: Math.round((width * 9) / 16) }}
        />
    ) : (
        <span className={classes.cover} style={{ width, height: Math.round((width * 9) / 16) }} />
    );

    const link = (
        <Link
            href={href}
            prefetch={false}
            onClick={rememberReturn}
            className={classes.thumb}
            // Lit while the item is on its way (§14, "Waiting").
            data-open-frame
            aria-label={`Open ${label}${atMs === null ? "" : " at this moment"}`}
            title={label}
        >
            {picture}
        </Link>
    );

    if (!frame) {
        return link;
    }

    return (
        <HoverCard openDelay={350} position="right" withinPortal shadow="md">
            <HoverCard.Target>{link}</HoverCard.Target>
            <HoverCard.Dropdown p={4} visibleFrom="sm">
                <Tile frame={frame} box={box} width={Math.min(480, frame.width * 2.4)} />
            </HoverCard.Dropdown>
        </HoverCard>
    );
};
