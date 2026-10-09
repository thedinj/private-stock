"use client";

import { useMemo, useState } from "react";
import { Alert, Button, Checkbox, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import {
    SELECTION_TAG_LIMIT,
    allowsPrivate,
    type SelectionTagsResponse,
} from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { facetLabelPlural } from "@/lib/facetLabels";
import {
    describeCoverage,
    describePublicRemoval,
    groupByFacet,
    type TagSection,
} from "@/lib/selectionTags";
import { SectionLabel } from "@/components/media/SectionLabel";
import { ScopeLabel } from "@/components/tags/ScopeLabel";

/**
 * Taking tags off a selection (§14b).
 *
 * It used to be the Tag dialogue in another mode, which made removing a tag a spelling test:
 * a box, and whatever was typed had to match a name somebody else had coined. Getting it
 * wrong did nothing visible — and worse than nothing underneath, because the name went
 * through `ensureTag` on the way past, so a misspelt untag *created* vocabulary instead of
 * removing any.
 *
 * So the list comes first: everything the selection actually carries, with how much of it
 * carries each, and ticking is the whole gesture.
 *
 * **No facet control and no scope control**, unlike every other tag dialogue. Both are
 * properties of a tag that already exists, so they are reported here rather than chosen —
 * which is what makes it safe to show both systems at once. There is no switch to be wrong
 * about before removing something from everybody (§6).
 */

interface UntagDialogProps {
    opened: boolean;
    onClose: () => void;
    /** The ticked items, exactly as the grid has them. */
    selected: string[];
    onRemove: (tagIds: string[]) => void;
    busy: boolean;
}

interface SectionProps {
    section: TagSection;
    selectedCount: number;
    ticked: string[];
    onChange: (ticked: string[]) => void;
}

/**
 * One facet, laid out as the item editor lays it out (§14b): its name, then a box per system,
 * with Shared and Private said only where the facet can be either -- a performer or a source
 * is always the library's, and is never labelled as such.
 */
const Section: React.FC<SectionProps> = ({ section, selectedCount, ticked, onChange }) => (
    <Stack gap={6}>
        <SectionLabel>{facetLabelPlural(section.kind)}</SectionLabel>

        {section.boxes.map((box) => (
            <Stack key={box.scope} gap={4}>
                {allowsPrivate(section.kind) && <ScopeLabel scope={box.scope} />}

                <Checkbox.Group value={ticked} onChange={onChange}>
                    <Stack gap={4}>
                        {box.tags.map((tag) => (
                            <Checkbox
                                key={tag.tagId}
                                value={tag.tagId}
                                label={
                                    <Group gap={8} align="baseline" wrap="nowrap">
                                        <Text size="sm">{tag.name}</Text>
                                        <Text size="xs" c="dimmed">
                                            {describeCoverage(tag.count, selectedCount)}
                                        </Text>
                                    </Group>
                                }
                            />
                        ))}
                    </Stack>
                </Checkbox.Group>
            </Stack>
        ))}
    </Stack>
);

export const UntagDialog: React.FC<UntagDialogProps> = ({
    opened,
    onClose,
    selected,
    onRemove,
    busy,
}) => {
    const [ticked, setTicked] = useState<string[]>([]);

    /**
     * Sorted before it is joined, so re-ticking the same items in another order is a cache
     * hit rather than a second count of the same set.
     */
    const key = useMemo(() => [...selected].sort().join(","), [selected]);

    const carried = useQuery({
        queryKey: queryKeys.tags.selection(key),
        queryFn: () =>
            api<SelectionTagsResponse>("/api/media/bulk/tags", {
                method: "POST",
                body: JSON.stringify({ mediaIds: selected }),
            }),
        enabled: opened,
    });

    const tags = carried.data?.tags ?? [];
    /** The denominator every count is read against, as the server counted it. */
    const selectedCount = carried.data?.selected ?? selected.length;
    const sections = groupByFacet(tags);
    const publicRemoval = describePublicRemoval(tags.filter((tag) => ticked.includes(tag.tagId)));

    const close = () => {
        setTicked([]);
        onClose();
    };

    return (
        <Modal
            opened={opened}
            onClose={close}
            title={`Untag ${selected.length} item${selected.length === 1 ? "" : "s"}`}
            centered
        >
            <Stack gap="md">
                {carried.isLoading ? (
                    <Group gap="xs">
                        <Loader size="xs" color="brass" />
                        <Text size="sm" c="dimmed">
                            Reading what these carry…
                        </Text>
                    </Group>
                ) : tags.length === 0 ? (
                    <Text size="sm" c="dimmed">
                        Nothing selected carries a tag you can remove.
                    </Text>
                ) : (
                    <>
                        {carried.data?.truncated && (
                            /* Named rather than silently trimmed: a list somebody cannot see
                               the end of is a tag they cannot remove (§5c). */
                            <Alert color="brass" variant="light">
                                Showing the {SELECTION_TAG_LIMIT.toLocaleString()} most common.
                                Untag fewer items at a time to reach the rest.
                            </Alert>
                        )}

                        {sections.map((section) => (
                            <Section
                                key={section.kind}
                                section={section}
                                selectedCount={selectedCount}
                                ticked={ticked}
                                onChange={setTicked}
                            />
                        ))}

                        {/* The button cannot name the audience when a tick spans both systems,
                            so the sentence does, naming what is ticked. §6 asks a bulk write to
                            say who it reaches, and "for everyone" over a mixed set would be half
                            true. */}
                        {publicRemoval && (
                            <Text size="xs" c="dimmed">
                                {publicRemoval}
                            </Text>
                        )}
                    </>
                )}

                <Group justify="flex-end">
                    <Button variant="default" onClick={close}>
                        Cancel
                    </Button>
                    <Button
                        color="oxblood"
                        loading={busy}
                        disabled={ticked.length === 0}
                        onClick={() => {
                            onRemove(ticked);
                            setTicked([]);
                        }}
                    >
                        Remove {ticked.length} tag{ticked.length === 1 ? "" : "s"} from{" "}
                        {selected.length} item{selected.length === 1 ? "" : "s"}
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
};
