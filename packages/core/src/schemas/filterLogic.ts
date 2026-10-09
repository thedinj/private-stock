import { z } from "zod";

import { mediaKindSchema } from "../domain.js";

/**
 * The boolean half of a library filter (§14e "Any, all and without").
 *
 * The filter is still the flat `MediaQuery`, every field ANDed, because that is what a chip
 * panel is and what nearly every question needs. This adds the two things a flat AND cannot
 * say, and nothing more:
 *
 * - **Groups.** A list of rules matched by *any*, *all* or *none* of them, ANDed with the rest
 *   of the filter. "Son or Daughter", "unrated or two stars at most", "4K or longer than twenty
 *   minutes". One level only: a group holds rules, never another group. Lightroom and Plex
 *   nest further and almost nobody uses it; one level answers "(a or b) and c", which is the
 *   shape household questions take, and stays explainable in a sentence.
 * - **`favTags`**, a rule that means "any of my favourite performers" and is resolved when the
 *   query runs, so a saved filter keeps up with the favourites rather than freezing them.
 *
 * A group whose `facet` is set belongs to that facet's section of the filter panel -- its
 * "any of" mode and its Favourites chip. One without is the Advanced editor's. The SQL does
 * not care which; the distinction is so each screen edits only what it drew.
 *
 * **Text search is not a rule**, deliberately. An FTS match inside an OR is a per-row probe,
 * and the private-tag fallback it carries doubles that; the search box stays one AND condition
 * on the whole filter (§5c).
 */

/** Values in the URL's units, as the flat bounds are (§14e): seconds, kbps, pixels, MB. */
export const filterMeasures = [
    "durationSec",
    "bitrateKbps",
    "fps",
    "resolution",
    "sizeMb",
] as const;
export const filterMeasureSchema = z.enum(filterMeasures);
export type FilterMeasure = z.infer<typeof filterMeasureSchema>;

const facetKind = z.string().trim().min(1).max(40);
const yesNo = z.enum(["yes", "no"]);

const ruleShapes = z.discriminatedUnion("t", [
    z.object({ t: z.literal("tag"), id: z.string().min(1).max(64) }),
    /** Any of the viewer's favourite tags of this facet, resolved when the query runs. */
    z.object({ t: z.literal("favTags"), kind: facetKind }),
    /** Carries no tag of this facet at all: "no performer tagged yet". */
    z.object({ t: z.literal("untagged"), kind: facetKind }),
    z.object({ t: z.literal("favorite") }),
    z.object({ t: z.literal("unrated") }),
    z.object({
        t: z.literal("rating"),
        min: z.number().int().min(1).max(5).optional(),
        max: z.number().int().min(1).max(5).optional(),
    }),
    z.object({ t: z.literal("watched"), value: yesNo }),
    /** Half-open like the flat bounds: at least `min`, under `max`. */
    z.object({
        t: z.literal("measure"),
        measure: filterMeasureSchema,
        min: z.number().min(0).optional(),
        max: z.number().min(0).optional(),
    }),
    z.object({ t: z.literal("orientation"), value: z.enum(["landscape", "portrait", "square"]) }),
    z.object({ t: z.literal("animated"), value: yesNo }),
    z.object({ t: z.literal("kind"), value: mediaKindSchema }),
    z.object({ t: z.literal("root"), id: z.string().min(1).max(64) }),
]);
/**
 * One condition. A range needs at least one end: a bound-less rule would match everything and
 * read, in the editor, as a condition that is doing something.
 *
 * Checked here rather than on the two range shapes because zod's discriminated union takes
 * plain objects only.
 */
export const filterRuleSchema = ruleShapes.refine(
    (rule) =>
        (rule.t !== "rating" && rule.t !== "measure") ||
        rule.min !== undefined ||
        rule.max !== undefined,
    { message: "A range needs at least one end" }
);
export type FilterRule = z.infer<typeof filterRuleSchema>;
export type FilterRuleType = FilterRule["t"];

export const filterMatchSchema = z.enum(["any", "all", "none"]);
export type FilterMatch = z.infer<typeof filterMatchSchema>;

/** Most groups one filter may hold, and most rules one group may. */
export const FILTER_GROUP_LIMIT = 8;
export const FILTER_RULE_LIMIT = 20;

export const filterGroupSchema = z.object({
    match: filterMatchSchema,
    /** The filter panel section that owns this group, or absent for the Advanced editor's. */
    facet: facetKind.optional(),
    rules: z.array(filterRuleSchema).min(1).max(FILTER_RULE_LIMIT),
});
export type FilterGroup = z.infer<typeof filterGroupSchema>;

/**
 * Groups as the query carries them: an array, or the JSON of one.
 *
 * JSON in a single parameter because the address has to round-trip it and there is no
 * readable flat spelling of nested rules that is not a query language (§5c). A malformed
 * string fails validation like any other bad parameter, rather than being dropped -- a filter
 * that silently loses its logic shows more than was asked for and looks right.
 */
export const filterGroupsSchema = z.preprocess((value) => {
    if (typeof value !== "string") return value;

    try {
        return JSON.parse(value) as unknown;
    } catch {
        return value;
    }
}, z.array(filterGroupSchema).max(FILTER_GROUP_LIMIT));

/** Every rule in every group, for the questions asked of all of them at once. */
export const rulesIn = (groups: readonly FilterGroup[] | undefined): FilterRule[] =>
    (groups ?? []).flatMap((group) => group.rules);

/** Rules that read a person's own marks, and so need to know whose. */
const PERSONAL_RULES: ReadonlySet<FilterRuleType> = new Set([
    "favorite",
    "unrated",
    "rating",
    "favTags",
]);

/**
 * Whether a group asks about somebody's judgements -- ratings, favourites, favourite tags.
 *
 * `watched` is not in it, for the reason it is not in `isViewerRelative`: it is always the
 * viewer's history, never an overlay's.
 */
export const groupsArePersonal = (groups: readonly FilterGroup[] | undefined): boolean =>
    personalRulesIn(groups).length > 0;

/** The rules in a set of groups that ask about somebody's judgements, in order. */
export const personalRulesIn = (groups: readonly FilterGroup[] | undefined): FilterRule[] =>
    rulesIn(groups).filter((rule) => PERSONAL_RULES.has(rule.t));

/** Whether a group reads the `UserMedia` row of whoever is looking. */
export const groupsReadUserMedia = (groups: readonly FilterGroup[] | undefined): boolean =>
    rulesIn(groups).some(
        (rule) =>
            rule.t === "favorite" ||
            rule.t === "unrated" ||
            rule.t === "rating" ||
            rule.t === "watched"
    );

/** Every tag id a set of groups names, for resolving names and for counting. */
export const tagIdsInGroups = (groups: readonly FilterGroup[] | undefined): string[] =>
    rulesIn(groups).flatMap((rule) => (rule.t === "tag" ? [rule.id] : []));

/**
 * Whether a group lets in only items that carry no tag of some facet.
 *
 * Decided by implication, not by mention: an "all of" group with an untagged rule in it, or an
 * "any of" group made of nothing but untagged rules ("no performer or no source"), admits only
 * items missing a tag. An "any of" group that mixes in anything else does not -- "no performer
 * or four stars" keeps every four-star item however it is tagged -- and a "none of" group says
 * the opposite: "none of: no performer" is "has a performer".
 */
const groupFindsUntagged = (group: FilterGroup): boolean => {
    const untagged = (rule: FilterRule): boolean => rule.t === "untagged";

    if (group.match === "all") return group.rules.some(untagged);
    if (group.match === "any") return group.rules.every(untagged);

    return false;
};

/**
 * Whether a filter is a "find untagged" list: every item in it is missing a tag of some facet,
 * so tagging is how items leave it (§14b).
 *
 * Groups are ANDed with each other and with the rest of the query, so one such group is enough
 * whatever else the filter says.
 */
export const findsUntagged = (groups: readonly FilterGroup[] | undefined): boolean =>
    (groups ?? []).some(groupFindsUntagged);
