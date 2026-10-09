"use client";

import { Group, Stack, Text, UnstyledButton } from "@mantine/core";

/**
 * One filter, as a single row that opens (§14e).
 *
 * The shape every control in "The file" section shares: a name on the left, the current value
 * on the right, and whatever sets it hidden until asked for. Extracted rather than repeated
 * because the row *is* the design — closed rows that still state their value are what let
 * eight filters live in a 260px column without burying the tag facets under them — and two
 * copies of it would drift in the one detail that matters, which is whether a set filter is
 * legible without opening anything.
 *
 * **Nothing is hidden by closing.** The row says what the filter is; opening is for changing
 * it, not for finding out what it says. That is the whole justification for collapsing by
 * default, and it is why the value is rendered here rather than left to each control.
 *
 * The children are rendered only while open. `Collapse` was tried and does not work here: the
 * button reported `aria-expanded="true"` while the panel stayed pinned at `height: 0px` — the
 * state right and the pixels wrong, which is the hardest kind of broken to catch by reading
 * the code. The animation was decoration, and keeping five sets of chips mounted to animate
 * them cost DOM on every render for nothing.
 */

interface FilterRowProps {
    label: string;
    /** What this filter currently says, or null when it is not set. */
    value: string | null;
    open: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}

export const FilterRow: React.FC<FilterRowProps> = ({ label, value, open, onToggle, children }) => (
    <Stack gap={4}>
        <UnstyledButton onClick={onToggle} aria-expanded={open}>
            <Group justify="space-between" wrap="nowrap" gap="xs">
                <Text size="sm" c="dimmed">
                    {label}
                </Text>

                <Group gap={4} wrap="nowrap">
                    {/* Brass when set and absent when not, so a filtered row is findable by
                        colour down a column of eight rather than by reading each one. An unset
                        row used to say "Any", seven times over, and a column of identical
                        values read as data to be checked rather than as nothing set. */}
                    {value && (
                        <Text size="xs" c="brass.4" lineClamp={1}>
                            {value}
                        </Text>
                    )}
                    <Text size="xs" c="dimmed" opacity={open || value ? 1 : 0.5}>
                        {open ? "▴" : "▾"}
                    </Text>
                </Group>
            </Group>
        </UnstyledButton>

        {open && (
            <Stack gap={6} pt={4} pb={6}>
                {children}
            </Stack>
        )}
    </Stack>
);
