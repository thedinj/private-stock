import { describeRange, parseLookFrame } from "@private-stock/core";

import {
    MEASURE_LABELS,
    describeGroup,
    describeRating,
    describeRule,
    type FilterNames,
} from "./filterWords";
import { MEASURES, type LibraryView, type Measure } from "./libraryQuery";
import { normalizeTagLogic } from "./tagLogic";
import { formatTimecode } from "./timecode";

/**
 * What is narrowing the library, in words, with a way to undo each one (§14e).
 *
 * **This is what separates a filter from a sort.** Both change what the grid shows and only
 * one of them hides things, and the panel alone cannot carry that difference: it is a column
 * of controls, most of them off, several of them off-screen on a phone, and a set filter looks
 * exactly like an unset one until you scroll to it. A sort never needs this — reordering
 * hides nothing, and the sort control always says what it is doing because it has only one
 * state to show.
 *
 * So every active filter gets a chip above the grid, next to the count it is responsible for.
 * The chips are removable individually, which is the other half: "clear all" is the only
 * escape from a panel, and it is too blunt for a filter built up one decision at a time.
 *
 * Pure, and the single source for the list. Deriving the chips from the same view the request
 * is built from means a filter cannot be in force without appearing here — the failure this
 * exists to prevent is precisely a narrowing nobody can see.
 */

export interface ActiveFilter {
    /** Stable across renders, so removing one does not re-key the rest. */
    id: string;
    label: string;
    /**
     * The label in three parts when it carries a name that can be very long — a file's title —
     * so the chip can cut the name in the middle and keep the words around it (§14). `label` is
     * still the whole of it, for the hover title and a screen reader.
     */
    named?: { before: string; name: string; after: string };
    /** The view with just this filter undone. */
    clear: (view: LibraryView) => LibraryView;
}

const ORIENTATION_LABELS = {
    landscape: "Landscape",
    portrait: "Portrait",
    square: "Square",
} as const;

const withMeasureCleared =
    (measure: Measure) =>
    (view: LibraryView): LibraryView => ({
        ...view,
        measures: { ...view.measures, [measure]: { min: null, max: null } },
        page: 0,
    });

/** What a chip says for an id when nothing has supplied names: honest, if unhelpful. */
const NO_NAMES: FilterNames = { tag: () => undefined, root: () => undefined };

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export const activeFilters = (
    view: LibraryView,
    names: FilterNames = NO_NAMES,
    /** The title of the item a "more like this" started from, once it is known. */
    lookSourceTitle?: string
): ActiveFilter[] => {
    const filters: ActiveFilter[] = [];

    /**
     * A look, first: it decides the order of everything else on screen as well as what is in it,
     * so it is the chip that most explains the grid (§5e).
     */
    if (view.lookText) {
        filters.push({
            id: "look",
            label: `Looks like “${view.lookText}”`,
            named: { before: "Looks like “", name: view.lookText, after: "”" },
            clear: (current) => ({ ...current, lookText: "", page: 0 }),
        });
    }

    if (view.like) {
        const { atMs } = parseLookFrame(view.like);
        const where = atMs === null ? "" : ` at ${formatTimecode(atMs)}`;

        filters.push({
            id: "like",
            label: lookSourceTitle
                ? `Looks like “${lookSourceTitle}”${where}`
                : `Looks like a moment${where}`,
            ...(lookSourceTitle && {
                named: { before: "Looks like “", name: lookSourceTitle, after: `”${where}` },
            }),
            clear: (current) => ({ ...current, like: "", page: 0 }),
        });
    }

    /**
     * Search is here although it has a box of its own.
     *
     * The box is in the toolbar and the results are below it, so it is the one filter that
     * already says what it is doing — but leaving it out would make this row an incomplete
     * answer to "why am I seeing so little", which is the only question it exists to answer.
     */
    if (view.search) {
        filters.push({
            id: "search",
            label: `“${view.search}”`,
            clear: (current) => ({ ...current, search: "", page: 0 }),
        });
    }

    /**
     * No chip for the kind. It narrows the grid, but it is shown by the tabs directly under the
     * title -- a fixed, always-visible control whose selected state *is* the answer -- so a chip
     * repeating it was a second copy of a fact already on screen, and one that looked like a
     * filter when it is which shelf you are on (§14e).
     */

    if (view.favorite) {
        filters.push({
            id: "favorite",
            label: "Favourites",
            clear: (current) => ({ ...current, favorite: false, page: 0 }),
        });
    }

    if (view.unrated) {
        filters.push({
            id: "unrated",
            label: "Unrated",
            clear: (current) => ({ ...current, unrated: false, page: 0 }),
        });
    }

    if (view.watched) {
        filters.push({
            id: "watched",
            // The control this chip stands for is labelled "Watched", and a chip that
            // renamed it made the same filter look like two.
            label: view.watched === "yes" ? "Watched" : "Not watched",
            clear: (current) => ({ ...current, watched: null, page: 0 }),
        });
    }

    if (view.playback) {
        filters.push({
            id: "playback",
            label: "Won't play in a browser",
            clear: (current) => ({ ...current, playback: null, page: 0 }),
        });
    }

    /**
     * One chip for a rating band, not two.
     *
     * "At least 3" and "at most 4" are one thought — a band — and splitting them would let
     * somebody remove the floor and leave the ceiling, arriving at "3 stars or fewer" having
     * meant to clear the rating filter entirely.
     */
    if (view.minRating !== null || view.maxRating !== null) {
        filters.push({
            id: "rating",
            label: describeRating(view.minRating, view.maxRating),
            clear: (current) => ({ ...current, minRating: null, maxRating: null, page: 0 }),
        });
    }

    for (const measure of MEASURES) {
        const { min, max } = view.measures[measure];
        const { name, bands, unit } = MEASURE_LABELS[measure];
        const described = describeRange(bands, min, max, unit);

        if (described) {
            filters.push({
                id: measure,
                // Named as well as described, because "1–5 min" on its own is clear and
                // "5000 kbps and up" beside it is not -- the axis is the half that says which
                // control to go back to.
                label: `${name}: ${described}`,
                clear: withMeasureCleared(measure),
            });
        }
    }

    if (view.orientation) {
        filters.push({
            id: "orientation",
            label: ORIENTATION_LABELS[view.orientation],
            clear: (current) => ({ ...current, orientation: null, page: 0 }),
        });
    }

    if (view.animated) {
        filters.push({
            id: "animated",
            label: view.animated === "yes" ? "Animated" : "Stills only",
            clear: (current) => ({ ...current, animated: null, page: 0 }),
        });
    }

    /**
     * Tags, by name, one chip per clause (§14e).
     *
     * They used to be counted -- "3 tags" -- because the view holds ids and nothing here had
     * their names. With "with", "any of" and "without" in play a count stopped being an answer:
     * three tags could be three requirements, three alternatives, or one of each, and "why am I
     * seeing so little" turns on which. The names come from the facet response the panel is
     * already holding (`useFilterNames`).
     *
     * "With" picks are one chip, as before -- removing it clears every one -- because they are
     * one clause; each "without" is its own, because each is a separate exclusion somebody
     * will want to take back on its own.
     */
    if (view.tags.length > 0) {
        filters.push({
            id: "tags",
            label: `With ${view.tags.map((id) => describeRule({ t: "tag", id }, names)).join(", ")}`,
            clear: (current) => ({ ...normalizeTagLogic({ ...current, tags: [] }), page: 0 }),
        });
    }

    if (view.mentions) {
        filters.push({
            id: "mentions",
            label: `Mentions ${describeRule({ t: "tag", id: view.mentions }, names)}`,
            clear: (current) => ({ ...current, mentions: null, page: 0 }),
        });
    }

    for (const tagId of view.notTags) {
        filters.push({
            id: `not:${tagId}`,
            label: `Without ${describeRule({ t: "tag", id: tagId }, names)}`,
            clear: (current) => ({
                ...current,
                notTags: current.notTags.filter((id) => id !== tagId),
                page: 0,
            }),
        });
    }

    /**
     * A chip per group, facet's or Advanced, in the words the editor uses. Removing one removes
     * the whole group: it is one condition, and taking a rule out of the middle of it is the
     * editor's job, where the rest of the group is on screen.
     */
    view.groups.forEach((group, index) => {
        const described = describeGroup(group, names);

        filters.push({
            id: `group:${group.facet ?? "advanced"}:${index}`,
            label: group.facet ? capitalize(described) : `Advanced: ${described}`,
            clear: (current) => ({
                ...current,
                groups: current.groups.filter((candidate) => candidate !== group),
                page: 0,
            }),
        });
    });

    return filters;
};
