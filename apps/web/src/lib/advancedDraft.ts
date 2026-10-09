import {
    filterGroupSchema,
    tagKinds,
    type FilterGroup,
    type FilterMatch,
    type FilterMeasure,
    type FilterRule,
} from "@private-stock/core";

import { facetLabel } from "./facetLabels";
import { fileFilterGroups, type LibraryView } from "./libraryQuery";

/**
 * The Advanced editor's draft, as rows a person edits rather than rules the query holds
 * (§14e "Advanced groups").
 *
 * **A row is one subject.** "Performer is any of chris, brian, ♥ my favourites" is one row on
 * screen and three rules in the group; "Keyword has none" is one row and an `untagged` rule.
 * The editor used to show one row per rule with nothing saying what each was about -- a bare
 * "chris" beside a bare "Unrated" -- and a 25-item menu to add them. A row now leads with its
 * subject, chosen from a searchable list in the panel's own words and order.
 *
 * Pure: rows to groups and back, so the round trip is tested without a modal.
 */

/** What a row is about: a facet, a mark, a measure, or a library. */
export type Subject =
    | { type: "facet"; kind: string }
    | { type: "favorite" }
    | { type: "unrated" }
    | { type: "rating" }
    | { type: "watched" }
    | { type: "measure"; measure: FilterMeasure }
    | { type: "orientation" }
    | { type: "animated" }
    | { type: "root" }
    /** Videos or photos. Not offered -- the tabs own it -- but an older filter may hold one. */
    | { type: "kind" };

/** A facet row's value: some tags (♥ among them, perhaps), or "has none at all". */
export interface FacetValue {
    none: boolean;
    tagIds: string[];
    favorites: boolean;
}

export interface DraftRow {
    key: number;
    subject: Subject | null;
    /** The facet row's value. Unused by other subjects. */
    facet: FacetValue;
    /** Every other subject's value, once it has one. */
    rule: FilterRule | null;
}

export interface DraftGroup {
    key: number;
    match: FilterMatch;
    rows: DraftRow[];
}

let counter = 1;
const nextKey = (): number => counter++;

const EMPTY_FACET: FacetValue = { none: false, tagIds: [], favorites: false };

export const blankRow = (): DraftRow => ({
    key: nextKey(),
    subject: null,
    facet: EMPTY_FACET,
    rule: null,
});

export const blankGroup = (match: FilterMatch = "any"): DraftGroup => ({
    key: nextKey(),
    match,
    rows: [blankRow()],
});

/** The value a freshly chosen subject starts with: something valid, never an empty range. */
export const rowFor = (subject: Subject, key: number): DraftRow => {
    const row: DraftRow = { key, subject, facet: EMPTY_FACET, rule: null };

    switch (subject.type) {
        case "facet":
            return row;
        case "favorite":
            return { ...row, rule: { t: "favorite" } };
        case "unrated":
            return { ...row, rule: { t: "unrated" } };
        case "rating":
            return { ...row, rule: { t: "rating", min: 4 } };
        case "watched":
            return { ...row, rule: { t: "watched", value: "no" } };
        case "measure":
            // No bound yet: the band picker is open and empty until somebody chooses.
            return row;
        case "orientation":
            return { ...row, rule: { t: "orientation", value: "landscape" } };
        case "animated":
            return { ...row, rule: { t: "animated", value: "no" } };
        case "root":
            return row;
        case "kind":
            return { ...row, rule: { t: "kind", value: "video" } };
    }
};

/** The rules a row stands for; none until it is finished. */
export const rowRules = (row: DraftRow): FilterRule[] => {
    if (!row.subject) return [];

    if (row.subject.type === "facet") {
        const { kind } = row.subject;

        if (row.facet.none) return [{ t: "untagged", kind }];

        return [
            ...(row.facet.favorites ? [{ t: "favTags", kind } as const] : []),
            ...row.facet.tagIds.map((id): FilterRule => ({ t: "tag", id })),
        ];
    }

    return row.rule ? [row.rule] : [];
};

/** The draft as groups the schema accepts: unfinished rows and empty groups left out. */
export const draftToGroups = (draft: DraftGroup[]): FilterGroup[] =>
    draft.flatMap((group) => {
        const parsed = filterGroupSchema.safeParse({
            match: group.match,
            rules: group.rows.flatMap(rowRules),
        });

        return parsed.success ? [parsed.data] : [];
    });

/** The subject a stored rule belongs to. Tags need their facet, which only the server knows. */
const subjectOf = (rule: FilterRule, kindOf: (tagId: string) => string | undefined): Subject => {
    switch (rule.t) {
        case "tag":
            return { type: "facet", kind: kindOf(rule.id) ?? "tag" };
        case "favTags":
        case "untagged":
            return { type: "facet", kind: rule.kind };
        case "measure":
            return { type: "measure", measure: rule.measure };
        default:
            return { type: rule.t } as Subject;
    }
};

/**
 * Stored groups as rows: a facet's tags, its ♥ and its "has none" folded into one row each.
 *
 * A `kind` rule from before the editor stopped offering it stays a row of its own, so applying
 * again does not quietly drop it.
 */
export const groupsToDraft = (
    groups: FilterGroup[],
    kindOf: (tagId: string) => string | undefined
): DraftGroup[] =>
    groups.map((group) => {
        const rows: DraftRow[] = [];

        for (const rule of group.rules) {
            const subject = subjectOf(rule, kindOf);

            if (subject.type === "facet") {
                const existing = rows.find(
                    (row) => row.subject?.type === "facet" && row.subject.kind === subject.kind
                );
                const target = existing ?? {
                    key: nextKey(),
                    subject,
                    facet: EMPTY_FACET,
                    rule: null,
                };

                target.facet = {
                    none: target.facet.none || rule.t === "untagged",
                    favorites: target.facet.favorites || rule.t === "favTags",
                    tagIds:
                        rule.t === "tag" ? [...target.facet.tagIds, rule.id] : target.facet.tagIds,
                };

                if (!existing) rows.push(target);
                continue;
            }

            rows.push({ key: nextKey(), subject, facet: EMPTY_FACET, rule });
        }

        return { key: nextKey(), match: group.match, rows };
    });

/** A subject's name in the picker, in the panel's words. */
export const subjectLabel = (subject: Subject): string => {
    switch (subject.type) {
        case "facet":
            return facetLabel(subject.kind);
        case "favorite":
            return "Favourite";
        case "unrated":
            return "Unrated";
        case "rating":
            return "Rating";
        case "watched":
            return "Watched";
        case "measure":
            return MEASURE_NAMES[subject.measure];
        case "orientation":
            return "Orientation";
        case "animated":
            return "Movement";
        case "root":
            return "Library";
        case "kind":
            return "Videos or photos";
    }
};

/** As the panel's "The file" rows name them -- "File size", not "Size". */
const MEASURE_NAMES: Record<FilterMeasure, string> = {
    durationSec: "Length",
    bitrateKbps: "Bit rate",
    fps: "Frame rate",
    resolution: "Resolution",
    sizeMb: "File size",
};

/** A subject as the picker's option value, and back. */
export const subjectKey = (subject: Subject): string =>
    subject.type === "facet"
        ? `facet:${subject.kind}`
        : subject.type === "measure"
          ? `measure:${subject.measure}`
          : subject.type;

export const subjectFromKey = (key: string): Subject => {
    const [type, detail] = key.split(":") as [string, string | undefined];

    if (type === "facet") return { type: "facet", kind: detail ?? "tag" };
    if (type === "measure") return { type: "measure", measure: detail as FilterMeasure };

    return { type } as Subject;
};

/**
 * What the picker offers, in the panel's three sections and its order (§14e "Three sections").
 *
 * File subjects follow `fileFilterGroups`, so a Videos view is not offered Movement and a
 * Photos view is not offered Length -- the same rule the panel keeps. "Videos or photos" is not
 * offered at all: the tabs above the grid already own it.
 */
export const subjectOptions = (
    kind: LibraryView["kind"]
): { group: string; items: { value: string; label: string }[] }[] => {
    const option = (subject: Subject) => ({
        value: subjectKey(subject),
        label: subjectLabel(subject),
    });

    const fileRows = fileFilterGroups(kind).flatMap((group) => group.rows);

    return [
        {
            group: "People and tags",
            items: tagKinds.map((facet) => option({ type: "facet", kind: facet })),
        },
        {
            group: "Your marks",
            items: (["favorite", "unrated", "rating", "watched"] as const).map((type) =>
                option({ type } as Subject)
            ),
        },
        {
            group: "The file",
            items: [
                ...fileRows.map((row) =>
                    option(
                        row === "orientation" || row === "animated"
                            ? ({ type: row } as Subject)
                            : { type: "measure", measure: row }
                    )
                ),
                option({ type: "root" }),
            ],
        },
    ];
};

/** A row for a subject with a value already chosen. */
const filledRow = (subject: Subject, rule: FilterRule): DraftRow => ({
    ...rowFor(subject, nextKey()),
    rule,
});

/**
 * Starting points for an empty editor: the three shapes it exists for (§14e).
 *
 * Built fresh on each call, so every use gets keys of its own.
 */
export const exampleGroups = (): { label: string; group: DraftGroup }[] => [
    {
        label: "Either of two people",
        group: {
            key: nextKey(),
            match: "any",
            rows: [rowFor({ type: "facet", kind: "performer" }, nextKey())],
        },
    },
    {
        label: "Unrated, or two stars and under",
        group: {
            key: nextKey(),
            match: "any",
            rows: [
                filledRow({ type: "unrated" }, { t: "unrated" }),
                filledRow({ type: "rating" }, { t: "rating", max: 2 }),
            ],
        },
    },
    {
        label: "4K, or longer than 20 minutes",
        group: {
            key: nextKey(),
            match: "any",
            rows: [
                filledRow(
                    { type: "measure", measure: "resolution" },
                    { t: "measure", measure: "resolution", min: 2_160 }
                ),
                filledRow(
                    { type: "measure", measure: "durationSec" },
                    { t: "measure", measure: "durationSec", min: 1_200 }
                ),
            ],
        },
    },
];
