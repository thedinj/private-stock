import type { ReviewMedia } from "@private-stock/core";

/**
 * Every TanStack Query cache key, declared once.
 *
 * **Query keys are an exact vocabulary.** `invalidateQueries({ queryKey: K })` refreshes a
 * query only when `K` is a *prefix* of that query's key, compared element by element. A key
 * that is hand-written at two call sites and spelled differently at one of them does not
 * fail — it silently refreshes nothing, and the symptom arrives later as data that is simply
 * out of date. Built through this object, a mistake is a compile error instead.
 *
 * This is not borrowed caution. Two bugs of exactly that shape were already here:
 *
 *  - Adding, enabling or renaming a library invalidated `["admin", "scan"]` — the table on
 *    the administration page — and never `["library", "roots"]`, which is what the sidebar,
 *    the room and the cellar read. A library did not appear until the page was reloaded,
 *    which reads as the library not having been added.
 *  - The viewer and the grid page the same list, and their keys were kept identical by a
 *    comment in each file saying so. They agreed; nothing made them agree.
 *
 * The convention is `../basket-bot`'s (`apps/mobile/src/db/queryKeys.ts`), which arrived at
 * it after stale-data bugs became its most-churned file. `docs/CACHE_KEYS.md` here is the
 * registry: what each cache holds and which mutations must reach it.
 *
 * **Builders that take an argument also expose the broader prefix** (`media.all()`,
 * `media.list()`), so a mutation can invalidate a whole namespace deliberately rather than
 * by relying on a key's first element happening to be right.
 *
 * Keys are plain arrays rather than `readonly`, so they stay assignable to TanStack's
 * `QueryKey` and to the `PageQuery` shape the viewer builds.
 */

/** A filter, already serialised. The *string* is the identity — never a `URLSearchParams`. */
type FilterParams = string;

export const queryKeys = {
    // --- Administration ---
    admin: {
        /** Libraries, their counts and whether a scan is running. The admin page's table. */
        scan: () => ["admin", "scan"],
        settings: () => ["admin", "settings"],
        processing: () => ["admin", "processing"],
        /**
         * Standing failures, a cursor's worth of pages per kind filter (§13c). Under
         * `processing()` so everything that causes work -- and so may settle a failure --
         * reaches it through `invalidateProcessing`.
         */
        failedJobs: (kind: string) => ["admin", "processing", "failed", kind],
        /** The transcode queue's depth (§8), under `processing()` for the same reason. */
        transcodeQueue: () => ["admin", "processing", "transcode"],
        /** The playback check's test set (§8): unplayable videos by kind, with samples. */
        playbackCheck: () => ["admin", "playbackCheck"],
        /**
         * Files the probe cannot read (§10g), one cache per tab under one prefix.
         *
         * Trashing, restoring and purging all move rows between the tabs or off both, so every
         * such stroke reaches `unreadable()` through `invalidateListable`.
         */
        unreadable: () => ["admin", "unreadable"],
        unreadablePage: (tab: string) => ["admin", "unreadable", tab],
        /**
         * Who can reach the library, and the invitations that let them (§12c).
         *
         * Two caches under one prefix because they move together: using an invitation creates
         * an account, so the accounts table and the invitations table are never separately
         * stale. `access()` is the prefix a mutation invalidates to reach both.
         */
        access: () => ["admin", "access"],
        users: () => ["admin", "access", "users"],
        invitations: () => ["admin", "access", "invitations"],
    },

    // --- The library, as a reader sees it ---
    library: {
        /** Enabled roots, ordered by name: the sidebar, the room and the cellar's switcher. */
        roots: () => ["library", "roots"],
        stats: () => ["library", "stats"],
    },

    /**
     * The directory picker, which is about the filesystem rather than about a library.
     *
     * Its literals are hyphenated and top-level (`["library-browse", …]`) rather than nested
     * under `library`, and they stay that way: a key's value is its identity, and renaming
     * one during a refactor is how the caches it was supposed to join quietly separate.
     */
    paths: {
        /** Undefined is the root listing, and is part of the key rather than a special case. */
        browse: (directory: string | undefined) => ["library-browse", directory],
        inspect: (directory: string, excludeId: string | undefined) => [
            "library-inspect",
            directory,
            excludeId,
        ],
    },

    // --- Media ---
    media: {
        /**
         * Every media cache: detail, pages, counts and facets.
         *
         * The broad stroke, and it is the right one after a rating or a tag: those are
         * membership tests as well as properties, so the page an item belongs on can change.
         * `invalidateQueries` refetches only *mounted* queries and marks the rest stale, so
         * this costs one refetch rather than one per cached page.
         */
        all: () => ["media"],
        detail: (mediaId: string) => ["media", mediaId],
        /**
         * People in this item (§5f): under the item's detail, so whatever refreshes the item —
         * a tag edit above all — refreshes who is said to be in it.
         */
        people: (mediaId: string) => ["media", mediaId, "people"],
        transcode: (mediaId: string) => ["media", mediaId, "transcode"],
        /** Its other copies, for the delete confirmation (§10d). Under the detail, so the
            `media.all()` every trash invalidates reaches it. */
        copies: (mediaId: string) => ["media", mediaId, "copies"],
        /** Every page of every filter. */
        list: () => ["media", "list"],
        /**
         * One page of one filter — shared by the grid and by the viewer's prefetch, which is
         * the point: they are the same request, so they must be the same cache entry.
         */
        page: (filter: FilterParams, page: number) => ["media", "list", filter, page],
        /**
         * One page of one filter as ids alone — the viewer's walk through the set (§14b).
         *
         * Not under `list()`: the live feed patches every entry there as a page of tiles, and
         * this is a different shape. Under `media.all()`, so a rating or a vocabulary change
         * reaches it like any other page.
         */
        idsPage: (filter: FilterParams, page: number) => ["media", "ids", filter, page],
        /** Every up-next lookup, for reading back the tiles they already hold. */
        lookups: () => ["media", "lookup"],
        /** A few items by id, as tiles — the viewer's up-next strip. `ids` comma-joined. */
        lookup: (ids: string) => ["media", "lookup", ids],
        count: (filter: FilterParams) => ["media", "count", filter],
        facets: () => ["media", "facets"],
        /**
         * The filter panel's tags. Not keyed by the filter: the numbers are library-wide (§20
         * "Facets without counts"), so the key is only the filter's tag ids, plus an expanded
         * facet and its search in the "show all" list.
         */
        facetsFor: (params: string) => ["media", "facets", params],
        /**
         * The Captures page (§9): this viewer's own stills of listable items.
         *
         * Under `media` rather than a namespace of its own because the page is filtered on
         * `listable`, so trashing, restoring, purging and merging an item all change it — and
         * every one of those already invalidates `media.all()`. Deliberately *not* under
         * `list()`: the live feed patches every entry under that prefix as a page of grid
         * tiles, and a page of captures is a different shape.
         */
        captures: () => ["media", "captures"],
        capturesPage: (params: FilterParams, page: number) => ["media", "captures", params, page],
    },

    tags: {
        /**
         * Everything about the vocabulary, for the one stroke a tag edit needs.
         *
         * A rename, a merge, a delete and a scope change each move the suggestion lists, the
         * management table and the batch history at once, and there was no prefix that reached
         * them -- `byKind` was the only key, so `["tags"]` was not expressible through the
         * factory at all and a mutation could only invalidate the one facet it happened to
         * know about.
         */
        all: () => ["tags"],
        // Scoped as well as keyed by facet: the two tag boxes suggest from different
        // vocabularies, and one entry for both would offer public names in the private box
        // (§6).
        byKind: (kind: string, scope: string) => ["tags", "facet", kind, scope],
        /**
         * What a tag box is offered for what was typed (§5b "One rule for names").
         *
         * Under `byKind`'s key, so everything that refreshes a facet's suggestions -- a removal
         * that may retire a tag, a vocabulary change -- reaches what was typed into its box too.
         */
        search: (kind: string, scope: string, typed: string) => [
            "tags",
            "facet",
            kind,
            scope,
            "search",
            typed,
        ],
        /**
         * What a ticked selection carries, keyed by the ids themselves.
         *
         * Under `tags` rather than `media` so a vocabulary change reaches it: a rename moves
         * the names in this list, and `invalidateVocabulary` is the one stroke that says so.
         * The caller sorts the ids before joining them, so re-ticking the same set in a
         * different order is a cache hit rather than a second count.
         */
        selection: (mediaIds: string) => ["tags", "selection", mediaIds],
        /**
         * What a filter's tag ids are called, keyed by the ids, sorted and comma-joined. Under
         * `tags` so a rename reaches it through `invalidateVocabulary`.
         */
        names: (tagIds: string) => ["tags", "names", tagIds],
        /** The management table: one facet of one system, paged, searched, filtered. */
        list: (scope: string, params: string) => ["tags", "list", scope, params],
        /**
         * Which facets have a tag in them. Under `tags` so a move between facets, or the
         * delete that empties one, reaches it through `invalidateVocabulary`.
         */
        kinds: () => ["tags", "kinds"],
        /** Bulk applies this viewer may withdraw. */
        batches: () => ["tags", "batches"],
        /** Every browse list at once: a favourite moves a row in and out of the filtered ones. */
        browseAll: () => ["tags", "browse"],
        /**
         * A browse page's infinite list: one facet, one system, searched and sorted, with the
         * seed that picked its filmstrips. Under `tags` so every vocabulary change and every
         * tagging reaches it -- a count or a strip moves with either.
         */
        browse: (kind: string, scope: string, params: string) => [
            "tags",
            "browse",
            kind,
            scope,
            params,
        ],
        /** One tag's page. The seed is part of it: it chose the picture and the shuffled shelf. */
        profile: (tagId: string, seed: number) => ["tags", "profile", tagId, seed],
        /** One tag's page under every seed, for a change that does not depend on the picture. */
        profileOf: (tagId: string) => ["tags", "profile", tagId],
        /**
         * Every "appears with" section, for the strokes that change what can be listed at all:
         * a trashed item leaves its companions' counts and strips (`invalidateListable`).
         */
        companionsAll: () => ["tags", "companions"],
        /**
         * One tag's "appears with", asked for after its page has drawn. The seed chose the
         * strips. Not under `profileOf`: the favourite write-in patches every entry there as a
         * `TagProfile`, and this is a different shape. Under `tags`, so every vocabulary change
         * and every tagging reaches it -- a name, a count or a strip moves with either.
         */
        companions: (tagId: string, seed: number) => ["tags", "companions", tagId, seed],
        /**
         * Prefix over a library performer's face caches — their picture's confirmed faces — for
         * whatever moves their faces to reach (§5f).
         */
        faces: (tagId: string) => ["tags", "faces", tagId],
        /**
         * Every face confirmed as a performer, every page loaded: what their picture is chosen
         * from (§6). Under `faces(tagId)`, so whatever moves their faces moves this.
         */
        confirmedFaces: (tagId: string) => ["tags", "faces", tagId, "confirmed"],
        /**
         * Their face from a few of their items, for "Look" beside one that may be them (§5f).
         * Under `faces(tagId)`; one entry a performer, so a page of their cards asks once.
         */
        faceComparison: (tagId: string) => ["tags", "faces", tagId, "comparison"],
        /**
         * "Would tag" (§5f). Under `tags`, so every tagging and vocabulary change reaches it. Not
         * Suggestions, New people or a performer's Faces tab, which hold still: `faceReview`.
         */
        faceReviewAll: () => ["tags", "faceReview"],
        /** "Would tag" (§5f "Tagging by itself"): one state of it, in a visit's random order. */
        autoTags: (state: string, seed: number) => ["tags", "faceReview", "auto", state, seed],
    },

    /**
     * Review › Faces' lists (§5f "A list that holds still"). **Not under `tags`**: a list is made
     * once a visit and only ever changes when somebody asks — a decision settles its own row in
     * place, and no tag edit anywhere re-reads or re-sorts it under the person working through it.
     */
    /**
     * History (§5f "Decisions you can take back"): face decisions newest first, everybody's or by
     * who made them, and of one performer if given. Its own root: decisions are made everywhere,
     * so it is asked for again whenever it is opened rather than reached by each of them.
     */
    faceHistory: {
        all: () => ["faceHistory"],
        list: (actor: "all" | "user" | "app", tagId: string | null) => [
            "faceHistory",
            actor,
            tagId,
        ],
    },

    /**
     * The frames a video's face may really be, and the one its sprite tile looks like (§9 "What a
     * tile shows"). Its own root, reached by nothing: it is read from the file and the sheets,
     * which no mutation here changes.
     */
    faceMoments: (mediaId: string, atMs: number) => ["faceMoments", mediaId, atMs],

    faceReview: {
        /**
         * Suggestions' performers, with how many each (§5f "Suggestions"). Asked for again whenever
         * it is shown: a decision on a performer's page changes their count.
         */
        suggestionPeople: (media: ReviewMedia) => ["faceReview", "suggestionPeople", media],
        /**
         * One section of a performer's Faces tab (§5f "Their faces"), every page loaded; holds
         * still until a new `visit`.
         */
        performerPeople: (
            tagId: string,
            section: "confirmed" | "items" | "ruledOut",
            all: boolean,
            visit: number
        ) => ["faceReview", "performerPeople", tagId, section, all, visit],
        /** New people (§5f), every page loaded; holds still until a new `visit`. */
        newPeople: (visit: number) => ["faceReview", "newPeople", visit],
        /** One performer's suggestions, every page loaded; holds still until a new `visit`. */
        suggestions: (tagId: string, media: ReviewMedia, visit: number) => [
            "faceReview",
            "suggestions",
            tagId,
            media,
            visit,
        ],
    },

    // --- Collections ---
    playlists: {
        all: () => ["playlists"],
        detail: (playlistId: string) => ["playlists", playlistId],
        /** A page of a playlist's items. `seed` is part of the identity: it is the shuffle. */
        itemsPage: (playlistId: string, page: number, seed: number | null) => [
            "playlists",
            playlistId,
            "items",
            page,
            seed,
        ],
    },
    /**
     * Reels (§14d). An index that is paged and sorted, so the list key carries its query.
     *
     * `items` has no page in it, unlike a playlist's: a reel is read whole, because it is played
     * in one pass and the player must never ask a second question part way through.
     */
    reels: {
        all: () => ["reels"],
        list: (params: FilterParams, page: number) => ["reels", "list", params, page],
        detail: (reelId: string) => ["reels", reelId],
        items: (reelId: string) => ["reels", reelId, "items"],
    },
    /**
     * The clip browser only.
     *
     * An item's own clips ride `media.detail(id)`, as its frames do, so there is no second cache
     * holding the same rows and nothing to keep in step with it.
     */
    clips: {
        all: () => ["clips"],
        list: (params: FilterParams, page: number) => ["clips", "list", params, page],
        /** One clip and the reels holding it, read by the retime and discard dialogues. */
        detail: (clipId: string) => ["clips", clipId],
        labels: () => ["clips", "labels"],
        /** The chips for the browser's "Video has" and "Clip has" fields (§14d). */
        tagFacets: () => ["clips", "tags"],
    },
    savedFilters: () => ["filters"],
    /**
     * One saved view's face (§14c). Under `filters` so every edit to a view -- which
     * invalidates the list -- redraws the faces too, a changed query included.
     */
    savedFilterCovers: (filterId: string) => ["filters", "covers", filterId],
    home: () => ["home"],
    /** Which build the server is running — compared with the page's own (`useBuildCheck`). */
    build: () => ["build"],

    // --- Housekeeping ---
    /**
     * OCR (§5d). `all()` is what every review action reaches: correcting one string can move
     * findings between strings and change which items each names, and an accept tags items in
     * every list at once, so nothing narrower is safe.
     */
    ocr: {
        all: () => ["ocr"],
        /**
         * Items whose text names somebody nobody has decided about, newest first: every choice
         * of the kind control, for what a decision reaches.
         */
        queue: () => ["ocr", "queue"],
        /** The queue under one choice of the kind control: what To tag shows. */
        queueOf: (media: ReviewMedia) => ["ocr", "queue", media],
        /** Tags accepted pairs applied by themselves, newest first. */
        ruleTags: () => ["ocr", "ruleTags"],
        /** Strings with a decided pair: the Rules list (§5d). */
        matches: (params: FilterParams) => ["ocr", "matches", params],
        /** The items one matched string was read on, with the candidate tags each carries. */
        matchItems: (textNorm: string, params: FilterParams) => [
            "ocr",
            "matchItems",
            textNorm,
            params,
        ],
        counts: () => ["ocr", "counts"],
        /** How OCR reads, and how much of the library predates the current settings. */
        settings: () => ["ocr", "settings"],
        /** The test bench: the nominated videos and their latest comparison. */
        bench: () => ["ocr", "bench"],
        /** The latest tuning run, polled while it goes. */
        tune: () => ["ocr", "tune"],
        /**
         * What a run would read. Keyed to the latest run's state, so a run finishing — which
         * fills the cache — is a different key, and the estimate is asked for again.
         */
        tuneEstimate: (runState: string) => ["ocr", "tuneEstimate", runState],
        /** Every estimate, whatever run it was keyed to: what changing expected text reaches. */
        tuneEstimates: () => ["ocr", "tuneEstimate"],
    },

    dupes: {
        all: () => ["dupes"],
        page: (params: string) => ["dupes", params],
        /**
         * The tab counts under one choice of the kind control: pending of each kind, and
         * reviewed. The review nav reads the Videos one, which the page opens on.
         */
        counts: (media: ReviewMedia) => ["dupes", "counts", media],
        /** One page of identical groups, routine or needing a look, with the run's summary. */
        identical: (params: string) => ["dupes", "identical", params],
        /** One page of the sortings that kept look-alikes apart, to take back (§10i). */
        apart: (params: string) => ["dupes", "apart", params],
    },
    /**
     * A video's sprite track, parsed into cues (§9). Keyed by the track's URL, which carries a
     * version token, so a rebuilt sprite is a different key and nothing ever invalidates this.
     */
    spriteCues: (vttUrl: string) => ["spriteCues", vttUrl],
    /** Every page of the bin: what restoring, purging and deleting reach. */
    trash: () => ["trash"],
    /** One page of the bin, zero-based. */
    trashPage: (page: number) => ["trash", page],
};
