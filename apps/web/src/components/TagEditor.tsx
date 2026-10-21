"use client";

import { Badge, Group, Stack, Text } from "@mantine/core";

import { allowsPrivate, tagKinds, type MediaTag, type TagScope } from "@private-stock/core";

import { useItemFacetTags } from "@/lib/api/itemTags";
import { facetLabelPlural } from "@/lib/facetLabels";
import { SectionLabel } from "@/components/media/SectionLabel";
import { ItemTagChip, type ItemMoment } from "@/components/tags/ItemTagChip";
import { ScopeLabel } from "@/components/tags/ScopeLabel";
import { TagNameInput } from "@/components/tags/TagNameInput";

/**
 * Tagging one item (§5b).
 *
 * One control per facet, because "replace" has to mean something definite — a single box
 * holding every facet at once could not express "leave the studio alone", and the obvious
 * reading (absent means empty) would silently clear facets the form never showed.
 *
 * Names are submitted, not ids. The everyday action is typing a name that may or may not
 * exist yet, and making the client resolve that first turns one gesture into two round trips
 * and a race that two people adding the same performer would lose.
 *
 * **Each facet is its own section on the viewer (§14b)**, headed like Frames and Clips. They
 * share one mechanism, and the navigation already presents them as separate things —
 * Performers, Sources and Keywords each have a page of their own. Grouping them under one
 * "Tags" heading on the item was the only place the plumbing showed through.
 *
 * **Two boxes where a facet has two systems (§6).** Public tags are the library's, private
 * ones are yours. Two places rather than one control with a toggle, because a toggle's failure
 * is publishing something you meant to keep — a wrong default, a sticky preference, a switch
 * nobody noticed — and separate boxes make publishing a different gesture rather than the same
 * gesture in a different mode.
 */

interface TagEditorProps {
    mediaId: string;
    tags: MediaTag[];
    /** Facets drawn elsewhere on the page: the viewer's Performers (§5f "People in this item"). */
    except?: string[];
    /** The moment on screen, which a tag's menu offers as its picture (§6 "A tag's picture"). */
    moment?: ItemMoment;
}

/**
 * Facets offered for editing.
 *
 * The known list rather than the facets that happen to exist, so an empty library still
 * offers somewhere to put the first tag. A facet a scraper invented is still displayed if
 * the item carries it — it is merely not offered as a blank box.
 */
const editableFacets = (tags: MediaTag[]): string[] => {
    const extra = tags.map((tag) => tag.kind).filter((kind) => !tagKinds.includes(kind as never));

    return [...tagKinds, ...new Set(extra)];
};

/** Distinct names of whoever applied these, for the line over a public box. */
const contributors = (values: MediaTag[]): string[] => [
    ...new Set(values.map((tag) => tag.addedBy).filter((name): name is string => Boolean(name))),
];

interface FacetBoxProps {
    mediaId: string;
    kind: string;
    scope: TagScope;
    values: MediaTag[];
    moment?: ItemMoment;
    /** Ask "Remove tag" or "Not them" on ×: a performer's. */
    removeChoice?: boolean;
    /** A tag's face in the item, for its card. */
    faceFor?: (tagId: string) => React.ReactNode;
    /** Before the box: what is asked first, ahead of typing a name. */
    lead?: React.ReactNode;
    /** After the chips: who else may be in it. */
    children?: React.ReactNode;
}

/**
 * One box, under a line.
 *
 * The line says Shared or Private on Keywords only -- the one facet that can be either (§6). A
 * performer or a source is always the library's, so it is never called shared: a word that is
 * true of every box it appears on distinguishes nothing.
 *
 * The line itself is on every box, empty or not, and holds a line's height when it is empty.
 * It was drawn only where it had something in it, and then the first box of each section
 * started at a different height -- one line down under Keywords, one down under Performers only
 * when somebody had tagged it, none under Sources.
 */
export const FacetBox: React.FC<FacetBoxProps> = ({
    mediaId,
    kind,
    scope,
    values,
    moment,
    removeChoice,
    faceFor,
    lead,
    children,
}) => {
    const { chips, add, remove, error } = useItemFacetTags(mediaId, kind, scope, values);
    const pictures = new Map(values.map((tag) => [tag.tagId, tag.picture ?? null]));
    const pictureOf = (chip: (typeof chips)[number]) =>
        chip.tagId ? (pictures.get(chip.tagId) ?? null) : null;
    const faceOf = (chip: (typeof chips)[number]) =>
        chip.tagId && faceFor ? faceFor(chip.tagId) : null;
    // A card where there is a picture of them or their face in the item, and a performer always
    // (§6 "A tag's picture"); a chip otherwise.
    const asCard = (chip: (typeof chips)[number]) =>
        kind === "performer" || pictureOf(chip) !== null || Boolean(faceOf(chip));
    const cards = chips.filter(asCard);
    const plain = chips.filter((chip) => !asCard(chip));

    // Both read the chips as drawn, not the item as last fetched: removing the only chip left
    // its author's name over an empty box until the page was reloaded.
    const shown = values.filter((tag) => chips.some((chip) => chip.tagId === tag.tagId));
    const suggested = chips.some((chip) => chip.source === "ai");
    // Who applied them, on the public boxes only. A private tag has one possible author and
    // naming them would be telling somebody their own name (§6). Shown for a single author
    // rather than a list: the useful question is "who has been tagging this", not a census.
    const who = scope === "public" ? contributors(shown) : [];
    const plural = facetLabelPlural(kind).toLowerCase();

    return (
        <Stack gap={4}>
            <Group
                gap={6}
                align="center"
                wrap="nowrap"
                mih="calc(var(--mantine-font-size-sm) * var(--mantine-line-height-sm))"
            >
                {allowsPrivate(kind) && <ScopeLabel scope={scope} />}
                {suggested && (
                    // A suggestion has to be visibly a suggestion, or phase 10 quietly
                    // becomes indistinguishable from what a person actually asserted.
                    <Badge size="xs" variant="light" color="gray">
                        includes suggestions
                    </Badge>
                )}
                {/* One line, however many people have tagged it: a name that wrapped would
                    push this box down out of line with its neighbours. */}
                {/* "by", because a bare name in small grey type over a box read as a sub-label
                    rather than as who had done the tagging. */}
                {who.length > 0 && (
                    <Text size="xs" c="dimmed" truncate title={`Added by ${who.join(", ")}`}>
                        by {who.join(", ")}
                    </Text>
                )}
            </Group>

            {lead}

            {/* Always empty: Enter adds what was typed as a chip below and clears the box for
                the next one. The chips live outside it so that each can be a link.

                Box first, chips under it. With the chips above, every box sat as low as its
                facet had rows of chips -- out of line with its neighbours -- and the first chip
                pushed the box being typed in down under the caret. */}
            <TagNameInput
                kind={kind}
                scope={scope}
                value={[]}
                exclude={chips.map((chip) => chip.name)}
                placeholder={scope === "public" ? `Add ${plural}…` : `Add private ${plural}…`}
                onChange={(next) => next.forEach(add)}
                error={error ?? undefined}
            />

            {/* Those with a picture as cards, the rest as chips under them (§6 "A tag's
                picture"): one row of each, rather than chips standing beside cards four times
                their height. */}
            {cards.length > 0 && (
                <Group gap={8} wrap="wrap" mt={4} align="flex-start">
                    {cards.map((chip) => (
                        <ItemTagChip
                            key={chip.name}
                            chip={chip}
                            onRemove={remove}
                            removeChoice={removeChoice}
                            kind={kind}
                            picture={pictureOf(chip)}
                            face={faceOf(chip)}
                            card={kind === "performer"}
                            moment={moment}
                        />
                    ))}
                </Group>
            )}

            {plain.length > 0 && (
                <Group gap={6} wrap="wrap" mt={4}>
                    {plain.map((chip) => (
                        <ItemTagChip
                            key={chip.name}
                            chip={chip}
                            onRemove={remove}
                            removeChoice={removeChoice}
                            kind={kind}
                            moment={moment}
                        />
                    ))}
                </Group>
            )}

            {children}
        </Stack>
    );
};

interface FacetSectionProps {
    mediaId: string;
    kind: string;
    tags: MediaTag[];
    moment?: ItemMoment;
}

/**
 * One facet, under its own heading.
 *
 * Public first: the shared vocabulary is what most tagging is, and the order of two boxes is
 * the only ranking they have.
 */
const FacetSection: React.FC<FacetSectionProps> = ({ mediaId, kind, tags, moment }) => {
    const ofKind = tags.filter((tag) => tag.kind === kind);
    // Only `tag` can be private (§6). A performer is a fact about the item and a source is
    // where it came from; both are true whoever is looking.
    const both = allowsPrivate(kind);

    return (
        <Stack gap="xs">
            <SectionLabel>{facetLabelPlural(kind)}</SectionLabel>
            <FacetBox
                mediaId={mediaId}
                kind={kind}
                scope="public"
                values={ofKind.filter((tag) => !tag.private)}
                moment={moment}
            />
            {both && (
                <FacetBox
                    mediaId={mediaId}
                    kind={kind}
                    scope="private"
                    values={ofKind.filter((tag) => tag.private)}
                    moment={moment}
                />
            )}
        </Stack>
    );
};

/**
 * Every facet's section, as siblings rather than wrapped in one.
 *
 * A fragment on purpose: the caller lays them out beside the note, and a wrapper here would
 * make the facets one cell of that layout — the single "Tags" block this replaced.
 */
export const TagEditor: React.FC<TagEditorProps> = ({ mediaId, tags, except, moment }) => (
    <>
        {editableFacets(tags)
            .filter((kind) => !except?.includes(kind))
            .map((kind) => (
                <FacetSection
                    key={kind}
                    mediaId={mediaId}
                    kind={kind}
                    tags={tags}
                    moment={moment}
                />
            ))}
    </>
);
