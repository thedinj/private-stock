"use client";

import { useState } from "react";
import { Box, Button, CloseButton, Group, Stack, Text, TextInput } from "@mantine/core";

import { useLookSource } from "@/lib/api/lookSource";
import { withLook, type LibraryView } from "@/lib/libraryQuery";
import { formatTimecode } from "@/lib/timecode";

/**
 * The Filters panel's Look section: what the library should look like (§5e "Three ways in, one
 * way out").
 *
 * Words, or the moment "More like this" was pressed on — one or the other, never both. Words are
 * asked for when Enter is pressed rather than as they are typed: each look is a ranking of the
 * whole library, and the first after a quiet spell waits for the text model to load, so a look
 * per keystroke would be a queue of rankings nobody asked for.
 *
 * Not the search box, deliberately: the box finds what an item is called or tagged, and a look
 * orders by what it looks like. The two combine — "jane" in the box and "beach" here is Jane's
 * items, the most beach-like first.
 */

interface LookSectionProps {
    view: LibraryView;
    onChange: (next: LibraryView) => void;
}

export const LookSection: React.FC<LookSectionProps> = ({ view, onChange }) => {
    if (view.like) {
        return <LookFromMoment view={view} onChange={onChange} />;
    }

    // Keyed by the view's words, so a look changed elsewhere -- its chip removed, the back
    // button -- starts the box again from what is in force.
    return <LookInWords key={view.lookText} view={view} onChange={onChange} />;
};

const LookInWords: React.FC<LookSectionProps> = ({ view, onChange }) => {
    const [draft, setDraft] = useState(view.lookText);
    const changed = draft.trim() !== view.lookText;

    const ask = () => onChange(withLook(view, { lookText: draft }));

    return (
        <Stack gap={6}>
            <TextInput
                aria-label="Looks like"
                placeholder="Looks like… neon at night"
                value={draft}
                maxLength={200}
                onChange={(event) => setDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") ask();
                }}
                rightSection={
                    view.lookText || draft ? (
                        <CloseButton
                            aria-label="Clear the look"
                            onClick={() => {
                                setDraft("");
                                onChange(withLook(view, { lookText: "" }));
                            }}
                        />
                    ) : null
                }
            />
            {changed && draft.trim() !== "" ? (
                <Button size="compact-sm" variant="light" color="brass" onClick={ask}>
                    Look
                </Button>
            ) : (
                <Text size="xs" c="dimmed">
                    The few hundred best matches, best first. Or press “More like this” while
                    watching.
                </Text>
            )}
        </Stack>
    );
};

const LookFromMoment: React.FC<LookSectionProps> = ({ view, onChange }) => {
    const { item, atMs } = useLookSource(view.like);

    return (
        <Group gap="sm" wrap="nowrap" align="center">
            <Box
                w={72}
                style={{
                    flex: "0 0 auto",
                    aspectRatio: "16 / 9",
                    borderRadius: 4,
                    background: item?.coverUrl
                        ? `center / cover no-repeat url(${item.coverUrl})`
                        : "var(--ps-well)",
                }}
            />
            <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                <Text size="sm">
                    More like this{atMs === null ? "" : ` at ${formatTimecode(atMs)}`}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                    {item?.title ?? "…"}
                </Text>
            </Stack>
            <CloseButton
                aria-label="Clear the look"
                onClick={() => onChange(withLook(view, { like: "" }))}
            />
        </Group>
    );
};
