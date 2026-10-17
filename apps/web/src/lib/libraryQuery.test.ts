import { describe, expect, it } from "vitest";

import { mediaSortSchema } from "@private-stock/core";

import {
    clearFilters,
    closeSavedFilter,
    DEFAULT_VIEW,
    effectiveDirection,
    effectiveSort,
    isFiltered,
    hasLook,
    leaveViewIfEmpty,
    matchesSavedQuery,
    needsShuffleSeed,
    openSavedFilter,
    parseView,
    savedQueryToParams,
    viewToParams,
    viewToRequestParams,
    untaggedMentionsHref,
    viewToSavedQuery,
    withLook,
    withSort,
    type LibraryView,
    NO_MEASURES,
} from "./libraryQuery";

/**
 * The URL is a serialization format, so it gets the treatment one deserves: round-trips,
 * hostile input, and the specific decisions that are invisible until they are wrong.
 */

const view = (overrides: Partial<LibraryView> = {}): LibraryView => ({
    ...DEFAULT_VIEW,
    ...overrides,
});

describe("parseView", () => {
    it("reads only the two words it knows for watched", () => {
        // Three states, and the URL is hand-editable by design (§14). Anything else has to
        // mean "don't care" rather than silently filtering to one side of a question the
        // address did not actually ask.
        expect(parseView(new URLSearchParams("watched=yes")).watched).toBe("yes");
        expect(parseView(new URLSearchParams("watched=no")).watched).toBe("no");
        expect(parseView(new URLSearchParams("watched=1")).watched).toBeNull();
        expect(parseView(new URLSearchParams("watched=")).watched).toBeNull();
    });

    it("returns the defaults for an empty URL", () => {
        expect(parseView(new URLSearchParams())).toEqual(DEFAULT_VIEW);
    });

    it("reads every filter", () => {
        const parsed = parseView(
            new URLSearchParams(
                "search=rain&kind=video&sort=title&tags=a,b&favorite=1&unrated=1" +
                    "&watched=no&playback=blocked&minRating=3&view=gallery&notTags=c&mentions=e&lookText=neon" +
                    `&groups=${encodeURIComponent(
                        JSON.stringify([
                            { match: "any", rules: [{ t: "unrated" }, { t: "tag", id: "d" }] },
                        ])
                    )}`
            )
        );

        expect(parsed).toEqual({
            search: "rain",
            kind: "video",
            root: null,
            sort: "title",
            // Absent from the URL, so the sort decides. A URL from before direction existed
            // parses to exactly this, which is what keeps old links meaning what they meant.
            direction: null,
            tags: ["a", "b"],
            notTags: ["c"],
            lookText: "neon",
            like: "",
            mentions: "e",
            groups: [
                {
                    match: "any",
                    rules: [{ t: "unrated" }, { t: "tag", id: "d" }],
                },
            ],
            favorite: true,
            unrated: true,
            watched: "no",
            playback: "blocked",
            minRating: 3,
            // The measurement filters and the two flags beside them are absent from this URL,
            // so they parse to their unset values. Listed rather than omitted: this assertion
            // is exhaustive on purpose, so a field added to the view without being taught to
            // the parser fails here rather than silently reading as undefined (§14e).
            maxRating: null,
            measures: NO_MEASURES,
            orientation: null,
            animated: null,
            mode: "gallery",
            // Not in the URL, so this view did not come from a saved filter.
            filterId: null,
            page: 0,
            seed: null,
        });
    });

    // The parser once kept its own list of sorts, which fell behind the schema: picking
    // "Bit rate" wrote `?sort=bitrate` and read it straight back as the default.
    it.each(mediaSortSchema.options)("round-trips sort=%s", (sort) => {
        expect(parseView(viewToParams(view({ sort }))).sort).toBe(sort);
    });

    describe("hand-edited or stale URLs", () => {
        // A URL is a shared link and a bookmark, so it arrives from previous versions of the
        // app and from people editing it. None of these may throw or produce a broken view.
        const cases: [string, Partial<LibraryView>][] = [
            ["kind=nonsense", { kind: "video" }],
            ["sort=byVibes", { sort: "addedAt" }],
            ["minRating=99", { minRating: null }],
            ["minRating=0", { minRating: null }],
            ["minRating=abc", { minRating: null }],
            ["minRating=2.5", { minRating: null }],
            ["favorite=yes", { favorite: false }],
            ["tags=", { tags: [] }],
            ["tags=,,a,,", { tags: ["a"] }],
        ];

        it.each(cases)("survives %j", (queryString, expected) => {
            expect(parseView(new URLSearchParams(queryString))).toMatchObject(expected);
        });
    });
});

describe("viewToParams", () => {
    it("omits defaults so an unfiltered library has a clean URL", () => {
        expect(viewToParams(DEFAULT_VIEW).toString()).toBe("");
    });

    it("round-trips every filter", () => {
        const original = view({
            search: "summer rain",
            kind: "image",
            sort: "duration",
            tags: ["a", "b"],
            favorite: true,
            unrated: true,
            minRating: 4,
            mode: "gallery",
            page: 7,
            seed: 12_345,
        });

        expect(parseView(viewToParams(original))).toEqual(original);
    });
});

describe("the room, the cellar, and which library", () => {
    it("lands in the room at the bare address", () => {
        // `/` is a destination, not the absence of one: the room is what an arriving viewer
        // gets, and it has to survive a round trip like any other view.
        expect(parseView(new URLSearchParams("")).mode).toBe("room");
    });

    it("lands in the grid when a library is named", () => {
        // Opening a library means wanting to see what is in it. Defaulting to the room there
        // would show the front door again with one of its own doors already chosen.
        expect(parseView(new URLSearchParams("root=abc")).mode).toBe("grid");
        expect(parseView(new URLSearchParams("root=abc")).root).toBe("abc");
    });

    it("costs no parameter when the mode is where the address would land anyway", () => {
        // Otherwise every link to the room carries `view=room` and every library link carries
        // `view=grid`, which is two ways to spell each address and a diff every time someone
        // navigates.
        expect(viewToParams(view({ mode: "room" })).get("view")).toBeNull();
        expect(viewToParams(view({ root: "abc", mode: "grid" })).get("view")).toBeNull();
    });

    it("spells out a mode that is not the default", () => {
        expect(viewToParams(view({ mode: "grid" })).get("view")).toBe("grid");
        expect(viewToParams(view({ root: "abc", mode: "gallery" })).get("view")).toBe("gallery");
    });

    it("round-trips a library through the URL", () => {
        const original = view({ root: "abc", mode: "gallery", kind: "video", page: 3 });

        expect(parseView(viewToParams(original))).toEqual(original);
    });

    it("asks the API for rootId, having put root in the address", () => {
        // The URL is a shared link and outlives the column name; the query is the column.
        // This module is the only thing allowed to know both spellings.
        const params = viewToRequestParams(view({ root: "abc" }));

        expect(params.get("rootId")).toBe("abc");
        expect(params.get("root")).toBeNull();
    });

    it("does not count being in a library as a filter", () => {
        // An empty library needs "nothing here yet" and a sentence about scanning, not
        // "nothing matches your filters" and a button that clears filters there are none of.
        expect(isFiltered(view({ root: "abc" }))).toBe(false);
    });
});

describe("viewToRequestParams", () => {
    it("drops the layout, which the server knows nothing about", () => {
        // Leaving it in would put gallery mode in the query key and refetch the whole
        // library every time someone toggles the layout.
        const params = viewToRequestParams(view({ mode: "gallery", kind: "video" }));

        expect(params.get("view")).toBeNull();
        expect(params.get("kind")).toBe("video");
    });

    it("sends tags as one comma-separated parameter", () => {
        expect(viewToRequestParams(view({ tags: ["a", "b"] })).get("tags")).toBe("a,b");
    });
});

/**
 * Videos unless you ask (§14e). The address leaves out the videos and the query leaves out
 * "all", so the same view is spelled two ways -- and a stored query written before the default
 * moved must still open on everything.
 */
describe("the kind's two spellings", () => {
    it("reads an address without a kind as the videos", () => {
        expect(parseView(new URLSearchParams("view=grid&tags=a")).kind).toBe("video");
        expect(viewToParams(view({ kind: "video" })).has("kind")).toBe(false);
    });

    it("writes everything into the address, since leaving it out now means the videos", () => {
        expect(viewToParams(view({ kind: "all" })).get("kind")).toBe("all");
        expect(parseView(viewToParams(view({ kind: "all" }))).kind).toBe("all");
    });

    it("asks the server for the videos, and for everything by asking for no kind", () => {
        expect(viewToRequestParams(view()).get("kind")).toBe("video");
        expect(viewToRequestParams(view({ kind: "all" })).has("kind")).toBe(false);
    });

    it("opens a stored query with no kind on everything, as it was saved", () => {
        const saved = viewToSavedQuery(view({ kind: "all", favorite: true }));

        expect(saved.kind).toBeUndefined();
        expect(openSavedFilter(view(), "f1", saved).kind).toBe("all");
        expect(openSavedFilter(view(), "f1", { favorite: true } as never).kind).toBe("all");
    });

    it("keeps a stored query's kind when it has one", () => {
        const saved = viewToSavedQuery(view({ kind: "video", favorite: true }));

        expect(saved.kind).toBe("video");
        expect(openSavedFilter(view(), "f1", saved).kind).toBe("video");
    });
});

describe("isFiltered", () => {
    it("is false for a sorted but unfiltered library", () => {
        // Reordering hides nothing, so an empty result here really does mean an empty
        // library — and must send the user to the admin page rather than to "clear filters".
        expect(isFiltered(view({ sort: "title", mode: "gallery" }))).toBe(false);
    });

    it.each([
        ["search", view({ search: "x" })],
        ["kind", view({ kind: "image" })],
        ["tags", view({ tags: ["a"] })],
        ["favorite", view({ favorite: true })],
        ["unrated", view({ unrated: true })],
        ["minRating", view({ minRating: 3 })],
    ])("is true when %s narrows the library", (_label, filtered) => {
        expect(isFiltered(filtered)).toBe(true);
    });
});

describe("effectiveSort", () => {
    it("falls back when relevance has nothing to rank", () => {
        // Every row scores identically without a search term, so the order degenerates into
        // what looks like a shuffle nobody asked for.
        expect(effectiveSort(view({ sort: "relevance" }))).toBe("addedAt");
    });

    it("keeps relevance when there is a search", () => {
        expect(effectiveSort(view({ sort: "relevance", search: "rain" }))).toBe("relevance");
    });
});

describe("paging in the URL", () => {
    it("omits page zero so a fresh library has a clean address", () => {
        expect(viewToParams(DEFAULT_VIEW).has("page")).toBe(false);
    });

    it("round-trips a page", () => {
        expect(parseView(viewToParams(view({ page: 12 }))).page).toBe(12);
    });

    it("refuses a negative or nonsense page", () => {
        // A hand-edited URL must not produce a negative OFFSET, which SQLite rejects
        // outright -- the grid would 500 rather than showing page one.
        expect(parseView(new URLSearchParams("page=-5")).page).toBe(0);
        expect(parseView(new URLSearchParams("page=banana")).page).toBe(0);
    });

    it("keeps the page out of the shared filter key", () => {
        // The count and the facet counts do not vary by page. Including it would refetch
        // both on every page turn, which is the expensive half of the request.
        expect(viewToRequestParams(view({ page: 9, kind: "video" })).has("page")).toBe(false);
        expect(viewToRequestParams(view({ page: 9, kind: "video" })).get("kind")).toBe("video");
    });

    it("asks for a seed only for a shuffle in the library that has none", () => {
        expect(needsShuffleSeed(view({ mode: "grid", sort: "random" }))).toBe(true);
        expect(needsShuffleSeed(view({ mode: "grid", sort: "random", seed: 5 }))).toBe(false);
        expect(needsShuffleSeed(view({ mode: "grid", sort: "title" }))).toBe(false);
        expect(needsShuffleSeed(view({ mode: "room", sort: "random" }))).toBe(false);
    });

    it("keeps the shuffle seed, so paging a shuffle does not reshuffle", () => {
        expect(parseView(viewToParams(view({ sort: "random", seed: 99 }))).seed).toBe(99);
    });
});

/**
 * Sort direction (§14).
 *
 * The bug that prompted this: every sort defaulted to descending, so choosing "Title" listed
 * the library from Z to A. A default is only wrong in one way that matters -- when it makes
 * the obvious choice produce the surprising result -- and that was it.
 */
describe("sort direction", () => {
    it("reads a title A–Z without anyone having to ask", () => {
        expect(effectiveDirection(view({ sort: "title" }))).toBe("asc");
    });

    it("still reads dates, sizes and ratings with the interesting end first", () => {
        expect(effectiveDirection(view({ sort: "addedAt" }))).toBe("desc");
        expect(effectiveDirection(view({ sort: "capturedAt" }))).toBe("desc");
        expect(effectiveDirection(view({ sort: "duration" }))).toBe("desc");
        expect(effectiveDirection(view({ sort: "size" }))).toBe("desc");
        expect(effectiveDirection(view({ sort: "rating" }))).toBe("desc");
    });

    it("honours an explicit reversal", () => {
        expect(effectiveDirection(view({ sort: "title", direction: "desc" }))).toBe("desc");
        expect(effectiveDirection(view({ sort: "addedAt", direction: "asc" }))).toBe("asc");
    });

    /**
     * A preference belongs to the sort it was expressed about. Someone who reversed Title to
     * get Z–A and then picked Date added wants the newest, not the oldest.
     */
    it("forgets the direction when the sort changes", () => {
        const reversed = view({ sort: "title", direction: "desc" });

        expect(withSort(reversed, "addedAt").direction).toBeNull();
        expect(effectiveDirection(withSort(reversed, "addedAt"))).toBe("desc");
    });

    it("reports a natural direction even for a sort that has none", () => {
        // Rather than null, so no caller has to special-case a shuffle.
        expect(effectiveDirection(view({ sort: "random" }))).toBe("desc");
    });

    /** A stale direction from the sort someone left must not colour the fallback. */
    it("uses the fallback sort's direction when relevance has nothing to rank", () => {
        expect(effectiveDirection(view({ sort: "relevance", search: "" }))).toBe("desc");
    });

    it("keeps a plain library out of the URL", () => {
        expect(viewToParams(view({ sort: "title" })).has("direction")).toBe(false);
        expect(viewToParams(view({ sort: "title" })).get("sort")).toBe("title");
    });

    it("writes the direction only when it is a deliberate reversal", () => {
        expect(viewToParams(view({ sort: "title", direction: "asc" })).has("direction")).toBe(
            false
        );
        expect(viewToParams(view({ sort: "title", direction: "desc" })).get("direction")).toBe(
            "desc"
        );
    });

    it("round-trips through the URL", () => {
        const reversed = view({ sort: "title", direction: "desc" });

        expect(parseView(viewToParams(reversed)).direction).toBe("desc");
        expect(effectiveDirection(parseView(viewToParams(reversed)))).toBe("desc");
    });

    it("ignores a hand-edited direction that means nothing", () => {
        expect(parseView(new URLSearchParams("direction=sideways")).direction).toBeNull();
        expect(effectiveDirection(parseView(new URLSearchParams("sort=title&direction=")))).toBe(
            "asc"
        );
    });

    it("sends the direction to the server alongside the sort", () => {
        const params = viewToRequestParams(view({ sort: "title", direction: "desc" }));

        expect(params.get("sort")).toBe("title");
        expect(params.get("direction")).toBe("desc");
    });

    /** Reordering a library hides nothing, so it must not trigger the "no matches" screen. */
    it("is not a filter", () => {
        expect(isFiltered(view({ sort: "title", direction: "desc" }))).toBe(false);
    });
});

describe("saved filters", () => {
    const view = (over: Partial<LibraryView> = {}): LibraryView => ({
        ...DEFAULT_VIEW,
        mode: "grid",
        ...over,
    });

    it("stores what the grid would ask for, and nothing about where you are in it", () => {
        const query = viewToSavedQuery(
            view({ search: "rain", unrated: true, tags: ["a", "b"], page: 6, mode: "gallery" })
        );

        expect(query.search).toBe("rain");
        expect(query.unrated).toBe(true);
        expect(query.tags).toEqual(["a", "b"]);
        // A filter is a way of looking at the library, not a position in it, and gallery is a
        // rendering choice the query has nowhere to put.
        expect(query).not.toHaveProperty("page");
        expect(query).not.toHaveProperty("view");
    });

    it("translates the root between its two spellings and back", () => {
        const query = viewToSavedQuery(view({ root: "root-1" }));

        // `rootId` in a query, `root` in an address.
        expect(query.rootId).toBe("root-1");
        expect(savedQueryToParams(query).get("root")).toBe("root-1");
        expect(savedQueryToParams(query).get("rootId")).toBeNull();
    });

    it("round-trips a view through a saved query unchanged", () => {
        const original = view({
            search: "rain",
            kind: "video",
            root: "root-1",
            sort: "title",
            direction: "desc",
            tags: ["a", "b"],
            unrated: true,
            minRating: 3,
        });

        const reopened = openSavedFilter(original, "f1", viewToSavedQuery(original));

        // Identical but for the marker saying which filter it came from.
        expect(viewToRequestParams(reopened).toString()).toBe(
            viewToRequestParams({ ...original, filterId: "f1" }).toString()
        );
    });

    /**
     * The server decides whether a shared filter resolves against its owner's ratings (§6), and
     * cannot without knowing which filter this is. Stripped, the grid ran it against the
     * viewer's ratings while the home shelf ran the same filter against the owner's.
     */
    it("sends the filter a view was opened from, and keeps it out of the saved query", () => {
        const opened = openSavedFilter(view(), "f1", viewToSavedQuery(view({ minRating: 4 })));

        expect(viewToRequestParams(opened).get("filter")).toBe("f1");
        expect(viewToSavedQuery(opened)).not.toHaveProperty("filter");
        expect(matchesSavedQuery(opened, viewToSavedQuery(view({ minRating: 4 })))).toBe(true);
    });

    it("marks the view as belonging to the filter, and starts at its first page", () => {
        const opened = openSavedFilter(view({ page: 9 }), "f1", viewToSavedQuery(view()));

        expect(opened.filterId).toBe("f1");
        // Page 9 of the view you left says nothing about the filter you opened.
        expect(opened.page).toBe(0);
    });

    it("keeps the gallery when opened from the gallery, and leaves the room", () => {
        const savedQuery = viewToSavedQuery(view());

        expect(openSavedFilter(view({ mode: "gallery" }), "f1", savedQuery).mode).toBe("gallery");
        // The room is not a way of showing a filtered set, so opening one has to leave it.
        expect(openSavedFilter(view({ mode: "room" }), "f1", savedQuery).mode).toBe("grid");
    });

    it("does not count paging or the layout as editing the filter", () => {
        const saved = view({ unrated: true });
        const query = viewToSavedQuery(saved);

        expect(matchesSavedQuery(saved, query)).toBe(true);
        expect(matchesSavedQuery({ ...saved, page: 4 }, query)).toBe(true);
        expect(matchesSavedQuery({ ...saved, mode: "gallery" }, query)).toBe(true);
        expect(matchesSavedQuery({ ...saved, filterId: "f1" }, query)).toBe(true);
    });

    it("saves a shuffle as a shuffle, not the seed it was showing", () => {
        const shuffled = view({ sort: "random", seed: 7 });
        const query = viewToSavedQuery(shuffled);

        expect(query).not.toHaveProperty("seed");
        // Neither the seed dealt on arrival nor a reshuffle is an edit to the filter.
        expect(matchesSavedQuery({ ...shuffled, seed: 42 }, query)).toBe(true);
    });

    it("deals a new shuffle for a filter saved with a seed before seeds were dropped", () => {
        const query = { ...viewToSavedQuery(view({ sort: "random" })), seed: 7 };
        const opened = openSavedFilter(view(), "f1", query);

        expect(opened.seed).toBeNull();
        expect(needsShuffleSeed(opened)).toBe(true);
        expect(matchesSavedQuery({ ...opened, seed: 42 }, query)).toBe(true);
    });

    it("does count a changed predicate or sort as editing the filter", () => {
        const saved = view({ unrated: true });
        const query = viewToSavedQuery(saved);

        expect(matchesSavedQuery({ ...saved, unrated: false }, query)).toBe(false);
        expect(matchesSavedQuery({ ...saved, search: "rain" }, query)).toBe(false);
        expect(matchesSavedQuery(withSort(saved, "title"), query)).toBe(false);
    });
});

/**
 * Leaving a saved view (§14b).
 *
 * The bug this pins was reported from the screen: with a view open, clearing the filters left
 * the view's name in the address and in the title and reported the result as "Edited" — the
 * app claiming an edit where what had happened was a departure, and with no way back to the
 * plain library short of retyping the URL.
 *
 * A view *is* its query. An unfiltered grid is therefore not a view of anything, and the
 * rule has to hold whichever way the filters were emptied: "clear all" at once, or the last
 * chip removed one at a time.
 */
describe("leaving a saved view", () => {
    const onFilter = (): LibraryView => ({
        ...DEFAULT_VIEW,
        mode: "grid",
        filterId: "f1",
        tags: ["beach"],
        favorite: true,
    });

    it("clearing the filters leaves the view", () => {
        const cleared = clearFilters(onFilter());

        expect(cleared.filterId).toBeNull();
        expect(isFiltered(cleared)).toBe(false);
    });

    it("removing the last filter one at a time leaves it too", () => {
        const stillFiltered = leaveViewIfEmpty({ ...onFilter(), favorite: false });

        // One chip left, so the view is genuinely still being looked at -- and edited.
        expect(stillFiltered.filterId).toBe("f1");

        const emptied = leaveViewIfEmpty({ ...stillFiltered, tags: [] });

        expect(emptied.filterId).toBeNull();
    });

    /** Paging and switching to the gallery are not departures. */
    it("does not leave over a change that hides nothing", () => {
        expect(leaveViewIfEmpty({ ...onFilter(), page: 4, mode: "gallery" }).filterId).toBe("f1");
    });

    it("closing gives back the whole library, not an unnamed filter", () => {
        const closed = closeSavedFilter(onFilter());

        expect(closed.filterId).toBeNull();
        expect(closed.tags).toEqual([]);
        expect(closed.favorite).toBe(false);
        expect(isFiltered(closed)).toBe(false);
    });

    it("closing a view resets its kind, where clearing would keep it", () => {
        const closed = closeSavedFilter({ ...onFilter(), kind: "image" });

        expect(closed.kind).toBe("video");
    });

    /** The library a view was opened inside is where closing it leaves you. */
    it("keeps the root and the sort", () => {
        const closed = closeSavedFilter({ ...onFilter(), root: "r1", sort: "rating" });

        expect(closed.root).toBe("r1");
        expect(closed.sort).toBe("rating");
    });
});

/** §5d "Find untagged": the tag page's way into the grid. */
describe("finding what names a tag but does not carry it", () => {
    it("opens the grid looking for mentions of the tag, without the tag", () => {
        const href = untaggedMentionsHref("t1");
        const opened = parseView(new URLSearchParams(href.slice(2)));

        expect(opened).toMatchObject({ mode: "grid", mentions: "t1", notTags: ["t1"] });
    });

    it("is a filter, is cleared with the rest, and survives being saved", () => {
        const found = view({ mode: "grid", mentions: "t1", notTags: ["t1"] });

        expect(isFiltered(found)).toBe(true);
        expect(clearFilters(found).mentions).toBeNull();
        expect(matchesSavedQuery(found, viewToSavedQuery(found))).toBe(true);
        expect(savedQueryToParams(viewToSavedQuery(found)).get("mentions")).toBe("t1");
    });
});

describe("a look in the address (§5e)", () => {
    const grid = { ...DEFAULT_VIEW, mode: "grid" as const };

    it("round-trips words and a moment", () => {
        const words = withLook(grid, { lookText: "  neon at night " });
        const moment = withLook(grid, { like: "abc-1@4500" });

        expect(parseView(viewToParams(words))).toEqual(words);
        expect(parseView(viewToParams(moment))).toEqual(moment);
        expect(words.lookText).toBe("neon at night");
    });

    it("asks one way at a time, keeping the moment from an address that carries both", () => {
        expect(withLook(withLook(grid, { lookText: "neon" }), { like: "abc" })).toMatchObject({
            lookText: "",
            like: "abc",
        });
        expect(parseView(new URLSearchParams("lookText=neon&like=abc@10"))).toMatchObject({
            lookText: "",
            like: "abc@10",
        });
    });

    it("drops a moment the server would refuse", () => {
        expect(parseView(new URLSearchParams("like=../x")).like).toBe("");
    });

    it("orders by the look, and falls back when the look is gone", () => {
        expect(effectiveSort(withLook({ ...grid, sort: "title" }, { lookText: "neon" }))).toBe(
            "look"
        );
        expect(effectiveSort({ ...grid, sort: "look" })).toBe("addedAt");
    });

    it("is a filter, and clearing the filters clears it", () => {
        const looking = withLook(grid, { lookText: "neon" });

        expect(hasLook(looking)).toBe(true);
        expect(isFiltered(looking)).toBe(true);
        expect(hasLook(clearFilters(looking))).toBe(false);
    });

    it("is not an edit to the saved filter it is looked for within", () => {
        const opened = openSavedFilter(grid, "f1", { kind: "video", sort: "addedAt" } as never);

        expect(
            matchesSavedQuery(withLook(opened, { lookText: "neon" }), viewToSavedQuery(opened))
        ).toBe(true);
    });
});
