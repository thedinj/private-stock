"use client";

import { Chip, Group } from "@mantine/core";

import { FilterRow } from "@/components/library/FilterRow";

/**
 * A filter with a handful of named answers, in the same row as the ranges (§14e).
 *
 * Orientation and movement are not measurements — there is no "between landscape and
 * portrait" — but they sit in the same column and answer the same kind of question, so they
 * get the same shape. Two rows drawn differently in one section would suggest a difference in
 * how they behave, and there is none.
 *
 * **No "Any" option.** Absence of a choice is the unfiltered state, and offering it as a
 * fourth chip would be offering a filter that filters nothing — so clearing is the same
 * gesture it is everywhere else here: click the chip that is already chosen. A row with
 * nothing set says nothing beside its name, as every row in the section does.
 */

interface ChoiceOption<T extends string> {
    value: T;
    label: string;
}

interface ChoiceFilterProps<T extends string> {
    label: string;
    options: ChoiceOption<T>[];
    value: T | null;
    open: boolean;
    onToggle: () => void;
    onChange: (value: T | null) => void;
}

export const ChoiceFilter = <T extends string>({
    label,
    options,
    value,
    open,
    onToggle,
    onChange,
}: ChoiceFilterProps<T>) => (
    <FilterRow
        label={label}
        value={options.find((option) => option.value === value)?.label ?? null}
        open={open}
        onToggle={onToggle}
    >
        <Group gap={6}>
            {options.map((option) => (
                <Chip
                    key={option.value}
                    size="xs"
                    color="oak"
                    variant="outline"
                    checked={value === option.value}
                    onChange={() => onChange(value === option.value ? null : option.value)}
                >
                    {option.label}
                </Chip>
            ))}
        </Group>
    </FilterRow>
);
