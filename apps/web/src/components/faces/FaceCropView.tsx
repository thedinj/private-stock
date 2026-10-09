"use client";

import { Box } from "@mantine/core";

import type { FaceCrop } from "@private-stock/core";

import { spriteCropStyle } from "@/lib/spriteCrop";

/**
 * One face, cut out of a picture the browser can already fetch (§5f): a square around it in a
 * sprite tile or a photograph's cover. Square, so a strip of them lines up whatever the shape of
 * the frames they came from.
 */
export const FaceCropView: React.FC<{ crop: FaceCrop; size: number }> = ({ crop, size }) => (
    <Box
        role="img"
        aria-label="A face"
        style={{
            width: size,
            height: size,
            flex: "0 0 auto",
            borderRadius: 6,
            background: "var(--ps-well)",
            ...spriteCropStyle(crop.url, crop.rect),
        }}
    />
);
