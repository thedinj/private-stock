import {
    BITRATE_BANDS,
    DURATION_BANDS,
    FPS_BANDS,
    RESOLUTION_BANDS,
    SIZE_BANDS,
    describeRange,
    type FilterGroup,
    type FilterMeasure,
    type FilterRule,
    type RangeBand,
} from "@private-stock/core";

import { facetLabel, facetLabelPlural } from "./facetLabels";

/**
 * A filter's rules and groups in words (§14e).
 *
 * **Never "AND" and "OR".** The research on boolean filters is consistent that people swap
 * them -- "photos of Mum and Dad" usually means either -- so the screen says what a group
 * does: *all of*, *without*, and alternatives joined by a lowercase "or" ("Son or Daughter"),
 * the one reading of that word nobody gets backwards. One module for the chips above the grid, the
 * facet captions and the Advanced editor, so a group reads the same wherever it is shown.
 */

export const MEASURE_LABELS: Record<
    FilterMeasure,
    { name: string; bands: RangeBand[]; unit: string }
> = {
    durationSec: { name: "Length", bands: DURATION_BANDS, unit: "sec" },
    bitrateKbps: { name: "Bit rate", bands: BITRATE_BANDS, unit: "kbps" },
    fps: { name: "Frame rate", bands: FPS_BANDS, unit: "fps" },
    resolution: { name: "Resolution", bands: RESOLUTION_BANDS, unit: "px" },
    sizeMb: { name: "Size", bands: SIZE_BANDS, unit: "MB" },
};

/** "3+ stars", "2 stars or fewer", "3–4 stars": one band, one phrase. */
export const describeRating = (min: number | null, max: number | null): string =>
    min !== null && max !== null
        ? min === max
            ? `${min} ${min === 1 ? "star" : "stars"}`
            : `${min}–${max} stars`
        : min !== null
          ? `${min}+ stars`
          : `${max} stars or fewer`;

/** How a filter names its tags and libraries; ids it cannot name are said to be unavailable. */
export interface FilterNames {
    tag: (tagId: string) => string | undefined;
    root: (rootId: string) => string | undefined;
}

export const describeRule = (rule: FilterRule, names: FilterNames): string => {
    switch (rule.t) {
        case "tag":
            return names.tag(rule.id) ?? "an unavailable tag";
        case "favTags":
            return `my favourite ${facetLabelPlural(rule.kind).toLowerCase()}`;
        case "untagged":
            return `no ${facetLabel(rule.kind).toLowerCase()} yet`;
        case "favorite":
            return "favourites";
        case "unrated":
            return "unrated";
        case "rating":
            return describeRating(rule.min ?? null, rule.max ?? null);
        case "watched":
            return rule.value === "yes" ? "watched" : "not watched";
        case "measure": {
            const { name, bands, unit } = MEASURE_LABELS[rule.measure];

            return `${name.toLowerCase()} ${describeRange(bands, rule.min ?? null, rule.max ?? null, unit) ?? "any"}`;
        }
        case "orientation":
            return rule.value;
        case "animated":
            return rule.value === "yes" ? "animated" : "stills";
        case "kind":
            return rule.value === "video" ? "videos" : "photos";
        case "root":
            return `in ${names.root(rule.id) ?? "an unavailable library"}`;
    }
};

/** "Son, Daughter or Aunt": a list read as alternatives, or with a final "and" as requirements. */
const listOf = (parts: string[], last: "or" | "and"): string =>
    parts.length < 2
        ? (parts[0] ?? "")
        : `${parts.slice(0, -1).join(", ")} ${last} ${parts[parts.length - 1]}`;

/**
 * One rule turned around, for a `none` group: "without Grandma", "not unrated".
 *
 * A tag is something an item has, a mark or a measure something it is. None's "without" is
 * said the positive way round -- "with any performer" -- because "without no performer yet" is
 * the double negative the chip was redrawn to get rid of.
 */
const negated = (rule: FilterRule, names: FilterNames): string => {
    if (rule.t === "untagged") return `with any ${facetLabel(rule.kind).toLowerCase()}`;

    const has = rule.t === "tag" || rule.t === "favTags";

    return `${has ? "without" : "not"} ${describeRule(rule, names)}`;
};

/**
 * One group as a phrase: "Son or Daughter", "all of Son, Daughter", "without Grandma and not
 * unrated".
 *
 * An "any" group is its alternatives joined by "or". It used to be "any of Son, Daughter", and
 * beside the ♥ that came out as "any of my favourite performers, no performer yet" -- which
 * reads as "any favourite" followed by a second, separate condition. A "none" group negates
 * each rule and joins them with "and", which is what "none of" means and needs no operator to
 * explain it. "All of" keeps its words: "Son and Daughter" is the phrase people read as either.
 */
export const describeGroup = (group: FilterGroup, names: FilterNames): string => {
    if (group.match === "none") {
        return listOf(
            group.rules.map((rule) => negated(rule, names)),
            "and"
        );
    }

    const parts = group.rules.map((rule) => describeRule(rule, names));

    if (group.match === "any" || parts.length === 1) return listOf(parts, "or");

    return `all of ${parts.join(", ")}`;
};
