"use client";

import { useState } from "react";
import { Anchor, Chip, Group, NumberInput, Text } from "@mantine/core";

import { bandFor, describeRange, type RangeBand } from "@private-stock/core";

import { FilterRow } from "@/components/library/FilterRow";

/**
 * One measurable axis, filtered (§14e).
 *
 * **The presets are the interface and the numbers are the escape hatch.** Nobody knows what
 * bitrate they want; they know "the ones that look bad". A pair of empty number boxes asks a
 * question most people cannot answer and the control goes unused — so the bands come first,
 * already phrased as the thing being looked for, and the raw bounds are one click away for
 * the case they do not cover.
 *
 * One component for all five axes rather than five tuned ones. They differ only in their
 * bands and their unit, and those are data; five hand-written controls would be five places
 * for "min inclusive, max exclusive" to be got subtly differently.
 *
 * Single-select, because a range is one range. Two bands cannot be held at once without the
 * filter becoming an OR, and OR is the wrong shape here — every other filter in the panel
 * narrows as you add to it, and one that widened would read as broken (§14).
 *
 * The row it sits in, and the reason it is closed by default, are `FilterRow`'s.
 */

interface RangeFilterProps {
    label: string;
    bands: RangeBand[];
    /** Names what a typed number is, in the summary row: "900 px and up". */
    unit: string;
    /**
     * One line shown only beside the typed boxes, for a unit that is not self-evident.
     *
     * Resolution is the only one that has one, and it needs it exactly there: the bands say
     * "1080p (1080–1439)" and carry their own meaning, but a number typed into "from" is
     * measured against the shorter side rather than the height, and nothing else would say so.
     */
    hint?: string;
    min: number | null;
    max: number | null;
    /** Whether this axis is the one currently expanded. One at a time, owned by the panel. */
    open: boolean;
    onToggle: () => void;
    onChange: (min: number | null, max: number | null) => void;
}

export const RangeFilter: React.FC<RangeFilterProps> = ({
    label,
    bands,
    unit,
    hint,
    min,
    max,
    open,
    onToggle,
    onChange,
}) => {
    const active = bandFor(bands, min, max);
    const set = min !== null || max !== null;

    /**
     * Whether the typed boxes are showing, once this axis is open.
     *
     * Defaulted to open for a range that matches no band, which is the case that matters: a
     * filter arriving from a shared link or a saved view must be visible in the control that
     * owns it rather than only in the summary row.
     */
    const [custom, setCustom] = useState(set && !active);

    return (
        <FilterRow
            label={label}
            value={describeRange(bands, min, max, unit)}
            open={open}
            onToggle={onToggle}
        >
            <Group gap={6}>
                {bands.map((band) => (
                    <Chip
                        key={band.id}
                        size="xs"
                        color="oak"
                        variant="outline"
                        checked={active?.id === band.id}
                        onChange={() =>
                            // Clicking the band already chosen clears it, the same gesture the
                            // rating control uses. Without it the only way back to "any" would
                            // be a separate control.
                            active?.id === band.id
                                ? onChange(null, null)
                                : onChange(band.min ?? null, band.max ?? null)
                        }
                    >
                        {band.label}
                    </Chip>
                ))}
            </Group>

            <Group gap="md">
                <Anchor
                    component="button"
                    type="button"
                    size="xs"
                    c="dimmed"
                    underline="never"
                    onClick={() => setCustom((showing) => !showing)}
                >
                    {custom ? "presets" : "exact…"}
                </Anchor>

                {set && (
                    <Anchor
                        component="button"
                        type="button"
                        size="xs"
                        c="dimmed"
                        underline="never"
                        onClick={() => {
                            onChange(null, null);
                            setCustom(false);
                        }}
                    >
                        clear
                    </Anchor>
                )}
            </Group>

            {custom && hint && (
                <Text size="xs" c="dimmed">
                    {hint}
                </Text>
            )}

            {custom && (
                <Group gap="xs" wrap="nowrap">
                    {/* "from" and "to" rather than "min" and "max": the boxes are read by
                        somebody describing a range, not by somebody reading the schema. */}
                    <NumberInput
                        size="xs"
                        placeholder="from"
                        min={0}
                        value={min ?? ""}
                        onChange={(value) =>
                            onChange(typeof value === "number" ? value : null, max)
                        }
                        style={{ flex: 1 }}
                    />
                    <Text size="xs" c="dimmed">
                        to
                    </Text>
                    <NumberInput
                        size="xs"
                        placeholder="to"
                        min={0}
                        value={max ?? ""}
                        onChange={(value) =>
                            onChange(min, typeof value === "number" ? value : null)
                        }
                        style={{ flex: 1 }}
                    />
                </Group>
            )}

            {/*
             * The half-open convention, read exactly when it applies.
             *
             * It used to sit permanently above all five axes, costing two lines on every visit
             * to explain a rule that only matters while somebody is choosing a band.
             */}
            <Text size="xs" c="dimmed">
                Each band starts at its first number and stops below the next. Items not yet probed
                have no measurement and match none of them.
            </Text>
        </FilterRow>
    );
};
