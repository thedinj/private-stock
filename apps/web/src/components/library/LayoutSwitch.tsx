"use client";

import { Group, SegmentedControl } from "@mantine/core";

import { GalleryGlyph, GridGlyph } from "@/components/media/Glyph";

/**
 * Grid or gallery, for any page that lays items out in tiles (§14b).
 *
 * One component so the library and a playlist offer the same switch: the same icons, the same
 * words, the same height. Icon and word on a desktop; the icon alone on a phone, where the
 * header row has no room for both and the word is the tooltip.
 */
interface LayoutSwitchProps {
    value: "grid" | "gallery";
    onChange: (value: "grid" | "gallery") => void;
    /** A phone: icons only, at a thumb's height. */
    touch?: boolean;
}

const TOUCH_HEIGHT = "2.75rem";

export const LayoutSwitch: React.FC<LayoutSwitchProps> = ({ value, onChange, touch = false }) => (
    <SegmentedControl
        value={value}
        onChange={(next) => onChange(next === "gallery" ? "gallery" : "grid")}
        data={[
            {
                value: "grid",
                label: (
                    <Group gap={6} wrap="nowrap" title="Grid">
                        <GridGlyph />
                        {touch ? null : "Grid"}
                    </Group>
                ),
            },
            {
                value: "gallery",
                label: (
                    <Group gap={6} wrap="nowrap" title="Gallery">
                        <GalleryGlyph />
                        {touch ? null : "Gallery"}
                    </Group>
                ),
            },
        ]}
        aria-label="Layout"
        styles={touch ? { root: { height: TOUCH_HEIGHT } } : undefined}
    />
);
