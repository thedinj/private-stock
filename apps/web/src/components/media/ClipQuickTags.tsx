"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Box, Group, Stack, Text } from "@mantine/core";

import { allowsPrivate, clipTagKinds, type Clip, type ClipTag } from "@private-stock/core";

import { DestinationControl } from "@/components/tags/DestinationControl";
import { ItemTagChip } from "@/components/tags/ItemTagChip";
import { TagNameInput } from "@/components/tags/TagNameInput";
import { useClipFacetTags } from "@/lib/api/itemTags";
import { destinationKey, destinationsFor, type TagDestination } from "@/lib/tagDestinations";

/**
 * One clip's tags in a small space: its chips, and one box to add more (§14d "Tagging clips").
 *
 * For the clip wall's popover, where the clip editor's three boxes -- one per facet and
 * audience -- would be most of the screen. (The viewer has room, and keys, for all three:
 * `ClipTagFields`.) The box is the clip bar's: a switch
 * says where a typed name goes, and the chips of every facet sit together in one row.
 *
 * Each facet and audience keeps its own save queue (`useClipFacetTags`), as in the editor, so
 * the chips are drawn by one small component per destination and the box hands a name to
 * whichever one the switch is on.
 */

const DESTINATIONS = destinationsFor(clipTagKinds);

const scopeOf = (tag: ClipTag) => (tag.private ? "private" : "public");

type Adders = MutableRefObject<Map<string, (name: string) => void>>;

interface DestinationChipsProps {
    clip: Clip;
    destination: TagDestination;
    adders: Adders;
}

/** One destination's chips, and the queue its names are saved through. */
const DestinationChips: React.FC<DestinationChipsProps> = ({ clip, destination, adders }) => {
    const saved = clip.tags.filter(
        (tag) => tag.kind === destination.kind && scopeOf(tag) === destination.scope
    );
    const { chips, add, remove, error } = useClipFacetTags(
        clip.id,
        clip.mediaId,
        destination.kind,
        destination.scope,
        saved
    );
    const key = destinationKey(destination);
    const marked = allowsPrivate(destination.kind) && destination.scope === "private";

    useEffect(() => {
        adders.current.set(key, add);
    }, [adders, key, add]);

    return (
        <>
            {chips.map((chip) => (
                <ItemTagChip
                    key={chip.name}
                    // Said on the chip, since the row mixes both audiences of a keyword.
                    chip={marked ? { ...chip, name: `${chip.name} (private)` } : chip}
                    onRemove={() => remove(chip.name)}
                />
            ))}
            {error && (
                <Text size="xs" c="oxblood">
                    {error}
                </Text>
            )}
        </>
    );
};

interface ClipQuickTagsProps {
    clip: Clip;
}

export const ClipQuickTags: React.FC<ClipQuickTagsProps> = ({ clip }) => {
    const [destination, setDestination] = useState<TagDestination>(DESTINATIONS[0]);
    const adders: Adders = useRef(new Map());
    const here = clip.tags
        .filter((tag) => tag.kind === destination.kind && scopeOf(tag) === destination.scope)
        .map((tag) => tag.name);

    return (
        <Stack gap="xs">
            <Group gap={6} wrap="wrap">
                {DESTINATIONS.map((option) => (
                    <DestinationChips
                        key={destinationKey(option)}
                        clip={clip}
                        destination={option}
                        adders={adders}
                    />
                ))}
            </Group>
            <Box>
                <DestinationControl
                    size="xs"
                    options={DESTINATIONS}
                    value={destination}
                    onChange={setDestination}
                />
            </Box>
            <TagNameInput
                kind={destination.kind}
                scope={destination.scope}
                value={[]}
                exclude={here}
                placeholder="Add a tag, Enter to save"
                onChange={(next) =>
                    next.forEach((name) => adders.current.get(destinationKey(destination))?.(name))
                }
                aria-label="Add a tag to this clip"
                autoFocus
                // The suggestions open in place rather than in a portal of their own: the
                // popover counts a click in another portal as a click outside it, and would
                // close under the suggestion being picked.
                comboboxProps={{ withinPortal: false }}
            />
            {/* Said once, where the choice is made (§14d), as the clip bar does. */}
            {allowsPrivate(destination.kind) && (
                <Text size="xs" c="dimmed">
                    Clip tags are only visible to you. Shared means the library&rsquo;s word;
                    private means your own.
                </Text>
            )}
        </Stack>
    );
};
