"use client";

import { Fragment, useState } from "react";
import { Box, Group, Kbd, SimpleGrid, Stack, Text } from "@mantine/core";

import { clipTagKinds, type Clip, type ClipTag } from "@private-stock/core";

import { ItemTagChip } from "@/components/tags/ItemTagChip";
import { TagNameInput } from "@/components/tags/TagNameInput";
import { useClipFacetTags } from "@/lib/api/itemTags";
import { facetLabelPlural } from "@/lib/facetLabels";
import { destinationsFor, type TagDestination } from "@/lib/tagDestinations";
import { facetField, fieldKey, fieldTitle, type ViewerField } from "@/lib/viewerKeys";

/**
 * A clip's tags under the clip viewer's picture, one box per facet and audience (§14d "Tagging
 * clips").
 *
 * Three boxes rather than the popover's one box and a switch: under a player the hands are on
 * the keyboard, and a switch is a thing to tab to and arrow through before every name. Each box
 * is labelled with the item page's key for the same field -- w, t, Shift+T (`viewerKeys.ts`) --
 * and `ClipViewer` listens for them, so a name goes where it belongs in one press.
 *
 * The boxes carry `data-clip-field` rather than the item page's `data-viewer-field`: the viewer
 * is a dialogue over the clip wall and finds its own boxes, and nothing on the item page should
 * ever find these.
 */

const DESTINATIONS = destinationsFor(clipTagKinds);

const scopeOf = (tag: ClipTag) => (tag.private ? "private" : "public");

const KeyLabel: React.FC<{ field: ViewerField }> = ({ field }) => (
    <Group gap={6} wrap="nowrap">
        <Text size="sm" fw={500}>
            {fieldTitle(field, facetLabelPlural)}
        </Text>
        <Text size="xs" span style={{ whiteSpace: "nowrap" }}>
            {fieldKey(field).map((key, index) => (
                <Fragment key={key}>
                    {index > 0 && "+"}
                    <Kbd size="xs">{key}</Kbd>
                </Fragment>
            ))}
        </Text>
    </Group>
);

interface FieldProps {
    clip: Clip;
    destination: TagDestination;
}

const ClipTagField: React.FC<FieldProps> = ({ clip, destination }) => {
    const { kind, scope } = destination;
    const saved = clip.tags.filter((tag) => tag.kind === kind && scopeOf(tag) === scope);
    const { chips, add, remove, error } = useClipFacetTags(
        clip.id,
        clip.mediaId,
        kind,
        scope,
        saved
    );
    const field = facetField(kind, scope);
    const [search, setSearch] = useState("");

    /**
     * Escape clears a half-typed name, then leaves the box -- as on the item page -- and never
     * closes the viewer from inside one: stopped here, before the dialogue hears it.
     */
    const onEscape = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "Escape" || !(event.target instanceof HTMLInputElement)) return;

        event.preventDefault();
        event.stopPropagation();

        if (search !== "") setSearch("");
        else event.target.blur();
    };

    const plural = facetLabelPlural(kind).toLowerCase();

    return (
        <Stack gap={4} miw={0}>
            {field && <KeyLabel field={field} />}
            <Box onKeyDownCapture={onEscape}>
                <TagNameInput
                    kind={kind}
                    scope={scope}
                    value={[]}
                    exclude={chips.map((chip) => chip.name)}
                    placeholder={scope === "public" ? `Add ${plural}…` : `Add private ${plural}…`}
                    onChange={(next) => next.forEach(add)}
                    searchValue={search}
                    onSearchChange={setSearch}
                    error={error ?? undefined}
                    data-clip-field={field ?? undefined}
                    aria-keyshortcuts={field ? fieldKey(field).join("+") : undefined}
                />
            </Box>
            {chips.length > 0 && (
                <Group gap={6} wrap="wrap" mt={2}>
                    {chips.map((chip) => (
                        <ItemTagChip
                            key={chip.name}
                            chip={chip}
                            onRemove={() => remove(chip.name)}
                        />
                    ))}
                </Group>
            )}
        </Stack>
    );
};

/** The keys these boxes answer, for the viewer's listener. */
export const CLIP_TAG_FIELDS: readonly ViewerField[] = DESTINATIONS.map((destination) =>
    facetField(destination.kind, destination.scope)
).filter((field): field is ViewerField => field !== null);

export const ClipTagFields: React.FC<{ clip: Clip }> = ({ clip }) => (
    <Stack gap={6}>
        <SimpleGrid cols={{ base: 1, sm: DESTINATIONS.length }} spacing="sm">
            {DESTINATIONS.map((destination) => (
                <ClipTagField
                    key={`${destination.scope}:${destination.kind}`}
                    clip={clip}
                    destination={destination}
                />
            ))}
        </SimpleGrid>
        {/* Said once (§14d): "shared" there names whose word it is, not who can see it. */}
        <Text size="xs" c="dimmed">
            Clip tags are only visible to you. Keywords are the library&rsquo;s words; private
            keywords are your own.
        </Text>
    </Stack>
);
