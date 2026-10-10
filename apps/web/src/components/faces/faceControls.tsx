"use client";

import { useState } from "react";
import { Button, Group, Stack, Text } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";

import { normalizeName } from "@private-stock/core";

import { TagNameInput } from "@/components/tags/TagNameInput";
import { useTagSearch } from "@/lib/api/tags";

/**
 * The controls every face surface shares (§5f): what is being said of a person on a card, and the
 * box a performer's name is typed into.
 */

/**
 * What somebody is saying of a person on a card: them, not them, or unsure — left undecided, to be
 * asked about again later (§5f "Unsure"). "Someone else…" asks only the first two.
 */
export type TickState = "in" | "out" | "unsure";

/** The next state a press gives: them, then not them, then unsure, then them again. */
export const nextTick = (state: TickState, threeWay: boolean): TickState =>
    state === "in" ? "out" : state === "out" && threeWay ? "unsure" : "in";

/** How many existing names a coining box offers instead. */
const NEAR_NAMES = 4;

/**
 * A performer's name, typed or picked, and the button that tags with it.
 *
 * A typed name nobody has used coins a performer, which is cheap here and dear later — two
 * performers for one person are a merge somebody has to notice. So when what is typed is not
 * already a name but is close to some (the vocabulary's own search, typos included), those are
 * offered beside it, and the button says it is adding someone new.
 */
export const NameBox: React.FC<{
    action: (name: string) => string;
    busy: boolean;
    disabled: boolean;
    onName: (name: string) => void;
    autoFocus?: boolean;
}> = ({ action, busy, disabled, onName, autoFocus }) => {
    const [names, setNames] = useState<string[]>([]);
    const [typed, setTyped] = useState("");
    // What is typed counts as much as a picked chip: nobody should have to press Enter first.
    const name = (names[0] ?? typed).trim();
    const [debounced] = useDebouncedValue(names.length === 0 ? typed.trim() : "", 200);
    const search = useTagSearch("performer", "public", debounced, debounced !== "");
    const typedNorm = normalizeName(name);
    const near =
        names.length === 0 && debounced !== "" && debounced === typed.trim()
            ? (search.data?.tags ?? [])
            : [];
    const exists = near.some((tag) => tag.nameNorm === typedNorm);
    const coining = name !== "" && names.length === 0 && !exists && search.isSuccess;
    const offered = exists ? [] : near.slice(0, NEAR_NAMES);

    return (
        <Stack gap={6}>
            <Group gap="xs" wrap="wrap" align="flex-start">
                <TagNameInput
                    kind="performer"
                    scope="public"
                    value={names}
                    onChange={(next) => setNames(next.slice(-1))}
                    searchValue={typed}
                    onSearchChange={setTyped}
                    maxTags={1}
                    placeholder="Who is this?"
                    aria-label="Performer name"
                    autoFocus={autoFocus}
                    style={{ flex: "1 1 220px", minWidth: 0 }}
                />
                <Button
                    color="brass"
                    h={36}
                    disabled={!name || disabled}
                    loading={busy}
                    onClick={() => onName(name)}
                >
                    {name ? (coining ? `New performer: ${action(name)}` : action(name)) : "Tag"}
                </Button>
            </Group>
            {coining && offered.length > 0 && (
                <Group gap={6} wrap="wrap">
                    <Text size="xs" c="dimmed">
                        Already in the library:
                    </Text>
                    {offered.map((tag) => (
                        <Button
                            key={tag.id}
                            size="compact-xs"
                            variant="light"
                            color="gray"
                            onClick={() => {
                                setNames([tag.name]);
                                setTyped("");
                            }}
                        >
                            {tag.name}
                        </Button>
                    ))}
                </Group>
            )}
        </Stack>
    );
};
