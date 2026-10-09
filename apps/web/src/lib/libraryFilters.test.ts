import { describe, expect, it } from "vitest";

import { activeFilters } from "./activeFilters";
import {
    DEFAULT_VIEW,
    MEASURES,
    clearFilters,
    hasClearableFilters,
    fileFilterGroups,
    isFiltered,
    parseView,
    viewToParams,
    viewToSavedQuery,
    savedQueryToParams,
    withMeasure,
    type LibraryView,
} from "./libraryQuery";

/**
 * That a filter survives the round trip, and can be seen and undone (§14e).
 *
 * Filter state lives in the URL, so every filter passes through four separate pieces of code
 * — written, parsed, saved, reopened — and a filter that is only wired into three of them
 * fails silently. The shared link opens a different library than the one that was shared,
 * which nobody can report because both ends look correct to the person holding them.
 *
 * The listing tests are written against `MEASURES` rather than field by field, so a sixth
 * axis added later is covered the moment it is named.
 */

const withFilters = (fields: Partial<LibraryView>): LibraryView => ({
    ...DEFAULT_VIEW,
    ...fields,
});

const roundTrip = (view: LibraryView): LibraryView => parseView(viewToParams(view));

describe("carrying a measurement through the URL", () => {
    it.each(MEASURES)("survives being written and read back: %s", (measure) => {
        const view = withMeasure(DEFAULT_VIEW, measure, 10, 20);

        expect(roundTrip(view).measures[measure]).toEqual({ min: 10, max: 20 });
    });

    it.each(MEASURES)("carries one end on its own: %s", (measure) => {
        expect(roundTrip(withMeasure(DEFAULT_VIEW, measure, 5, null)).measures[measure]).toEqual({
            min: 5,
            max: null,
        });
        expect(roundTrip(withMeasure(DEFAULT_VIEW, measure, null, 5)).measures[measure]).toEqual({
            min: null,
            max: 5,
        });
    });

    /**
     * Zero is a bound somebody can set and null is the absence of one. Collapsing them —
     * which any truthiness check does — makes a control unable to express its own lower end.
     */
    it("keeps a bound of zero out of the bin marked 'no bound'", () => {
        const view = withMeasure(DEFAULT_VIEW, "fps", 0, 24.5);

        expect(viewToParams(view).get("minFps")).toBe("0");
        expect(roundTrip(view).measures.fps).toEqual({ min: 0, max: 24.5 });
    });

    it("costs nothing in the address when nothing is bounded", () => {
        expect(viewToParams(DEFAULT_VIEW).toString()).toBe("");
    });

    /** A hand-edited address with nonsense in it should show the library, not filter it. */
    it("ignores a bound that is not a number", () => {
        const params = new URLSearchParams("minDurationSec=soon&maxSizeMb=-4");

        expect(parseView(params).measures.durationSec.min).toBeNull();
        expect(parseView(params).measures.sizeMb.max).toBeNull();
    });

    it("names its unit in the parameter, so the address says which it means", () => {
        const params = viewToParams(withMeasure(DEFAULT_VIEW, "durationSec", 60, null));

        expect(params.get("minDurationSec")).toBe("60");
        expect(params.has("minDuration")).toBe(false);
    });
});

describe("asking a question only one kind can answer", () => {
    /**
     * An image has no duration, so a duration filter on a mixed library drops every image
     * whatever the kind control says. Doing it explicitly moves a control the person can see
     * and undo; leaving it implicit empties half the library with nothing admitting why.
     */
    it.each(["durationSec", "bitrateKbps", "fps"] as const)(
        "narrows the view to videos: %s",
        (measure) => {
            expect(withMeasure(DEFAULT_VIEW, measure, 1, null).kind).toBe("video");
        }
    );

    it.each(["resolution", "sizeMb"] as const)(
        "leaves the kind alone for a question either can answer: %s",
        (measure) => {
            expect(withMeasure(DEFAULT_VIEW, measure, 1, null).kind).toBe(DEFAULT_VIEW.kind);
        }
    );

    /**
     * Clearing a range does not put the kind back. It was a real choice once made, and undoing
     * one filter is not a licence to undo a different one somebody may have gone on to rely on.
     */
    it("does not widen the kind again when the range is cleared", () => {
        const narrowed = withMeasure(DEFAULT_VIEW, "durationSec", 60, null);

        expect(withMeasure(narrowed, "durationSec", null, null).kind).toBe("video");
    });
});

describe("knowing that something is filtered", () => {
    it.each(MEASURES)("counts a measurement as a filter: %s", (measure) => {
        expect(isFiltered(withMeasure(DEFAULT_VIEW, measure, 1, null))).toBe(true);
    });

    it("counts the new flags too", () => {
        expect(isFiltered(withFilters({ orientation: "portrait" }))).toBe(true);
        expect(isFiltered(withFilters({ animated: "no" }))).toBe(true);
        expect(isFiltered(withFilters({ maxRating: 3 }))).toBe(true);
    });

    /** Reordering hides nothing, so a sort is not a filter and must not light this up. */
    it("does not count a sort", () => {
        expect(isFiltered(withFilters({ sort: "duration", direction: "asc" }))).toBe(false);
    });

    it("leaves nothing behind when everything is cleared", () => {
        const busy = withFilters({
            search: "wedding",
            orientation: "portrait",
            animated: "yes",
            maxRating: 2,
            minRating: 1,
            tags: ["t1"],
            measures: withMeasure(DEFAULT_VIEW, "fps", 0, 24.5).measures,
        });

        expect(isFiltered(clearFilters(busy))).toBe(false);
    });

    /**
     * Clearing filters must not move you, restyle the page or reorder it. Those are not
     * filters, and a "clear filters" that changed them would be doing something nobody asked.
     */
    it("keeps the library, the layout and the order", () => {
        const view = withFilters({
            root: "r1",
            mode: "gallery",
            sort: "duration",
            direction: "asc",
            orientation: "portrait",
        });
        const cleared = clearFilters(view);

        expect(cleared.root).toBe("r1");
        expect(cleared.mode).toBe("gallery");
        expect(cleared.sort).toBe("duration");
        expect(cleared.direction).toBe("asc");
    });

    /** Videos or Photos is which shelf you are on; leaving it takes its own click. */
    it("keeps the kind, and offers no clear when the kind is all that is set", () => {
        const cleared = clearFilters(withFilters({ kind: "image", favorite: true }));

        expect(cleared.kind).toBe("image");
        expect(cleared.favorite).toBe(false);
        expect(hasClearableFilters(cleared)).toBe(false);
        expect(isFiltered(cleared)).toBe(true);
    });
});

describe("saving and reopening a filter", () => {
    it.each(MEASURES)("stores and restores a measurement: %s", (measure) => {
        const view = withMeasure(DEFAULT_VIEW, measure, 3, 9);
        const reopened = parseView(savedQueryToParams(viewToSavedQuery(view)));

        expect(reopened.measures[measure]).toEqual({ min: 3, max: 9 });
    });

    it("stores the flags a saved filter is allowed to carry", () => {
        const view = withFilters({ orientation: "square", animated: "no", maxRating: 4 });
        const reopened = parseView(savedQueryToParams(viewToSavedQuery(view)));

        expect(reopened.orientation).toBe("square");
        expect(reopened.animated).toBe("no");
        expect(reopened.maxRating).toBe(4);
    });
});

describe("saying what is narrowing the library", () => {
    it("names a band rather than the numbers it was built from", () => {
        const view = withMeasure(DEFAULT_VIEW, "resolution", 1_080, 1_440);

        expect(activeFilters(view).map((filter) => filter.label)).toContain(
            "Resolution: 1080p (1080–1439)"
        );
    });

    it("falls back to the numbers for a range no preset covers", () => {
        const view = withMeasure(DEFAULT_VIEW, "sizeMb", 250, null);

        expect(activeFilters(view).map((filter) => filter.label)).toContain("Size: 250 MB and up");
    });

    /**
     * The chips exist to answer "why am I seeing so little", so a filter in force with no chip
     * is the one failure this list must not have. Checked against `isFiltered`, which is the
     * same question asked by the other half of the app.
     */
    it.each(MEASURES)("shows a chip for every measurement in force: %s", (measure) => {
        // A video-only measure also sets the kind, which the tabs show rather than a chip.
        expect(activeFilters(withMeasure(DEFAULT_VIEW, measure, 1, null))).toHaveLength(1);
    });

    it("shows nothing at all for an unfiltered library", () => {
        expect(activeFilters(DEFAULT_VIEW)).toEqual([]);
    });

    /** One chip for a band, so removing it cannot leave half a rating filter behind. */
    it("treats a rating band as one thing", () => {
        const chips = activeFilters(withFilters({ minRating: 2, maxRating: 4 }));

        expect(chips).toHaveLength(1);
        expect(chips[0].label).toBe("2–4 stars");
        expect(chips[0].clear(withFilters({ minRating: 2, maxRating: 4 }))).toMatchObject({
            minRating: null,
            maxRating: null,
        });
    });

    it("removes exactly the one that was clicked", () => {
        const view = withFilters({
            orientation: "portrait",
            measures: withMeasure(DEFAULT_VIEW, "sizeMb", 100, null).measures,
        });
        const orientationChip = activeFilters(view).find((filter) => filter.id === "orientation");
        const after = orientationChip!.clear(view);

        expect(after.orientation).toBeNull();
        expect(after.measures.sizeMb).toEqual({ min: 100, max: null });
    });
});

describe("grouping the file filters by what they can describe", () => {
    /**
     * The combined view is the one that mixes concepts, so it is the only one that needs
     * saying which filter applies to what. Filtered to a single kind, every row applies and a
     * heading would label a distinction that no longer exists.
     */
    it("labels the groups only when both kinds are on screen", () => {
        expect(fileFilterGroups("all").map((group) => group.label)).toEqual([
            "Any item",
            "Videos",
            "Photos",
        ]);
        expect(fileFilterGroups("video").every((group) => group.label === null)).toBe(true);
        expect(fileFilterGroups("image").every((group) => group.label === null)).toBe(true);
    });

    it("puts the rows that always apply first, so they do not move", () => {
        for (const kind of ["all", "video", "image"] as const) {
            expect(fileFilterGroups(kind)[0].rows).toEqual(["resolution", "sizeMb", "orientation"]);
        }
    });

    it("offers the video measurements to videos and a mixed view, never to images", () => {
        const rowsFor = (kind: LibraryView["kind"]) =>
            fileFilterGroups(kind).flatMap((group) => group.rows);

        expect(rowsFor("all")).toContain("durationSec");
        expect(rowsFor("video")).toContain("durationSec");
        expect(rowsFor("image")).not.toContain("durationSec");
    });

    /** Movement is a question only a still can answer; a video is not "an unanimated image". */
    it("offers movement to images and a mixed view, never to videos", () => {
        const rowsFor = (kind: LibraryView["kind"]) =>
            fileFilterGroups(kind).flatMap((group) => group.rows);

        expect(rowsFor("image")).toContain("animated");
        expect(rowsFor("all")).toContain("animated");
        expect(rowsFor("video")).not.toContain("animated");
    });

    /**
     * Every row has to appear somewhere for some kind, or it is a filter the schema accepts,
     * the URL carries and no control can reach.
     */
    it("leaves no row unreachable", () => {
        const everywhere = new Set(
            (["all", "video", "image"] as const).flatMap((kind) =>
                fileFilterGroups(kind).flatMap((group) => group.rows)
            )
        );

        for (const measure of MEASURES) {
            expect(everywhere.has(measure), `${measure} has no control`).toBe(true);
        }
        expect(everywhere.has("orientation")).toBe(true);
        expect(everywhere.has("animated")).toBe(true);
    });

    it("never lists the same row twice on one view", () => {
        for (const kind of ["all", "video", "image"] as const) {
            const rows = fileFilterGroups(kind).flatMap((group) => group.rows);

            expect(new Set(rows).size).toBe(rows.length);
        }
    });
});
