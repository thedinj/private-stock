"use client";

import { useState } from "react";
import { Anchor, Button, Group, Popover, SegmentedControl, Stack, Text } from "@mantine/core";
import { DatePickerInput, type DatesRangeValue } from "@mantine/dates";
import dayjs from "dayjs";

import { describeDateFilter, describeDays } from "@/lib/filterWords";
import type { DateAxis, DayRange } from "@/lib/libraryQuery";

import { FilterRow } from "@/components/library/FilterRow";

/**
 * A date, filtered: a row of the library's filter panel, and a button in the /clips bar (§14e
 * "Dates").
 *
 * **The address holds a pair, the control offers a comparison.** A date filter is `from` and
 * `to`, either one open, both inclusive -- which is all the server needs and keeps the URL to
 * two readable days. Nobody thinks in pairs, though: they think "since the 3rd" or "on the
 * 3rd". So the control asks which comparison first, as four words, and each word sets the
 * pair: *Since* fills `from`, *Until* fills `to`, *On* fills both with one day, *Between* fills
 * both from a range. Switching between them keeps the day already picked.
 *
 * **Mantine's picker, not the browser's date box.** The native box draws its calendar in the
 * operating system's colours -- white on Windows, whatever the room -- and its text field reads
 * in the device's locale, so `10/03/2026` meant two different days depending on whose phone it
 * was. `DatePickerInput` draws in the theme's accent and surfaces, and reads "3 Oct 2026"
 * everywhere.
 *
 * **No "last 30 days".** A relative preset would be written into the address as the days it
 * meant when it was pressed, and a saved view made from it would then mean those days for ever
 * -- "recently added" quietly going stale. A relative filter needs a field of its own, and
 * nothing has asked for one yet.
 *
 * A range is applied once both ends are picked: the first click of a range is half a question,
 * and applying it would refetch the library for a "since" nobody meant.
 */

type Comparison = "since" | "until" | "between" | "on";

const COMPARISONS: { value: Comparison; label: string }[] = [
    { value: "since", label: "Since" },
    { value: "until", label: "Until" },
    { value: "between", label: "Between" },
    { value: "on", label: "On" },
];

const comparisonOf = (range: DayRange): Comparison => {
    if (range.from !== null && range.to !== null) {
        return range.from === range.to ? "on" : "between";
    }

    return range.to !== null ? "until" : "since";
};

/** A day as the picker holds it: local midnight, which is how `dayjs` reads a bare day. */
const toDate = (day: string | null): Date | null => (day === null ? null : dayjs(day).toDate());

const toDay = (date: Date | null): string | null =>
    date === null ? null : dayjs(date).format("YYYY-MM-DD");

/** The pair a comparison makes of one day. */
const rangeFor = (comparison: Comparison, day: string | null): DayRange => {
    if (day === null) return { from: null, to: null };

    switch (comparison) {
        case "since":
            return { from: day, to: null };
        case "until":
            return { from: null, to: day };
        case "on":
        case "between":
            return { from: day, to: day };
    }
};

interface DateRangeControlProps {
    range: DayRange;
    onChange: (range: DayRange) => void;
    /** What the picker sets, for a screen reader: "Date added". */
    label: string;
    /** One line under the picker, for a date some items do not have. */
    hint?: string;
    /**
     * Whether the control is itself inside a popover. The calendar then opens in place rather
     * than in a portal: a click on a portalled calendar lands outside the outer popover, which
     * closes it before the day is picked.
     */
    nested?: boolean;
}

/** The comparison and the picker, with nothing around them. */
const DateRangeControl: React.FC<DateRangeControlProps> = ({
    range,
    onChange,
    label,
    hint,
    nested = false,
}) => {
    const [chosen, setChosen] = useState<Comparison>(() => comparisonOf(range));
    /**
     * The range being picked, while only its first end is. Held here rather than applied, for
     * the reason the component's comment gives; dropped once both ends are in.
     */
    const [picking, setPicking] = useState<DatesRangeValue | null>(null);
    const set = range.from !== null || range.to !== null;
    /**
     * What a set filter says wins over what was last clicked, so a view opened from a saved
     * filter or the back button shows its own comparison. Between is the exception: it can hold
     * any pair, including the one-day pair On would also describe.
     */
    const comparison = !set || chosen === "between" ? chosen : comparisonOf(range);
    const pickerProps = {
        size: "xs",
        clearable: true,
        valueFormat: "D MMM YYYY",
        popoverProps: { withinPortal: !nested },
    } as const;

    const switchTo = (next: Comparison) => {
        setChosen(next);
        setPicking(null);

        // The day already chosen carries over: "since the 3rd" becomes "on the 3rd".
        if (set && next !== "between") {
            onChange(rangeFor(next, range.from ?? range.to));
        }
    };

    return (
        <>
            <SegmentedControl
                size="xs"
                fullWidth
                color="brass"
                value={comparison}
                onChange={(value) => switchTo(value as Comparison)}
                data={COMPARISONS}
                aria-label={`${label}: how to compare`}
            />

            {comparison === "between" ? (
                <DatePickerInput
                    {...pickerProps}
                    type="range"
                    allowSingleDateInRange
                    placeholder="First and last day"
                    aria-label={`${label}, between`}
                    value={picking ?? [toDate(range.from), toDate(range.to)]}
                    onChange={([start, end]) => {
                        if (start !== null && end === null) {
                            setPicking([start, end]);
                            return;
                        }

                        setPicking(null);
                        onChange({ from: toDay(start), to: toDay(end) });
                    }}
                />
            ) : (
                <DatePickerInput
                    {...pickerProps}
                    placeholder="Pick a day"
                    aria-label={`${label}, ${comparison}`}
                    value={toDate(comparison === "until" ? range.to : range.from)}
                    onChange={(date) => onChange(rangeFor(comparison, toDay(date)))}
                />
            )}

            {hint && (
                <Text size="xs" c="dimmed">
                    {hint}
                </Text>
            )}

            {set && (
                <Group gap="md">
                    <Anchor
                        component="button"
                        type="button"
                        size="xs"
                        c="dimmed"
                        underline="never"
                        onClick={() => {
                            setPicking(null);
                            onChange({ from: null, to: null });
                        }}
                    >
                        clear
                    </Anchor>
                </Group>
            )}
        </>
    );
};

interface DateFilterProps {
    label: string;
    hint?: string;
    range: DayRange;
    onChange: (range: DayRange) => void;
    /** Whether this row is the one expanded. One at a time, owned by the panel. */
    open: boolean;
    onToggle: () => void;
}

/** One date as a row of the filter panel, closed by default like every row there. */
export const DateFilter: React.FC<DateFilterProps> = ({ open, onToggle, ...control }) => {
    const described = describeDays(control.range);

    return (
        <FilterRow
            label={control.label}
            value={described && described.charAt(0).toUpperCase() + described.slice(1)}
            open={open}
            onToggle={onToggle}
        >
            <DateRangeControl {...control} />
        </FilterRow>
    );
};

interface DateFilterButtonProps {
    axis: DateAxis;
    /** The button's word while nothing is set, and what the picker is read out as setting. */
    label: string;
    range: DayRange;
    onChange: (range: DayRange) => void;
}

/**
 * One date as a toolbar button opening the same control: /clips, whose filters are a bar
 * rather than a column. Once set, the button says what the filter does in the chip's words.
 */
export const DateFilterButton: React.FC<DateFilterButtonProps> = ({
    axis,
    label,
    range,
    onChange,
}) => {
    const [open, setOpen] = useState(false);
    const described = describeDateFilter(axis, range);

    return (
        <Popover
            opened={open}
            onChange={setOpen}
            position="bottom-start"
            width={300}
            shadow="md"
            withinPortal
        >
            <Popover.Target>
                <Button
                    size="sm"
                    variant={described ? "light" : "default"}
                    color="brass"
                    onClick={() => setOpen((current) => !current)}
                >
                    {described ?? label}
                </Button>
            </Popover.Target>
            <Popover.Dropdown>
                <Stack gap={6}>
                    <DateRangeControl label={label} range={range} onChange={onChange} nested />
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
};
