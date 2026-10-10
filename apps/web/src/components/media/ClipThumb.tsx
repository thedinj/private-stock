"use client";

import { Box } from "@mantine/core";

import type { Clip } from "@private-stock/core";

import { centreSquare, spriteCropStyle } from "@/lib/spriteCrop";

/**
 * A clip's face, cropped out of the scrubber's sprite sheet (§14d).
 *
 * The cheapest picture in the app. Every video already carries a sheet of tiles a few seconds
 * apart, generated for the scrubber's filmstrip and paid for whether or not anything else uses it,
 * so a clip's thumbnail costs no ffmpeg, no `Artifact` row, no disk and nothing for `db:reset` to
 * clear — it is a `background-position` into a sheet the browser has very likely already fetched
 * for the same item.
 *
 * The crop is in percentages, so it scales with whatever box it is given (`spriteCropStyle`).
 *
 * Falls back to the item's cover when there is no sheet yet, which is ordinary rather than a
 * fault: a freshly scanned item has none until the `sprite` stage runs.
 */

interface ClipThumbProps {
    clip: Clip;
    /** A fixed width, for a strip. Omitted, it fills its container — which is what a card wants. */
    width?: number;
    /**
     * Crop to the centre square of the frame, so a wall of clips from films and phone videos
     * lines up instead of every card taking its own source's shape.
     */
    square?: boolean;
    fallbackUrl?: string | null;
    /** Drawn over the picture: a checkbox, a running time, a badge. */
    children?: React.ReactNode;
}

export const ClipThumb: React.FC<ClipThumbProps> = ({
    clip,
    width,
    square = false,
    fallbackUrl = null,
    children,
}) => {
    const rect = clip.thumbRect && square ? centreSquare(clip.thumbRect) : clip.thumbRect;

    return (
        <Box
            style={{
                position: "relative",
                width: width ? `${width}px` : "100%",
                flex: width ? "0 0 auto" : undefined,
                aspectRatio: square ? "1 / 1" : rect ? `${rect.width} / ${rect.height}` : "16 / 9",
                borderRadius: 4,
                overflow: "hidden",
                background: fallbackUrl
                    ? `center / cover no-repeat url(${fallbackUrl})`
                    : "var(--ps-well)",
            }}
        >
            {rect && clip.thumbUrl && (
                <Box
                    style={{
                        position: "absolute",
                        inset: 0,
                        ...spriteCropStyle(clip.thumbUrl, rect),
                    }}
                />
            )}

            {children}
        </Box>
    );
};
