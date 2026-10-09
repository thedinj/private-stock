"use client";

import { SegmentedControl } from "@mantine/core";

import { BROWSE_TOUCH_HEIGHT } from "./BrowseToolbar";

/**
 * Rows or tiles, for a browse page (§6 "Tags", §14c).
 *
 * Rows show range -- a name and a strip of what it holds -- and scan downward, which is what a
 * list of hundreds needs. Tiles show a face, larger, for somebody who knows the list by sight.
 * One control so every browse page offers the same words in the same place.
 */

export const BROWSE_LAYOUTS = ["rows", "tiles"] as const;
export type BrowseLayout = (typeof BROWSE_LAYOUTS)[number];

const LAYOUTS: { value: BrowseLayout; label: string }[] = [
    { value: "rows", label: "Rows" },
    { value: "tiles", label: "Tiles" },
];

export const RowsTilesSwitch: React.FC<{
    value: BrowseLayout;
    onChange: (layout: BrowseLayout) => void;
    /** A phone: full width and thumb height. */
    touch?: boolean;
}> = ({ value, onChange, touch = false }) => (
    <SegmentedControl
        value={value}
        onChange={(next) => onChange(next === "tiles" ? "tiles" : "rows")}
        data={LAYOUTS}
        color="brass"
        size="sm"
        aria-label="Layout"
        fullWidth={touch}
        styles={touch ? { label: { lineHeight: BROWSE_TOUCH_HEIGHT } } : undefined}
    />
);
