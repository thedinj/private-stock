import { allowsPrivate, tagKinds, type SelectionTag, type TagScope } from "@private-stock/core";

import { facetLabelPlural } from "@/lib/facetLabels";

/**
 * Arranging what a selection carries, for the dialogue that takes tags off it (§6).
 *
 * Pure so it can be tested: the dialogue itself is a modal full of checkboxes, and the things
 * in it that can be wrong — which section a tag belongs in, what its count reads as, and who
 * a removal reaches — are all decided here.
 */

export interface TagBox {
    scope: TagScope;
    tags: SelectionTag[];
}

export interface TagSection {
    kind: string;
    /** Public first, then private; only the ones with something in them. */
    boxes: TagBox[];
}

/**
 * Split by facet, then by system — the item editor's layout (§14b).
 *
 * Performers, Sources and Keywords each get a section, in `tagKinds` order, then any facet a
 * scraper invented. Only Keywords can be private, so only Keywords can have two boxes; a
 * performer or a source is always the library's and is not labelled as such anywhere.
 */
export const groupByFacet = (tags: SelectionTag[]): TagSection[] => {
    const extra = tags.map((tag) => tag.kind).filter((kind) => !tagKinds.includes(kind as never));

    return [...tagKinds, ...new Set(extra)]
        .map((kind) => ({
            kind,
            boxes: (["public", "private"] as const)
                .map((scope) => ({
                    scope,
                    tags: tags.filter((tag) => tag.kind === kind && tag.scope === scope),
                }))
                .filter((box) => box.tags.length > 0),
        }))
        .filter((section) => section.boxes.length > 0);
};

/**
 * Who a removal reaches, when it reaches more than the person making it (§6).
 *
 * Named by what is ticked rather than as "shared tags", because performers and sources are
 * never called shared: "Performers and shared keywords are removed for everyone." Null when
 * everything ticked is private, which reaches nobody else and needs no warning.
 */
export const describePublicRemoval = (ticked: SelectionTag[]): string | null => {
    // In the sections' order rather than the order they were ticked in.
    const rank = (kind: string): number => {
        const index = tagKinds.indexOf(kind as never);
        return index === -1 ? tagKinds.length : index;
    };
    const kinds = [
        ...new Set(ticked.filter((tag) => tag.scope === "public").map((tag) => tag.kind)),
    ].sort((a, b) => rank(a) - rank(b));
    if (kinds.length === 0) return null;

    const names = kinds.map((kind) => {
        const plural = facetLabelPlural(kind).toLowerCase();
        return allowsPrivate(kind) ? `shared ${plural}` : plural;
    });
    const list =
        names.length === 1
            ? names[0]
            : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

    return `${list.charAt(0).toUpperCase()}${list.slice(1)} are removed for everyone.`;
};

/**
 * How much of the selection carries one tag.
 *
 * "on all 30" rather than "on 30 of 30", because the interesting question a reader has in
 * front of a list like this is which tags are on *everything* — those are the ones safe to
 * remove in one go — and a number repeated twice is slower to answer it than a word.
 */
export const describeCoverage = (count: number, selected: number): string =>
    count >= selected ? `on all ${selected}` : `on ${count} of ${selected}`;
