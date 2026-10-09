import type { FilterGroup, FilterRule } from "@private-stock/core";

import type { LibraryView } from "./libraryQuery";

/**
 * The filter panel's tag chips as a state machine (§14e "Any, all and without").
 *
 * A chip is off, **with** or **without**. Where a "with" chip lives depends on its facet's
 * mode: in "all of" it is in `tags`, the flat AND list the library has always had; in "any of"
 * it is a tag rule in that facet's own group. "Without" is `notTags`. The Favourites ♥ chip is
 * a `favTags` rule in the facet's group whichever mode it is in -- alone it means "at least one
 * favourite", beside other picks under "any of" it is one more alternative.
 *
 * **The mode is not stored anywhere; it is read off the groups.** A facet is in "any of" when
 * its group holds a tag rule, and in "all of" otherwise. Storing it separately would be a
 * second answer to one question, and the two would disagree the first time something edited
 * one without the other -- a hand-edited address, an old saved filter. `normalizeTagLogic`
 * keeps the groups in the shapes that make the reading unambiguous: a facet's "any of" with a
 * single tag and nothing else collapses back into `tags`, because with one pick the two modes
 * are the same filter.
 *
 * **None** is the facet's other special chip: "no performer tagged yet", an `untagged` rule. It
 * is always an alternative, never a requirement -- "chris and no performer" matches nothing -- so
 * a facet with None on is in "any of" whatever else it holds, and leaving "any of" drops it.
 * Without, it is "has some performer", and shares the facet's `match: "none"` group with the
 * ♥'s without.
 *
 * Groups without a `facet` belong to the Advanced editor and nothing here touches them.
 *
 * Pure, so the transitions are tested directly rather than through a rendered panel.
 */

export type ChipState = "off" | "with" | "without";
export type FacetMode = "all" | "any";

/**
 * The facet section's own "with" group, if it has one: its "any of" picks, its ♥ and its None.
 *
 * A facet can own one other group, `match: "none"`, holding the ♥ rule, the None rule or both
 * -- "without my favourite performers", "has some performer" (`excludedGroup`). The two are
 * kept apart because they mean opposite things, and each of those chips is in exactly one of
 * them at a time.
 */
export const facetGroup = (view: LibraryView, kind: string): FilterGroup | undefined =>
    view.groups.find((group) => group.facet === kind && group.match === "any");

/** The facet's "without" group, if its ♥ or its None chip is set to without. */
const excludedGroup = (view: LibraryView, kind: string): FilterGroup | undefined =>
    view.groups.find((group) => group.facet === kind && group.match === "none");

const tagIdsOf = (group: FilterGroup | undefined): string[] =>
    group?.rules.flatMap((rule) => (rule.t === "tag" ? [rule.id] : [])) ?? [];

const holdsUntagged = (group: FilterGroup | undefined): boolean =>
    group?.rules.some((rule) => rule.t === "untagged") ?? false;

/** Whether the facet is matching any of its picks rather than all of them. None forces "any". */
export const facetMode = (view: LibraryView, kind: string): FacetMode =>
    tagIdsOf(facetGroup(view, kind)).length > 0 || holdsUntagged(facetGroup(view, kind))
        ? "any"
        : "all";

/** Whether the facet's Favourites ♥ chip is "with" -- in the facet's own group. */
export const favoritesOn = (view: LibraryView, kind: string): boolean =>
    facetGroup(view, kind)?.rules.some((rule) => rule.t === "favTags") ?? false;

/**
 * The ♥ chip's state. Three, like every chip beside it (§14e "Favourites ♥").
 *
 * "Without" is a real question -- somebody new, not the usual faces -- and it is the cycle a
 * person has just learned on the chips under it. A ♥ that stopped at two states would be the
 * one chip in the section whose third click did something else.
 */
export const favoritesState = (view: LibraryView, kind: string): ChipState =>
    excludedGroup(view, kind)?.rules.some((rule) => rule.t === "favTags")
        ? "without"
        : favoritesOn(view, kind)
          ? "with"
          : "off";

/** The None chip's state: with is "no performer yet", without is "has some performer". */
export const noneState = (view: LibraryView, kind: string): ChipState =>
    holdsUntagged(excludedGroup(view, kind))
        ? "without"
        : holdsUntagged(facetGroup(view, kind))
          ? "with"
          : "off";

export const chipState = (view: LibraryView, tagId: string): ChipState => {
    if (view.notTags.includes(tagId)) return "without";

    const inFacetGroup = view.groups.some(
        (group) => group.facet !== undefined && tagIdsOf(group).includes(tagId)
    );

    return view.tags.includes(tagId) || inFacetGroup ? "with" : "off";
};

/**
 * The facet's "with" picks, the ♥ and None counting as one each.
 *
 * What decides whether the mode control is offered at all: with nought or one pick "all of"
 * and "any of" are the same filter, and a control whose two settings do the same thing is one
 * to read past every time.
 */
export const withPicks = (
    view: LibraryView,
    kind: string,
    kindOf: (tagId: string) => string | undefined
): number =>
    view.tags.filter((tagId) => kindOf(tagId) === kind).length +
    tagIdsOf(facetGroup(view, kind)).length +
    (favoritesOn(view, kind) ? 1 : 0) +
    (noneState(view, kind) === "with" ? 1 : 0);

/** The view with this facet's group replaced -- or removed, given no rules. */
const withFacetRules = (view: LibraryView, kind: string, rules: FilterRule[]): LibraryView => {
    const existing = facetGroup(view, kind);
    const others = view.groups.filter((group) => group !== existing);

    if (rules.length === 0) {
        return { ...view, groups: others };
    }

    const next: FilterGroup = { match: "any", facet: kind, rules };

    // Kept in place when it already exists, so the address does not reorder under the user.
    return {
        ...view,
        groups: existing
            ? view.groups.map((group) => (group === existing ? next : group))
            : [...view.groups, next],
    };
};

/** The view with this facet's "without" group replaced -- or removed, given no rules. */
const withExcludedRules = (view: LibraryView, kind: string, rules: FilterRule[]): LibraryView => {
    const existing = excludedGroup(view, kind);

    if (rules.length === 0) {
        return { ...view, groups: view.groups.filter((group) => group !== existing) };
    }

    const next: FilterGroup = { match: "none", facet: kind, rules };

    return {
        ...view,
        groups: existing
            ? view.groups.map((group) => (group === existing ? next : group))
            : [...view.groups, next],
    };
};

/**
 * Puts the groups back into the shapes the mode is read from.
 *
 * - A facet group with no rules goes.
 * - A facet group holding exactly one tag and nothing else becomes that tag in `tags`: one
 *   pick under "any of" is the same filter as under "all of", and leaving it in the group
 *   would keep the facet in a mode its control is no longer even offering.
 * - A facet group is `match: "any"`, or `match: "none"` holding only the ♥ and None rules.
 *   Anything else under a facet's name -- a hand-edited address -- is read as "any".
 */
export const normalizeTagLogic = (view: LibraryView): LibraryView => {
    let tags = view.tags;
    const groups: FilterGroup[] = [];

    for (const group of view.groups) {
        if (group.facet === undefined) {
            groups.push(group);
            continue;
        }

        if (group.rules.length === 0) continue;

        const [only] = group.rules;

        if (group.rules.length === 1 && only?.t === "tag") {
            if (!tags.includes(only.id)) tags = [...tags, only.id];
            continue;
        }

        const excludable = group.rules.every(
            (rule) => rule.t === "favTags" || rule.t === "untagged"
        );

        groups.push(
            group.match === "any" || (group.match === "none" && excludable)
                ? group
                : { ...group, match: "any" }
        );
    }

    return { ...view, tags, groups };
};

/** Takes a tag out of every place the panel can have put it. Advanced groups are left alone. */
const withoutTag = (view: LibraryView, tagId: string): LibraryView => ({
    ...view,
    tags: view.tags.filter((id) => id !== tagId),
    notTags: view.notTags.filter((id) => id !== tagId),
    groups: view.groups.map((group) =>
        group.facet === undefined
            ? group
            : {
                  ...group,
                  rules: group.rules.filter((rule) => rule.t !== "tag" || rule.id !== tagId),
              }
    ),
});

/** Sets one chip to a state, wherever its facet's mode says that state lives. */
export const setChip = (
    view: LibraryView,
    tagId: string,
    kind: string,
    state: ChipState
): LibraryView => {
    const mode = facetMode(view, kind);
    const cleared = withoutTag(view, tagId);

    let next = cleared;

    if (state === "with") {
        next =
            mode === "any"
                ? withFacetRules(cleared, kind, [
                      ...(facetGroup(cleared, kind)?.rules ?? []),
                      { t: "tag", id: tagId },
                  ])
                : { ...cleared, tags: [...cleared.tags, tagId] };
    } else if (state === "without") {
        next = { ...cleared, notTags: [...cleared.notTags, tagId] };
    }

    return { ...normalizeTagLogic(next), page: 0 };
};

/**
 * Off, then with, then without, then off again (§14e).
 *
 * The cycle Eagle uses, kept because it is one gesture for mouse and touch alike. Its
 * known trap -- the third click silently dropping the filter -- is answered by the chip saying
 * which state it is in, in words as well as colour, before and after each click.
 */
export const cycleChip = (view: LibraryView, tagId: string, kind: string): LibraryView => {
    const next: Record<ChipState, ChipState> = { off: "with", with: "without", without: "off" };

    return setChip(view, tagId, kind, next[chipState(view, tagId)]);
};

/**
 * Switches a facet between "all of" and "any of", carrying its picks across.
 *
 * `kindOf` says which of the flat `tags` are this facet's -- the view holds ids alone, and the
 * panel knows their facets from the counts it has just drawn.
 */
export const setFacetMode = (
    view: LibraryView,
    kind: string,
    mode: FacetMode,
    kindOf: (tagId: string) => string | undefined
): LibraryView => {
    const group = facetGroup(view, kind);
    const favorites = group?.rules.filter((rule) => rule.t === "favTags") ?? [];
    const none = group?.rules.filter((rule) => rule.t === "untagged") ?? [];

    if (mode === "any") {
        const mine = view.tags.filter((tagId) => kindOf(tagId) === kind);
        const moved = withFacetRules(
            { ...view, tags: view.tags.filter((tagId) => !mine.includes(tagId)) },
            kind,
            [
                ...favorites,
                ...tagIdsOf(group).map((id): FilterRule => ({ t: "tag", id })),
                ...mine.map((id): FilterRule => ({ t: "tag", id })),
                ...none,
            ]
        );

        return { ...normalizeTagLogic(moved), page: 0 };
    }

    // None does not come along: "chris and no performer" is a filter nothing can match.
    const back = withFacetRules(
        { ...view, tags: [...view.tags, ...tagIdsOf(group)] },
        kind,
        favorites
    );

    return { ...normalizeTagLogic(back), page: 0 };
};

/** Sets the facet's Favourites ♥ chip to a state. */
export const setFavorites = (view: LibraryView, kind: string, state: ChipState): LibraryView => {
    const heart: FilterRule = { t: "favTags", kind };
    const rules = (facetGroup(view, kind)?.rules ?? []).filter((rule) => rule.t !== "favTags");
    const excluded = (excludedGroup(view, kind)?.rules ?? []).filter(
        (rule) => rule.t !== "favTags"
    );

    // Out of both places first, so the ♥ is only ever in the one its state names.
    let next = withExcludedRules(withFacetRules(view, kind, rules), kind, excluded);

    if (state === "with") {
        next = withFacetRules(next, kind, [heart, ...rules]);
    } else if (state === "without") {
        next = withExcludedRules(next, kind, [heart, ...excluded]);
    }

    return { ...normalizeTagLogic(next), page: 0 };
};

/** Off, with, without, off -- the same cycle as the tag chips. */
export const cycleFavorites = (view: LibraryView, kind: string): LibraryView => {
    const next: Record<ChipState, ChipState> = { off: "with", with: "without", without: "off" };

    return setFavorites(view, kind, next[favoritesState(view, kind)]);
};

/**
 * Sets the facet's None chip to a state.
 *
 * With, it joins the facet's other picks as one more alternative, moving them into "any of"
 * first -- the only mode in which "no performer" beside "chris" is a filter rather than an
 * empty grid.
 */
export const setNone = (
    view: LibraryView,
    kind: string,
    state: ChipState,
    kindOf: (tagId: string) => string | undefined
): LibraryView => {
    const none: FilterRule = { t: "untagged", kind };
    const rules = (facetGroup(view, kind)?.rules ?? []).filter((rule) => rule.t !== "untagged");
    const excluded = (excludedGroup(view, kind)?.rules ?? []).filter(
        (rule) => rule.t !== "untagged"
    );

    // Out of both places first, as for the ♥.
    let next = withExcludedRules(withFacetRules(view, kind, rules), kind, excluded);

    if (state === "with") {
        // Not `setFacetMode`, which would fold a lone pick straight back into `tags`.
        const mine = next.tags.filter((tagId) => kindOf(tagId) === kind);

        next = withFacetRules(
            { ...next, tags: next.tags.filter((tagId) => !mine.includes(tagId)) },
            kind,
            [...rules, ...mine.map((id): FilterRule => ({ t: "tag", id })), none]
        );
    } else if (state === "without") {
        next = withExcludedRules(next, kind, [...excluded, none]);
    }

    return { ...normalizeTagLogic(next), page: 0 };
};

/** Off, with, without, off -- the same cycle as every chip beside it. */
export const cycleNone = (
    view: LibraryView,
    kind: string,
    kindOf: (tagId: string) => string | undefined
): LibraryView => {
    // "Has some performer" first: it is the question asked more often, and the one that narrows
    // a library without tipping its facet into "any of". "Nobody yet" is the second click.
    const next: Record<ChipState, ChipState> = { off: "without", without: "with", with: "off" };

    return setNone(view, kind, next[noneState(view, kind)], kindOf);
};

/** The Advanced editor's groups: every group no facet section owns. */
export const advancedGroups = (view: LibraryView): FilterGroup[] =>
    view.groups.filter((group) => group.facet === undefined);

/** The view with its Advanced groups replaced, the facets' own left exactly where they were. */
export const withAdvancedGroups = (view: LibraryView, groups: FilterGroup[]): LibraryView => ({
    ...view,
    groups: [...view.groups.filter((group) => group.facet !== undefined), ...groups],
    page: 0,
});
