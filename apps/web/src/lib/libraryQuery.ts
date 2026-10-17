import {
    filterGroupsSchema,
    mediaQuerySchema,
    mediaSortSchema,
    naturalDirection,
    savedQuerySchema,
    sortHasDirection,
    type FilterGroup,
    type MediaSort,
    type SavedQuery,
    type SortDirection,
} from "@private-stock/core";

/**
 * How many items a page of the library holds.
 *
 * Here rather than in the grid because the viewer needs it too: prev/next walk the same
 * pages, and a second copy of this number would put the item page's idea of "3 of 312" out
 * of step with the page the grid actually served.
 */
export const PAGE_SIZE = 60;

/**
 * The library view, as it lives in the URL (§14).
 *
 * Filter state belongs in the URL so a view is shareable and the back button behaves. That
 * makes the URL a serialization format, and this module is its only reader and writer —
 * parsing in one component and building the request in another is how the two drift until a
 * shared link opens a different library than the one that was shared.
 *
 * Pure, so it can be tested without a browser or a server.
 */

/**
 * What the library is showing.
 *
 * Three views rather than a `gallery` boolean and an absence of parameters. The room used to
 * be "no root and nothing else set", which is not a state anything can navigate *to*: every
 * link back to it had to be spelled `/` and every control that wanted it had to know to strip
 * the whole query string. Naming it makes it a destination.
 */
export type LibraryMode = "room" | "grid" | "gallery";

const MODES: LibraryMode[] = ["room", "grid", "gallery"];

/**
 * The view a library lands in when nothing says otherwise.
 *
 * Opening a library means wanting to see what is in it, and arriving at the front door means
 * the room. So the default depends on whether a root is named, and neither case costs a
 * parameter -- `/` and `/?root=abc` are both already the right thing.
 */
export const defaultMode = (root: string | null): LibraryMode => (root ? "grid" : "room");

export interface LibraryView {
    /**
     * Which library is open, or null for the room.
     *
     * Navigation rather than a filter, which is why `isFiltered` ignores it: an empty library
     * needs "nothing here yet", not "nothing matches your filters", and the difference sends
     * someone to two different places to fix it.
     */
    root: string | null;
    search: string;
    kind: "all" | "video" | "image";
    sort: MediaSort;
    /**
     * Which way round the sort reads.
     *
     * Null means "whichever way this sort naturally does" rather than a fixed direction, so a
     * view that has never expressed a preference follows the sort it is paired with — picking
     * Title gives A–Z without anyone having had to also pick a direction.
     */
    direction: SortDirection | null;
    /**
     * Tag ids, ANDed: "with all of". Order is preserved so the URL is stable as chips are
     * toggled.
     */
    tags: string[];
    /** Tag ids none of which may be on an item: the "without" chips (§14e). */
    notTags: string[];
    /**
     * A look in words, or "" for none (§5e "Three ways in, one way out").
     *
     * One look at a time: this or `like`, never both — `withLook` keeps it so. A look orders the
     * few hundred best matches the other filters allow, best first, whatever `sort` says.
     */
    lookText: string;
    /** A look from a moment, `<mediaId>@<ms>` or a whole item's id, or "" for none. */
    like: string;
    /**
     * A tag whose names the item's text must contain, or null (§5d "Find untagged").
     *
     * Set by the tag page's "Find untagged", beside a `notTags` of the same id: the files that
     * say a name and are not filed under it yet.
     */
    mentions: string | null;
    /**
     * Any, all or none of a list of rules (§14e). The facet sections' "any of" mode and
     * Favourites chip are groups with `facet` set; the Advanced editor's have none. Read and
     * written through `tagLogic.ts`, which keeps the two from treading on each other.
     */
    groups: FilterGroup[];
    favorite: boolean;
    unrated: boolean;
    /**
     * Watched, unwatched, or don't care (§14b).
     *
     * Three states, so not the boolean the flags either side of it use. It is also the only
     * filter here that is always the viewer's own even inside somebody else's shared filter
     * — what you have watched is your history, not a property of the item.
     */
    watched: "yes" | "no" | null;
    minRating: number | null;
    maxRating: number | null;
    /**
     * Measured properties of the file, as half-open ranges (§14e).
     *
     * Null is "no bound", never zero. A minimum of zero is a real filter somebody can set,
     * and collapsing the two would make the control unable to express its own lower end.
     */
    measures: MeasureRanges;
    /** Which way up the picture is, or null for any. */
    orientation: Orientation | null;
    /** Moving stills, still stills, or don't care. Images only. */
    animated: "yes" | "no" | null;
    mode: LibraryMode;
    /**
     * The saved filter this view came from, or null (§14b).
     *
     * A marker, not a filter. The grid never reads it: the saved query is expanded into the
     * ordinary parameters when you open one, so every existing code path — the request, the
     * facet panel, the count, the back button — works unchanged and the URL stays shareable
     * and hand-editable.
     *
     * What it buys is knowing what to save over. With the id present the page can offer
     * "save changes" against a specific filter, and can say which filter you are looking at;
     * without it, saving could only ever create a new one. It also lets a divergence be
     * detected — the id says "Unrated 4K", the parameters say something else, so the view has
     * been edited since it was opened.
     */
    filterId: string | null;
    /** Zero-based. In the URL so a page is a shareable, reloadable address (§20). */
    page: number;
    /**
     * Which permutation a shuffle uses.
     *
     * In the URL for the same reason the page is: without it, a reload or a page turn would
     * reshuffle, and the second page of a freshly reshuffled library has nothing to do with
     * the first page you were looking at.
     */
    seed: number | null;
}

/**
 * The measurable axes, named once (§14e).
 *
 * A record rather than ten flat fields, because every one of them is parsed, serialized,
 * cleared and tested identically -- and a flat pair per axis means five near-identical blocks
 * in each of those four places, which is where the eleventh one gets forgotten.
 */
export const MEASURES = ["durationSec", "bitrateKbps", "fps", "resolution", "sizeMb"] as const;
export type Measure = (typeof MEASURES)[number];

export type MeasureRanges = Record<Measure, { min: number | null; max: number | null }>;

export type Orientation = "landscape" | "portrait" | "square";

/** Every axis unbounded -- what "no measurement filter" looks like. */
export const NO_MEASURES: MeasureRanges = {
    durationSec: { min: null, max: null },
    bitrateKbps: { min: null, max: null },
    fps: { min: null, max: null },
    resolution: { min: null, max: null },
    sizeMb: { min: null, max: null },
};

/**
 * The query parameter each bound is written as.
 *
 * `minDurationSec`, not `minDuration`: the unit is in the name because the column's unit is
 * different from the URL's, and a reader of the address bar deserves to know which they are
 * looking at (§14e).
 */
const boundParam = (measure: Measure, end: "min" | "max"): string =>
    `${end}${measure.charAt(0).toUpperCase()}${measure.slice(1)}`;

const parseBound = (params: URLSearchParams, measure: Measure, end: "min" | "max") => {
    const raw = params.get(boundParam(measure, end));

    if (raw === null) return null;

    const value = Number(raw);

    // Rejected rather than clamped. A hand-edited address with nonsense in it should show the
    // library, not silently filter it by something nobody asked for.
    return Number.isFinite(value) && value >= 0 ? value : null;
};

/** The address's `like`, checked as the server will check it, so a bad one is dropped here. */
const LIKE_PARAM = mediaQuerySchema.shape.like.unwrap();

export const DEFAULT_VIEW: LibraryView = {
    root: null,
    search: "",
    // Videos unless photos were asked for (§14e "Videos unless you ask"). An address with no
    // `kind` is the videos, so every link built without one -- a shelf's "see all", a tag's
    // shelves, a closed view -- lands where the household expects instead of on everything.
    kind: "video",
    sort: "addedAt",
    direction: null,
    tags: [],
    notTags: [],
    lookText: "",
    like: "",
    mentions: null,
    groups: [],
    favorite: false,
    unrated: false,
    watched: null,
    minRating: null,
    maxRating: null,
    measures: NO_MEASURES,
    orientation: null,
    animated: null,
    mode: "room",
    filterId: null,
    page: 0,
    seed: null,
};

// Read from the schema rather than listed here: a hand-kept copy fell behind when the
// resolution, bitrate, fps and lastViewed sorts were added, and the URL silently read them
// back as `addedAt`.
const isSort = (value: string | null): value is MediaSort =>
    mediaSortSchema.safeParse(value).success;

const isDirection = (value: string | null): value is SortDirection =>
    value === "asc" || value === "desc";

const isMode = (value: string | null): value is LibraryMode =>
    value !== null && (MODES as string[]).includes(value);

const isOrientation = (value: string | null): value is Orientation =>
    value === "landscape" || value === "portrait" || value === "square";

const idList = (value: string | null): string[] =>
    (value ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

/**
 * The groups in an address, or none.
 *
 * Dropped whole rather than in part when they do not parse: a hand-edited address with a
 * broken group should show the library without it, not some of its rules with the rest
 * silently gone -- and the server rejects the same string, so passing it on would be an error
 * page instead.
 */
const parseGroups = (value: string | null): FilterGroup[] => {
    if (!value) return [];

    const parsed = filterGroupsSchema.safeParse(value);

    return parsed.success ? parsed.data : [];
};

export const parseView = (params: URLSearchParams): LibraryView => {
    const minRating = Number(params.get("minRating"));
    const maxRating = Number(params.get("maxRating"));
    const rawOrientation = params.get("orientation");
    const root = params.get("root") || null;
    const rawMode = params.get("view");
    const kind = params.get("kind");
    // Read once: a type guard narrows the value it was given, not a second call that happens
    // to look the same.
    const rawDirection = params.get("direction");
    const direction = isDirection(rawDirection) ? rawDirection : null;

    return {
        root,
        search: params.get("search") ?? "",
        kind: kind === "all" || kind === "image" ? kind : "video",
        sort: isSort(params.get("sort")) ? (params.get("sort") as MediaSort) : "addedAt",
        direction: direction,
        tags: idList(params.get("tags")),
        notTags: idList(params.get("notTags")),
        // Words or a moment, never both: a hand-edited address carrying the two keeps the moment,
        // which is the more specific thing to have asked for.
        lookText: params.get("like") ? "" : (params.get("lookText") ?? "").trim().slice(0, 200),
        like: LIKE_PARAM.safeParse(params.get("like")).data ?? "",
        mentions: params.get("mentions") || null,
        groups: parseGroups(params.get("groups")),
        favorite: params.get("favorite") === "1",
        unrated: params.get("unrated") === "1",
        watched:
            params.get("watched") === "yes" ? "yes" : params.get("watched") === "no" ? "no" : null,
        minRating:
            Number.isInteger(minRating) && minRating >= 1 && minRating <= 5 ? minRating : null,
        maxRating:
            Number.isInteger(maxRating) && maxRating >= 1 && maxRating <= 5 ? maxRating : null,
        measures: Object.fromEntries(
            MEASURES.map((measure) => [
                measure,
                {
                    min: parseBound(params, measure, "min"),
                    max: parseBound(params, measure, "max"),
                },
            ])
        ) as MeasureRanges,
        orientation: isOrientation(rawOrientation) ? rawOrientation : null,
        animated:
            params.get("animated") === "yes"
                ? "yes"
                : params.get("animated") === "no"
                  ? "no"
                  : null,
        mode: isMode(rawMode) ? rawMode : defaultMode(root),
        filterId: params.get("filter") || null,
        page: Math.max(0, Number(params.get("page")) || 0),
        seed:
            Number.isFinite(Number(params.get("seed"))) && params.get("seed") !== null
                ? Number(params.get("seed"))
                : null,
    };
};

/**
 * The view as URL parameters, with defaults omitted.
 *
 * Omitting defaults is what keeps a plain library at `/` rather than at a URL carrying eight
 * parameters that all say "no filter". It also makes the "is anything filtered?" check below
 * a comparison against an empty string rather than a field-by-field audit that has to be
 * updated every time a filter is added.
 */
export const viewToParams = (view: LibraryView): URLSearchParams => {
    const params = new URLSearchParams();

    if (view.root) params.set("root", view.root);
    if (view.search) params.set("search", view.search);
    if (view.kind !== DEFAULT_VIEW.kind) params.set("kind", view.kind);
    if (view.sort !== "addedAt") params.set("sort", view.sort);
    // Omitted when it is the direction this sort would have taken anyway, so `?sort=title`
    // keeps meaning A–Z and only a deliberate reversal costs a parameter. Compared against
    // the *natural* direction, not the effective one -- the effective direction is the view's
    // own once it holds one, so comparing with that would never be unequal and the parameter
    // would never be written at all.
    if (
        view.direction !== null &&
        sortHasDirection(view.sort) &&
        view.direction !== naturalDirection(view.sort)
    ) {
        params.set("direction", view.direction);
    }
    if (view.tags.length > 0) params.set("tags", view.tags.join(","));
    if (view.notTags.length > 0) params.set("notTags", view.notTags.join(","));
    if (view.lookText) params.set("lookText", view.lookText);
    if (view.like) params.set("like", view.like);
    if (view.mentions) params.set("mentions", view.mentions);
    if (view.groups.length > 0) params.set("groups", JSON.stringify(view.groups));
    if (view.favorite) params.set("favorite", "1");
    if (view.unrated) params.set("unrated", "1");
    if (view.watched) params.set("watched", view.watched);
    if (view.minRating !== null) params.set("minRating", String(view.minRating));
    if (view.maxRating !== null) params.set("maxRating", String(view.maxRating));

    for (const measure of MEASURES) {
        const range = view.measures[measure];

        // Compared against null rather than tested for truthiness: a bound of zero is a
        // filter, and `if (range.min)` would drop it from the URL while leaving the control
        // showing it.
        if (range.min !== null) params.set(boundParam(measure, "min"), String(range.min));
        if (range.max !== null) params.set(boundParam(measure, "max"), String(range.max));
    }

    if (view.orientation) params.set("orientation", view.orientation);
    if (view.animated) params.set("animated", view.animated);
    // Omitted when it is where this address would land anyway, so the room stays `/` and a
    // library stays `/?root=abc`.
    if (view.mode !== defaultMode(view.root)) params.set("view", view.mode);
    if (view.filterId) params.set("filter", view.filterId);
    if (view.page > 0) params.set("page", String(view.page));
    if (view.seed !== null) params.set("seed", String(view.seed));

    return params;
};

/**
 * Parameters for the list and facet requests.
 *
 * Derived from the same view as the URL, deliberately: the facet panel and the grid must ask
 * the same question, or the panel offers counts the grid cannot reproduce.
 *
 * `view` is dropped because gallery mode is a rendering choice the server knows nothing
 * about — leaving it in would put it in the query key and refetch the whole library when
 * someone toggles the layout.
 */
export const viewToRequestParams = (view: LibraryView): URLSearchParams => {
    const params = viewToParams(view);

    params.delete("view");

    // The address and the query spell the kind oppositely: an address leaves out the videos,
    // its default, and a query leaves out "all", which is what no kind means to the server.
    // Stored queries were written in the query's spelling, so a view saved before videos became
    // the default still means what it meant (`savedQueryToParams`).
    if (view.kind === "all") {
        params.delete("kind");
    } else {
        params.set("kind", view.kind);
    }

    // `root` in an address, `rootId` in a query. Translated here rather than by naming the
    // URL parameter after the column, because this module is the only thing that is allowed
    // to know both spellings -- and a shared link reading `?root=` will outlive the column.
    const root = params.get("root");

    if (root) {
        params.delete("root");
        params.set("rootId", root);
    }

    // The page is sent per request rather than baked into the shared filter key, so that the
    // count and the facet counts -- which do not vary by page -- stay cached across page
    // turns instead of being refetched sixty times as someone walks the library.
    params.delete("page");

    // Which saved filter you opened *is* sent, although it used to be stripped to share a
    // cache entry with the same parameters typed by hand. A shared filter can resolve against
    // its owner's ratings, and only the server may decide that (§6) -- without the id, the
    // grid, its count and its facets all silently used the viewer's instead, while the same
    // filter on a home shelf used the owner's. One cache miss is the price of one answer.

    return params;
};

/** The request parameters minus the filter marker, for comparing queries rather than views. */
const queryParams = (view: LibraryView): URLSearchParams => {
    // Without the look, which a saved filter cannot keep (§5e): looking within a saved filter
    // is not an edit to it.
    const params = viewToRequestParams({
        ...view,
        lookText: "",
        like: "",
        sort: effectiveSort({ ...view, lookText: "", like: "" }),
    });

    params.delete("filter");
    // Nor the seed: a saved shuffle is "a shuffle", dealt afresh each time it is opened. Kept,
    // it froze the order the view had when it was saved, and every link to the view replayed
    // it -- Reshuffle changed only the address, so the next visit was the old set again.
    params.delete("seed");

    return params;
};

/**
 * Whether anything is narrowing the library.
 *
 * Used to decide what an empty result means: "nothing matches your filters" and "your
 * library is empty" need completely different screens, and showing the wrong one sends
 * someone to the admin page to fix a scan that is working fine.
 *
 * Sort and gallery mode are not filters — reordering a library does not hide anything.
 *
 * Nor are the videos: they are the library as it opens (§14e "Videos unless you ask"), so Photos
 * and All are the kinds that count. A library holding only photos is therefore not "filtered"
 * on Videos -- the grid's empty state asks about the kind separately for that case.
 */
export const isFiltered = (view: LibraryView): boolean =>
    view.search !== "" ||
    hasLook(view) ||
    view.kind !== DEFAULT_VIEW.kind ||
    view.tags.length > 0 ||
    view.notTags.length > 0 ||
    view.mentions !== null ||
    view.groups.length > 0 ||
    view.favorite ||
    view.unrated ||
    view.watched !== null ||
    view.minRating !== null ||
    view.maxRating !== null ||
    view.orientation !== null ||
    view.animated !== null ||
    MEASURES.some(
        (measure) => view.measures[measure].min !== null || view.measures[measure].max !== null
    );

/**
 * Which kinds of item an axis can describe (§14e).
 *
 * A filter that cannot apply is not a filter, it is an empty grid with no visible cause.
 * Duration, bit rate and frame rate are questions about a video; whether a picture moves is a
 * question about an image. Resolution, size and orientation are questions about a file.
 */
export const MEASURE_KIND: Record<Measure, "video" | "image" | "any"> = {
    durationSec: "video",
    bitrateKbps: "video",
    fps: "video",
    resolution: "any",
    sizeMb: "any",
};

/** A row in "The file" section: a measured axis, or one of the two that are chosen. */
export type FileFilterRow = Measure | "orientation" | "animated";

export interface FileFilterGroup {
    /** Heading to draw above the rows, or null when it would label nothing. */
    label: string | null;
    rows: FileFilterRow[];
}

const ROW_KIND: Record<FileFilterRow, "video" | "image" | "any"> = {
    ...MEASURE_KIND,
    orientation: "any",
    animated: "image",
};

/**
 * The file filters, grouped by what they can describe (§14e).
 *
 * **Data rather than conditionals in the panel**, because which rows appear is a question with
 * a right answer and a JSX tree full of `showVideoMeasures &&` is one nobody can check. It is
 * also the part most likely to go quietly wrong: a row offered for a kind that cannot answer it
 * is an empty grid, and a row withheld from a kind that can is a feature nobody finds.
 *
 * **Headings only on a mixed view.** Filtered to videos every row applies, and three headings
 * would label a distinction that no longer exists. On the combined view they are load-bearing:
 * length, bit rate and frame rate are questions about a video, movement is a question about an
 * image, and interleaving them with the two that apply to anything quietly says the library
 * holds one kind of thing.
 *
 * Shared rows come first. They are the ones that always apply, so they are the ones whose
 * position should not move as the kind changes.
 */
export const fileFilterGroups = (kind: LibraryView["kind"]): FileFilterGroup[] => {
    const mixed = kind === "all";

    const rowsFor = (applies: "video" | "image" | "any"): FileFilterRow[] =>
        (Object.keys(ROW_KIND) as FileFilterRow[]).filter((row) => ROW_KIND[row] === applies);

    const groups: FileFilterGroup[] = [{ label: mixed ? "Any item" : null, rows: rowsFor("any") }];

    if (kind !== "image") {
        groups.push({ label: mixed ? "Videos" : null, rows: rowsFor("video") });
    }

    if (kind !== "video") {
        groups.push({ label: mixed ? "Photos" : null, rows: rowsFor("image") });
    }

    return groups;
};

/**
 * The view with one measurement range applied, narrowed to the kind that can answer it.
 *
 * **Setting a video-only filter switches the view to videos.** The alternative is worse in
 * both directions: leaving `kind: "all"` silently drops every image from the results anyway —
 * an image has no duration, so it matches no duration range — and the person is left looking
 * at a library that lost half its contents with nothing on screen admitting why. Doing it
 * explicitly moves the kind control, which is visible, reversible, and in the same panel.
 *
 * Clearing a range does not put the kind back. It was a real choice once made, and undoing a
 * filter is not a licence to undo a different one somebody may have gone on to rely on.
 */
export const withMeasure = (
    view: LibraryView,
    measure: Measure,
    min: number | null,
    max: number | null
): LibraryView => {
    const applies = MEASURE_KIND[measure];
    const setting = min !== null || max !== null;

    return {
        ...view,
        measures: { ...view.measures, [measure]: { min, max } },
        kind: setting && applies !== "any" ? applies : view.kind,
        page: 0,
    };
};

/**
 * Every filter cleared, and nothing else.
 *
 * The library you are in, how you are looking at it and what order it is in are not filters,
 * so they survive. Written here rather than spelled out at the two call sites, because a
 * filter added without being added to a hand-written reset is one that cannot be cleared --
 * and the symptom is a "clear all" that visibly does not.
 *
 * The kind survives too. It narrows the grid, so `isFiltered` counts it, but it is closer to
 * choosing which shelf you are browsing than to a filter: most sessions are spent in Videos or
 * in Images, not both, and clearing a stack of filters used to throw you back into the mixed
 * library as a side effect. Leaving it takes its own click, on its own chip or control.
 */
export const clearFilters = (view: LibraryView): LibraryView => ({
    ...view,
    // Clearing everything leaves the saved view as well, because a view *is* its query.
    // Without this, emptying the filters kept the name in the address and in the sidebar and
    // reported the result as "Edited" -- the app claiming you had changed a view when what
    // you had done was leave it, and with no way back to the plain library except editing
    // the URL.
    filterId: null,
    search: "",
    tags: [],
    notTags: [],
    lookText: "",
    like: "",
    mentions: null,
    groups: [],
    favorite: false,
    unrated: false,
    watched: null,
    minRating: null,
    maxRating: null,
    measures: NO_MEASURES,
    orientation: null,
    animated: null,
    page: 0,
});

/**
 * Whether "clear all" would change anything -- every filter except the kind, which it keeps.
 *
 * A clear button shown over a grid narrowed only to Videos would do nothing when pressed.
 */
export const hasClearableFilters = (view: LibraryView): boolean =>
    isFiltered({ ...view, kind: DEFAULT_VIEW.kind });

/**
 * Leaves the saved view once nothing is narrowing the library any more.
 *
 * Removing filters one chip at a time ends in the same place as "clear all", and it has to
 * mean the same thing: an unfiltered grid is the library, not a saved view of it that happens
 * to select everything. Applied where a filter changes rather than inside every control, so
 * the rule is stated once.
 */
export const leaveViewIfEmpty = (view: LibraryView): LibraryView =>
    isFiltered(view) ? view : { ...view, filterId: null };

/**
 * Closes a saved view: back to the whole library.
 *
 * Deliberately not "keep what is on screen and forget the name" -- that leaves a grid nobody
 * can account for, wearing no title. Discarding an edit and keeping the view is a different
 * intention and has its own control.
 *
 * Unlike clearing, closing does reset the kind: a view's kind is part of the view, and the
 * plain library is what closing promises -- which is the videos (§14e).
 */
export const closeSavedFilter = (view: LibraryView): LibraryView =>
    clearFilters({ ...view, filterId: null, kind: DEFAULT_VIEW.kind });

/**
 * The sort to actually use.
 *
 * Relevance without a search term ranks every row identically, so the order degenerates to
 * whatever SQLite happens to return — which looks like a shuffle nobody asked for. Clearing
 * the search box therefore falls back rather than leaving the library in that state.
 */
export const effectiveSort = (view: LibraryView): MediaSort => {
    // A look orders its list, whatever the view's sort, as the server does (`sortOverride`).
    if (hasLook(view)) return "look";
    if (view.sort === "look") return "addedAt";

    return view.sort === "relevance" && !view.search ? "addedAt" : view.sort;
};

/** Whether the view asks for a look, in words or from a moment (§5e). */
export const hasLook = (view: Pick<LibraryView, "lookText" | "like">): boolean =>
    view.lookText !== "" || view.like !== "";

/**
 * The view with one look asked for, and the other way of asking cleared: words or a moment,
 * never both. Back to the first page, as any change of filter is.
 */
export const withLook = (
    view: LibraryView,
    look: { lookText: string } | { like: string }
): LibraryView => ({
    ...view,
    lookText: "lookText" in look ? look.lookText.trim() : "",
    like: "like" in look ? look.like : "",
    page: 0,
});

/**
 * The direction to actually use.
 *
 * Mirrors `effectiveSort`: what the grid is really doing, as opposed to what the view happens
 * to hold. A sort with no direction to speak of reports its natural one rather than null, so
 * callers never have to special-case it, and a stored preference for a *different* sort does
 * not leak into this one.
 */
export const effectiveDirection = (view: LibraryView): SortDirection => {
    const sort = effectiveSort(view);

    if (!sortHasDirection(sort)) {
        return naturalDirection(sort);
    }

    return view.direction ?? naturalDirection(sort);
};

/** A new permutation for a shuffle. */
export const newShuffleSeed = (): number => Math.floor(Math.random() * 1_000_000);

/**
 * Whether the view is a shuffle with no seed to say which one.
 *
 * Without a seed the server falls back to a fixed one, so every seedless way into a shuffle --
 * picking Shuffle from the sort menu, the room's "see all", the remembered Library link, a saved
 * filter stored without one -- showed the same order every time. The library page deals a seed
 * before rendering instead.
 */
export const needsShuffleSeed = (view: LibraryView): boolean =>
    view.mode !== "room" && view.sort === "random" && view.seed === null;

/**
 * The view with a different sort applied, and the direction that goes with it.
 *
 * Changing the sort clears the direction rather than carrying it over, which is the whole
 * point: someone who reversed Title to get Z–A and then switched to Date added wants the
 * newest, not the oldest. The preference belonged to the sort they left, and each sort has
 * an obvious right way round -- newest first, longest first, highest rated first -- which is
 * what `naturalDirection` supplies once the carried-over choice is gone.
 */
export const withSort = (view: LibraryView, sort: MediaSort): LibraryView => ({
    ...view,
    sort,
    direction: null,
});

/**
 * The current view as a storable query (§14b).
 *
 * Built from `viewToRequestParams` rather than field by field, deliberately: that function
 * already drops the page, already translates `root` to `rootId`, and already resolves the
 * sort and direction. A second mapping written by hand here would be a second place for the
 * two spellings to disagree, and the disagreement would only show up as a saved filter that
 * opens something other than what was saved.
 *
 * `savedQuerySchema` is `mediaQuerySchema` without the page, so this is validated by exactly
 * the schema the grid's own requests are — anything the panel cannot express cannot be
 * saved, and anything saved can be run.
 */
export const viewToSavedQuery = (view: LibraryView): SavedQuery =>
    savedQuerySchema.parse(Object.fromEntries(queryParams(view)));

/**
 * A stored query as the parameters that reproduce it.
 *
 * The inverse of the above, and the reason opening a saved filter needs no new code path in
 * the grid: the query is expanded into an ordinary library address, so the page that renders
 * it is the page that renders every other filter.
 *
 * `rootId` becomes `root` on the way back out. This module is the only thing allowed to know
 * both spellings — the same rule `viewToRequestParams` states going the other way.
 */
export const savedQueryToParams = (query: SavedQuery): URLSearchParams => {
    const params = new URLSearchParams();

    if (query.rootId) params.set("root", query.rootId);
    if (query.search) params.set("search", query.search);
    // A stored query with no kind asks for both, as it did when it was saved; in an address
    // that has to be said, because an address with no kind is the videos.
    params.set("kind", query.kind ?? "all");
    if (query.sort && query.sort !== "addedAt") params.set("sort", query.sort);
    if (query.direction) params.set("direction", query.direction);
    if (query.tags && query.tags.length > 0) params.set("tags", query.tags.join(","));
    if (query.notTags && query.notTags.length > 0) params.set("notTags", query.notTags.join(","));
    if (query.mentions) params.set("mentions", query.mentions);
    if (query.groups && query.groups.length > 0) {
        params.set("groups", JSON.stringify(query.groups));
    }
    if (query.favorite) params.set("favorite", "1");
    if (query.unrated) params.set("unrated", "1");
    if (query.watched) params.set("watched", query.watched);
    if (query.minRating !== undefined) params.set("minRating", String(query.minRating));
    if (query.maxRating !== undefined) params.set("maxRating", String(query.maxRating));

    // The stored query already spells these exactly as the address does -- same names, same
    // units -- so they are copied rather than mapped. Naming them individually would be a
    // second list to keep in step with `MEASURES`, and a filter saved with a bound this list
    // had not learned about yet would open without it.
    for (const measure of MEASURES) {
        for (const end of ["min", "max"] as const) {
            const key = boundParam(measure, end) as keyof typeof query;
            const value = query[key];

            if (typeof value === "number") params.set(boundParam(measure, end), String(value));
        }
    }

    if (query.orientation) params.set("orientation", query.orientation);
    if (query.animated) params.set("animated", query.animated);
    // `query.seed` is not copied: filters saved before the seed was dropped still carry one,
    // and opening them should deal a new shuffle like any other (`queryParams`).

    return params;
};

/**
 * Whether the view still matches the filter it was opened from.
 *
 * Compared as the request parameters rather than as views, so the things that are not part
 * of a saved query -- the page you have turned to, grid against gallery, the filter id
 * itself -- cannot register as an edit. Turning to page 4 of a saved filter is not a change
 * to the filter.
 */
export const matchesSavedQuery = (view: LibraryView, query: SavedQuery): boolean => {
    const current = queryParams(view);
    const saved = queryParams({
        ...DEFAULT_VIEW,
        ...paramsToViewFields(savedQueryToParams(query)),
    });

    current.sort();
    saved.sort();

    return current.toString() === saved.toString();
};

/** The filter-bearing fields of an address, for comparison and for opening. */
const paramsToViewFields = (params: URLSearchParams): Partial<LibraryView> => {
    const parsed = parseView(params);

    return {
        root: parsed.root,
        search: parsed.search,
        kind: parsed.kind,
        sort: parsed.sort,
        direction: parsed.direction,
        tags: parsed.tags,
        notTags: parsed.notTags,
        mentions: parsed.mentions,
        groups: parsed.groups,
        favorite: parsed.favorite,
        unrated: parsed.unrated,
        watched: parsed.watched ?? undefined,
        minRating: parsed.minRating,
        maxRating: parsed.maxRating,
        measures: parsed.measures,
        orientation: parsed.orientation,
        animated: parsed.animated,
        seed: parsed.seed,
    };
};

/**
 * The view that opening a saved filter produces.
 *
 * The mode is carried over from wherever you were rather than reset, so opening a saved
 * filter from the gallery keeps you in the gallery: a saved query says what to show, not how
 * to draw it, and `savedQuerySchema` has nowhere to put a rendering choice anyway.
 */
export const openSavedFilter = (view: LibraryView, id: string, query: SavedQuery): LibraryView => ({
    ...DEFAULT_VIEW,
    ...paramsToViewFields(savedQueryToParams(query)),
    mode: view.mode === "room" ? "grid" : view.mode,
    filterId: id,
    page: 0,
});

/**
 * The library showing everything that carries any of the viewer's favourite tags of one facet:
 * the Tags area's "See their items" (§6 "Favourite tags").
 */
export const favoriteTagsHref = (kind: string): string =>
    `/?${viewToParams({
        ...DEFAULT_VIEW,
        mode: "grid",
        // The filter panel's own shape for its Favourites chip, so the panel opens with that
        // chip on and the link is no different from having clicked it (§14e).
        groups: [{ match: "any", facet: kind, rules: [{ t: "favTags", kind }] }],
    }).toString()}`;

/**
 * The address of a saved filter.
 *
 * One definition, because three surfaces link to the same place — the sidebar, a shelf's
 * "see all", and the picker on the library page — and a second spelling would be a filter
 * that opens differently depending on which of them you clicked.
 *
 * The query is expanded into ordinary parameters, with `filter` naming where it came from.
 * A filter whose stored query can no longer be read still gets an address: it lands on the
 * library with the marker set, which is how it can be found and deleted deliberately rather
 * than being a dead entry that goes nowhere.
 */
export const savedFilterHref = (filter: { id: string; query: SavedQuery | null }): string => {
    const params = filter.query ? savedQueryToParams(filter.query) : new URLSearchParams();

    params.set("view", "grid");
    params.set("filter", filter.id);

    return `/?${params.toString()}`;
};

/**
 * The library, showing what names a tag but does not carry it (§5d "Find untagged").
 *
 * In the grid, because what follows is ticking and tagging, and the library is where both
 * already are -- with the tag offered for them (`LibraryCellar`).
 */
export const untaggedMentionsHref = (tagId: string): string =>
    `/?${viewToParams({ ...DEFAULT_VIEW, mode: "grid", mentions: tagId, notTags: [tagId] })}`;
