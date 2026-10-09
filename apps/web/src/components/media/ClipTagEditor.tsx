"use client";

import { Group, Stack, Text } from "@mantine/core";

import { allowsPrivate, clipTagKinds, type ClipTag, type TagScope } from "@private-stock/core";

import { useClipFacetTags } from "@/lib/api/itemTags";
import { facetLabelPlural } from "@/lib/facetLabels";
import { ItemTagChip } from "@/components/tags/ItemTagChip";
import { ScopeLabel } from "@/components/tags/ScopeLabel";
import { TagNameInput } from "@/components/tags/TagNameInput";

/**
 * Tagging one clip (§14d "Tagging clips").
 *
 * The item page's boxes, cut down: performer and keyword only, and no "by whom" line or
 * suggestion badge -- a clip's tags are written by its owner and read by nobody else. Each chip
 * saves as it is added, queued like the item's (`itemTags.ts`).
 */

interface ClipFacetBoxProps {
    clipId: string;
    mediaId: string;
    kind: string;
    scope: TagScope;
    values: ClipTag[];
}

const ClipFacetBox: React.FC<ClipFacetBoxProps> = ({ clipId, mediaId, kind, scope, values }) => {
    const { chips, add, remove, error } = useClipFacetTags(clipId, mediaId, kind, scope, values);
    const plural = facetLabelPlural(kind).toLowerCase();

    return (
        <Stack gap={4}>
            {allowsPrivate(kind) && <ScopeLabel scope={scope} />}
            <TagNameInput
                kind={kind}
                scope={scope}
                value={[]}
                exclude={chips.map((chip) => chip.name)}
                placeholder={scope === "public" ? `Add ${plural}…` : `Add private ${plural}…`}
                onChange={(next) => next.forEach(add)}
                error={error ?? undefined}
            />
            {chips.length > 0 && (
                <Group gap={6} wrap="wrap" mt={4}>
                    {chips.map((chip) => (
                        <ItemTagChip key={chip.name} chip={chip} onRemove={remove} />
                    ))}
                </Group>
            )}
        </Stack>
    );
};

interface ClipTagEditorProps {
    clipId: string;
    mediaId: string;
    tags: ClipTag[];
}

export const ClipTagEditor: React.FC<ClipTagEditorProps> = ({ clipId, mediaId, tags }) => (
    <Stack gap="sm">
        {clipTagKinds.map((kind) => {
            const ofKind = tags.filter((tag) => tag.kind === kind);

            return (
                <Stack key={kind} gap={4}>
                    <Text size="sm" fw={500}>
                        {facetLabelPlural(kind)}
                    </Text>
                    <ClipFacetBox
                        clipId={clipId}
                        mediaId={mediaId}
                        kind={kind}
                        scope="public"
                        values={ofKind.filter((tag) => !tag.private)}
                    />
                    {allowsPrivate(kind) && (
                        <ClipFacetBox
                            clipId={clipId}
                            mediaId={mediaId}
                            kind={kind}
                            scope="private"
                            values={ofKind.filter((tag) => tag.private)}
                        />
                    )}
                </Stack>
            );
        })}
        {/* Said once, here, rather than on each box (§14d): "Shared" names whose word it is. */}
        <Text size="xs" c="dimmed">
            Clip tags are only visible to you. Shared means the library&rsquo;s word; private means
            your own.
        </Text>
    </Stack>
);
