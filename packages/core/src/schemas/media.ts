import { z } from "zod";

import { clipSchema, spriteRectSchema } from "./clips.js";

import { mediaKindSchema, sortDirectionSchema, type SortDirection } from "../domain.js";
import { filterGroupsSchema, findsUntagged, type FilterGroup } from "./filterLogic.js";
import { ocrReviewStateSchema } from "./ocr.js";
import { mediaTagSchema, tagIdListSchema } from "./tags.js";

/**
 * Library query and response contracts.
 *
 * The query schema is also what the grid encodes into the URL, so filter state is
 * shareable and the back button behaves (§14). Keeping one schema for both means the
 * server cannot accept a filter the UI cannot express, or vice versa.
 */

export const mediaSortSchema = z.enum([
    "addedAt",
    "capturedAt",
    "title",
    "duration",
    "size",
    /** The short side, as the resolution filter reads it: portrait 1080×1920 is 1080p. */
    "resolution",
    "bitrate",
    "fps",
    /** The viewer's own, never a shared filter's owner's: when *you* last opened it. */
    "lastViewed",
    "rating",
    "random",
    /**
     * BM25 relevance. Only meaningful alongside `search` -- with no text to rank against,
     * every row scores identically and the order is arbitrary, so the service falls back to
     * `addedAt` rather than returning a shuffled-looking library.
     */
    "relevance",
    /**
     * How closely each item matches the look asked for (§5e "Search runs in two passes"), best
     * first. Only with `lookText` or `like`, and every query with one is ordered so
     * (`sortOverride`): a look is an ordering of a few hundred items, and the rest of the library
     * in date order behind them would be the library, not the look.
     */
    "look",
]);
export type MediaSort = z.infer<typeof mediaSortSchema>;

/**
 * Which way round each sort reads when nobody has said.
 *
 * A single default of `desc` for everything is what made picking "Title" list the library
 * from Z to A — technically the documented default, and wrong in the only way a default can
 * be: it made the obvious choice produce the surprising result.
 *
 * Written out per sort rather than derived from a rule about column types. The intuitive end
 * is a fact about what the field *means*, not about whether it happens to be text or a
 * number, and a rule would quietly assign one to the next sort added instead of making
 * somebody choose. Exhaustive by type, so adding a sort without deciding is a compile error.
 *
 * This lives beside the schema because it is a property of the sort rather than of any one
 * screen: the grid, a saved filter and a home shelf must agree about what "sort by title"
 * means, and a default written in three places is one that eventually differs in three.
 */
const NATURAL_DIRECTION: Record<MediaSort, SortDirection> = {
    /** Newest first — the reason someone sorts by when it arrived is to see what just did. */
    addedAt: "desc",
    /** Newest first, as with any timeline of photographs. */
    capturedAt: "desc",
    /** A–Z. The one everybody has an instinct about, and the one that used to be backwards. */
    title: "asc",
    /** Longest first: the feature is more likely what is being looked for than the clip. */
    duration: "desc",
    /** Largest first, because sorting by size is nearly always about finding the big ones. */
    size: "desc",
    /** Sharpest first: sorting by resolution is looking for the 4K, not the 360p. */
    resolution: "desc",
    /** Highest first, for the same reason; lowest first is the weeding view. */
    bitrate: "desc",
    /** Smoothest first. */
    fps: "desc",
    /** Most recent first: "what was I watching". */
    lastViewed: "desc",
    /** Best first. Nobody opens a library to be shown their one-star items. */
    rating: "desc",
    /** No order to reverse; present so the map stays exhaustive. */
    random: "desc",
    /** Best match first, and the far end is not offered — see `sortHasDirection`. */
    relevance: "desc",
    /** Best match first; the far end is not offered either. */
    look: "desc",
};

export const naturalDirection = (sort: MediaSort): SortDirection => NATURAL_DIRECTION[sort];

/**
 * Whether reversing this sort means anything.
 *
 * `random` has no order to reverse — a permutation read backwards is just another
 * permutation, and the control would be a button that reshuffles while claiming not to.
 * `relevance` has one, but its other end is "worst match first", which is not a thing anyone
 * wants and would quietly turn a search into a list of everything it did not mean.
 *
 * Returned as data rather than left to the view, so the API and the UI cannot disagree about
 * whether a direction was honoured.
 */
export const sortHasDirection = (sort: MediaSort): boolean =>
    sort !== "random" && sort !== "relevance" && sort !== "look";

/**
 * "More like this" from a moment: an item's id, and where in it for a video (§5e "Search runs in
 * two passes").
 *
 * One parameter, `<id>@<ms>`, so the address stays one readable term and an item and its
 * moment cannot be given apart. No time means the item as a whole — a photograph, or a video
 * asked about from its tile rather than from a frame of it.
 *
 * Kept as the string in the query, and read by `parseLookFrame` where it is used, so that a
 * parsed query still writes back into the address it came from.
 */
const LOOK_FRAME = /^([\w-]{1,64})(?:@(\d{1,10}))?$/;

export interface LookFrame {
    mediaId: string;
    atMs: number | null;
}

export const parseLookFrame = (like: string): LookFrame => {
    const [, mediaId, at] = LOOK_FRAME.exec(like) ?? [];

    return { mediaId: mediaId ?? like, atMs: at === undefined ? null : Number(at) };
};

export const mediaQuerySchema = z.object({
    kind: mediaKindSchema.optional(),
    rootId: z.string().optional(),
    search: z.string().trim().max(200).optional(),
    /**
     * Tag ids, ANDed together: "with all of".
     *
     * Ids rather than names because the filter panel already has them, and because names are
     * ambiguous across facets -- a studio and a series can legitimately share one.
     *
     * Accepts a comma-separated string as well as a repeated parameter, since this is what
     * the grid puts in the URL and a URL has to stay readable and hand-editable (§14).
     */
    tags: tagIdListSchema.optional(),
    /**
     * Tag ids none of which may be on the item: the filter panel's "without" chips (§14e).
     *
     * Flat beside `tags` rather than a `none` group, because the panel sets one on every
     * excluded chip and a group per click would be noise in the address. Comma-separated, the
     * same spelling.
     */
    notTags: tagIdListSchema.optional(),
    /**
     * A tag id: items whose text names it -- its name or an alias, in a filename, title or any
     * other indexed text (§5d "Find untagged").
     *
     * Paired with `notTags` of the same id by the tag page, which makes it the list of files
     * that say a name and are not yet filed under it. Not the search box: a tag's names are
     * alternatives, and the box ANDs whatever is typed.
     */
    mentions: z.string().trim().min(1).max(64).optional(),
    /**
     * A look in words: "neon at night", "glasses" (§5e "Search runs in two passes").
     *
     * Not the search box. The box finds what an item is called or tagged; this orders the
     * library by what it looks like, and a query carrying one is the few hundred items that look
     * most like it, best first, whatever else narrows them.
     */
    lookText: z.string().trim().min(1).max(200).optional(),
    /**
     * A look given as a moment of an item: "more like this" (§5e "Search runs in two passes").
     *
     * One look per query: this or `lookText`, never both. Two rankings do not intersect into
     * anything meaningful, and the panel that asks for one offers one or the other.
     */
    like: z.string().trim().regex(LOOK_FRAME).optional(),
    /**
     * Any, all or none of a list of rules, each group ANDed with everything else (§14e).
     *
     * The facet sections' "any of" mode and Favourites chip, and the Advanced editor, all
     * write here; see `filterLogic.ts`.
     */
    groups: filterGroupsSchema.optional(),
    favorite: z.coerce.boolean().optional(),
    unrated: z.coerce.boolean().optional(),
    /**
     * Watched, unwatched, or don't care (§14b).
     *
     * Three states, so an enum rather than the boolean the flags above use: `z.coerce.boolean`
     * reads the string "false" as `true`, which is harmless for a flag only ever sent when
     * set and silently wrong for one that has to say "no".
     *
     * **Always the viewer's own**, never an overlay's — the same rule `hidden` follows. What
     * somebody has watched is their history rather than a judgement about the item, and a
     * shared filter resolving it against its owner would both mislead and disclose. "Dad's
     * five stars that I have not seen" reads as the viewer's `unwatched` applied on top of
     * Dad's filter, which is exactly what §6 says about the equivalent request for ratings.
     */
    watched: z.enum(["yes", "no"]).optional(),
    /**
     * Only videos whose original `assessPlayback` says a browser cannot play (§8).
     *
     * Not in the filter panel: an admin reaches it from Processing › Transcoding, to try those
     * files on real devices. The verdict is about the original, so an item with a finished
     * rendition still matches.
     */
    playback: z.enum(["blocked"]).optional(),
    minRating: z.coerce.number().int().min(1).max(5).optional(),
    /**
     * The top of a rating band, so "three stars or less" is askable (§14e).
     *
     * Viewer-relative exactly as `minRating` is, and listed alongside it in
     * `isViewerRelative` — a shared filter asking about ratings has to be recognised as one
     * whichever end of the band it names.
     */
    maxRating: z.coerce.number().int().min(1).max(5).optional(),

    /**
     * Measurable properties of the file, as half-open ranges (§14e).
     *
     * Min inclusive, max exclusive, so the named bands in `ranges.ts` are adjacent rather
     * than overlapping. Inclusive on both ends would put every boundary value in two bands at
     * once — a 1080-pixel-high video counted under both "720p" and "1080p" — which surfaces
     * as counts that do not add up rather than as anything that looks like a bug.
     *
     * Units are the URL's rather than the column's, and the names say which. `?minDurationSec=60`
     * is hand-editable; `60000` is a thing people get wrong. The conversion happens in the one
     * place that builds SQL (§14).
     *
     * Every one of these is `undefined` when absent rather than null, so an omitted bound and
     * a bound of zero stay distinguishable — "at least 0 seconds" is a filter somebody can
     * set by dragging, and it must not be silently the same as no filter at all.
     */
    minDurationSec: z.coerce.number().min(0).optional(),
    maxDurationSec: z.coerce.number().min(0).optional(),
    minBitrateKbps: z.coerce.number().min(0).optional(),
    maxBitrateKbps: z.coerce.number().min(0).optional(),
    minFps: z.coerce.number().min(0).optional(),
    maxFps: z.coerce.number().min(0).optional(),
    /**
     * Resolution, measured as the **shorter side** of the frame.
     *
     * Rotation-independent on purpose, so "1080p" means a 1920×1080 frame however it is
     * turned. Height alone would promote every upright phone video by a tier or two — 1080×1920
     * has a height of 1920 and the pixels of 1080p — and pixel count would file a 2560×1080
     * ultrawide next to 4K. The shorter side is the scanline count the tier names come from.
     */
    minResolution: z.coerce.number().int().min(0).optional(),
    maxResolution: z.coerce.number().int().min(0).optional(),
    minSizeMb: z.coerce.number().min(0).optional(),
    maxSizeMb: z.coerce.number().min(0).optional(),

    /**
     * Which way up the picture is.
     *
     * An enum rather than an aspect-ratio range, because the three answers are the whole
     * question and a ratio would need a tolerance — and a tolerance is a rule nobody can see,
     * which makes "square" mean something slightly different from what the word says. Square
     * here is exactly square; a 1.01:1 image is landscape, and that is at least predictable.
     */
    orientation: z.enum(["landscape", "portrait", "square"]).optional(),

    /**
     * Whether the picture moves (§14e).
     *
     * Three-state like `watched` rather than a boolean, for the same reason: `z.coerce.boolean`
     * reads the string "false" as `true`, which is harmless for a flag only ever sent when set
     * and silently wrong for one that has to be able to say "no". "Stills only" is the half of
     * this that gets used — an animated GIF in a library of photographs is neither.
     *
     * Images only. A video is not "an animated image", and answering `no` for every video
     * would make "stills only" return the entire film collection.
     */
    animated: z.enum(["yes", "no"]).optional(),

    sort: mediaSortSchema.default("addedAt"),
    /**
     * Optional rather than defaulted, because the sensible default depends on the sort.
     *
     * A zod default cannot read a sibling field, and a `.transform` that resolved it here
     * would stop this being a `ZodObject` -- which `savedQuerySchema` needs, since it builds
     * on this with `.omit()`. So the fallback is applied by the one place that reads it, via
     * `naturalDirection`. Absent means "whichever way round this sort naturally reads", not
     * "descending".
     */
    direction: sortDirectionSchema.optional(),
    /**
     * Seed for `sort: "random"`. Held in the URL so paging through a shuffled library stays
     * stable — without it, every page request reshuffles and items repeat or vanish.
     */
    seed: z.coerce.number().int().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(60),
    /**
     * Zero-based page number.
     *
     * Numbered pages rather than an endless scroll, which is a deliberate trade of a little
     * polish for a lot of robustness (§20). A page is a plain URL that can be shared,
     * reloaded and bookmarked; the back button lands where it should; nothing accumulates in
     * the browser as you go; and there is no scroll position to restore or lose.
     *
     * It replaced a keyset cursor. The cursor was the faster mechanism in principle, but it
     * can only step forward one page at a time -- there is no cursor for page 40 without
     * walking to it -- so it cannot express "jump to page 40" at all. Measured on the
     * indexed shape, an offset costs 0.1 ms at page 1, 4.8 ms at page 100 and 184 ms at the
     * very last page of a 200k library, which buys direct addressing cheaply.
     */
    page: z.coerce.number().int().min(0).default(0),
});
export type MediaQuery = z.infer<typeof mediaQuerySchema>;

/**
 * The order a "find untagged" list is shown in, whatever sort was asked for (§14b, §20).
 *
 * Working through "no performer yet" is a walk of one item after another, tagging each out of
 * the set, and every step asks for the page it stands on again. A shuffle -- or any order no
 * index serves for that filter -- sorts every matching item to answer each of those asks: on the
 * production replica 538 pages a step for untagged videos shuffled, against 144 newest first,
 * and size, duration and resolution were worse than the shuffle. Date added is the one order
 * the listable-kind-addedAt index walks in, stopping once the page is full.
 *
 * So the server shows these lists by date added, newest first unless the filter already asked
 * for date added in either direction, and the sort control says so instead of offering choices
 * that would not be honoured. Nothing is rewritten: a saved filter keeps its stored sort, and it
 * returns the moment the filter stops being a list of untagged items.
 */
const UNTAGGED_SORT: MediaSort = "addedAt";

/** The sort a query is overridden to, or null when its own sort stands. */
/**
 * Whether a query asks for a look, in words or from a moment (§5e).
 */
export const asksForLook = (query: { lookText?: string; like?: string }): boolean =>
    query.lookText !== undefined || query.like !== undefined;

/**
 * The sort a query is overridden to, or null when its own sort stands.
 *
 * A look orders its list whatever sort it carries: the list *is* the best matches, and any other
 * order of them would hide which those were. Without one, the look order has nothing to rank by,
 * and falls back to date added as relevance does without words.
 */
export const sortOverride = (query: {
    sort: MediaSort;
    groups?: readonly FilterGroup[];
    lookText?: string;
    like?: string;
}): MediaSort | null => {
    if (asksForLook(query)) {
        return query.sort === "look" ? null : "look";
    }

    if (query.sort === "look") {
        return "addedAt";
    }

    return findsUntagged(query.groups) && query.sort !== UNTAGGED_SORT ? UNTAGGED_SORT : null;
};

/** The query as the server runs it: the override applied, a seed nothing reads dropped. */
export const withSortOverride = (query: MediaQuery): MediaQuery => {
    const sort = sortOverride(query);

    return sort === null
        ? query
        : { ...query, sort, direction: naturalDirection(sort), seed: undefined };
};

export const mediaListItemSchema = z.object({
    id: z.string(),
    kind: mediaKindSchema,
    title: z.string(),
    durationMs: z.number().nullable(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    addedAt: z.string(),
    capturedAt: z.string().nullable(),
    sizeBytes: z.number().nullable(),
    /**
     * Ready-to-use URL for this item's cover, or null until the cover job has run — the grid
     * shows a placeholder meanwhile.
     *
     * A URL rather than a stored path, for two reasons. The client has no business knowing
     * where artifacts live on disk, and the URL carries a version token so that changing an
     * item's cover actually changes what the browser displays: the endpoint is otherwise
     * identical for the life of the item, and would be served from cache forever.
     */
    coverUrl: z.string().nullable(),
    /**
     * Silent looping clip for hover and gallery mode, or null.
     *
     * Optional by design rather than by omission: a file too short to sample has no preview,
     * and the tile simply does not animate. A missing preview is never a broken tile.
     */
    previewUrl: z.string().nullable(),
    rating: z.number().nullable(),
    favorite: z.boolean(),
    /** When this viewer finished with the item, or null (§14b). */
    watchedAt: z.string().nullable(),
    /**
     * The tags on this item other than performers, as the tile's hover shows them (§14b).
     *
     * Capped server-side rather than sliced by the client: the tile draws two and then a
     * `+3`, so shipping forty names to render two of them is forty names of payload per
     * tile, sixty times a page. `tagCount` is the total the `+N` is computed from.
     */
    tags: z.array(z.object({ name: z.string(), kind: z.string() })),
    tagCount: z.number(),
    /**
     * Who is in it: the tile's byline, under the title (§14b).
     *
     * Apart from `tags` because it is always on screen while they wait for a hover -- the
     * people are what a rack is scanned for, and a keyword is not. Capped the same way, with
     * `performerCount` for the `+N`.
     */
    performers: z.array(z.string()),
    performerCount: z.number(),
    /** False while probing is outstanding, so the UI can distinguish empty from pending. */
    probed: z.boolean(),
    /**
     * Whether what will actually be served can be played by a browser without help (§8b).
     *
     * On the list rather than only the detail so a set can be played through without a round
     * trip per item -- the tasting skips a video that cannot play (§14g). Always true for an
     * image. Computed from the same inputs as the item page's verdict, so the two agree.
     */
    directPlay: z.boolean(),
});
export type MediaListItem = z.infer<typeof mediaListItemSchema>;

/**
 * Where an item matched a look, and a picture of that moment (§5e "Three ways in, one way out").
 *
 * The picture is the scrubber's sprite tile nearest the moment, as a clip's face is (§14d): the
 * match is the evidence, and the cover of a twenty-minute video rarely shows the glasses. Null
 * where the item has no sprite sheet; the tile keeps its cover.
 */
export const lookMomentSchema = z.object({
    atMs: z.number(),
    thumbUrl: z.string().nullable(),
    thumbRect: spriteRectSchema.nullable(),
});
export type LookMoment = z.infer<typeof lookMomentSchema>;

export const mediaListResponseSchema = z.object({
    items: z.array(mediaListItemSchema),
    page: z.number(),
    pageSize: z.number(),
    /**
     * Whether another page exists.
     *
     * Deliberately *not* derived from `items.length < pageSize`. A shuffled page can come
     * back short in the middle of the library, because the permutation skips slots that no
     * longer hold a row -- so a short page is not evidence of the end, and treating it as one
     * would truncate a shuffled library at an arbitrary point.
     */
    hasMore: z.boolean(),
    /**
     * Total matching items, or null when it was not asked for.
     *
     * Absent from a page request on purpose. An exact count is a scan of the whole matching
     * set -- 188 ms at 200k items even with the partial index, against 0.4 ms for the page
     * itself -- so recomputing it on every page turn would make paging cost an order of
     * magnitude more than the rows. The filter is what changes the answer, and the filter is
     * stable while you page through it, so the count is fetched once per filter from
     * `/api/media/count` and cached there.
     */
    total: z.number().nullable(),
    /**
     * For a look, the moment of each item that matched it, in ms by item id (§5e "Search runs in
     * two passes").
     *
     * Absent from any other list, and absent for an item matched as a whole — a photograph has
     * no moment. Beside the items rather than on each one, so every list that is not a look
     * carries nothing for it.
     */
    moments: z.record(z.string(), lookMomentSchema).optional(),
});
export type MediaListResponse = z.infer<typeof mediaListResponseSchema>;

/**
 * One window of a filter's order as ids alone (§14b, §20) — `GET /api/media/ids`.
 *
 * The same question as a page of the library, asked by the viewer, which walks the set and
 * draws one item at a time. Its next and previous are positions in the order, and the item it
 * shows is fetched on its own; hydrating two hundred tiles to learn which id comes after this
 * one cost about five pages each on a cold disk and was redone on every step.
 *
 * Read with `mediaQuerySchema`, so it pages, sorts and shuffles exactly as the listing does —
 * the same ids in the same order, which is the only thing this is for.
 */
export const mediaIdsResponseSchema = mediaListResponseSchema
    .pick({ page: true, pageSize: true, hasMore: true })
    .extend({
        ids: z.array(z.string()),
        /** A look's matching moment for each id, in ms: where the viewer opens it (§5e). */
        moments: z.record(z.string(), z.number()).optional(),
    });
export type MediaIdsResponse = z.infer<typeof mediaIdsResponseSchema>;

/**
 * Items the grid already shows, asked about again (§13b).
 *
 * The library grid does not refetch its page when the live feed says something changed --
 * that would bring new items in and move the list. It asks about the items on screen
 * instead, by id: the ones that come back are patched where they sit, and the ones that do
 * not are no longer in the library and drop out. A page is sixty items; the cap leaves room
 * for the showcase's larger pages without letting one request ask about the whole library.
 */
export const mediaLookupQuerySchema = z.object({
    ids: z
        .string()
        .transform((value) => value.split(",").filter(Boolean))
        .pipe(z.array(z.string().uuid()).min(1).max(200)),
});

export const mediaLookupResponseSchema = z.object({
    /** Only the items still listable and visible to this viewer, in the order asked for. */
    items: z.array(mediaListItemSchema),
});
export type MediaLookupResponse = z.infer<typeof mediaLookupResponseSchema>;

export const mediaCountResponseSchema = z.object({
    total: z.number(),
    pageCount: z.number(),
});
export type MediaCountResponse = z.infer<typeof mediaCountResponseSchema>;

/**
 * One thing the house has done to an item, and when (§7b).
 *
 * `MediaStage` has recorded this per item per stage since the registry was built, and it has
 * only ever been read in aggregate -- the admin page's progress bars. Per item it is the
 * provenance of the file: probed on the day it arrived, hashed, a cover drawn, a preview cut.
 *
 * `pending` is not a state the table can hold. A stage with no row has not been attempted,
 * and the four stored states are all outcomes; synthesising the fifth here is what lets the
 * detail show the whole recipe rather than only the parts that have run.
 */
export const provenanceEntrySchema = z.object({
    stage: z.string(),
    state: z.enum(["done", "empty", "failed", "skipped", "pending"]),
    /** Null while pending, since nothing has happened yet to have a time. */
    at: z.string().nullable(),
    detail: z.string().nullable(),
    /**
     * Whether this stage can be asked to run for this item right now (§7b).
     *
     * False for `probe`, which is not in the registry and has no job kind to request, and
     * for a stage that does not apply to this kind of media — a sprite sheet of a
     * photograph. The server refuses both; this is so the UI does not offer them, which is
     * the same rule the cover and discard controls follow.
     */
    runnable: z.boolean(),
    /**
     * Will this arrive on its own, or is somebody going to have to ask (§7b)?
     *
     * Needed because `pending` means two different things and the ledger was reporting only
     * one of them. Where the sweep covers this stage, pending means it has not reached this
     * item yet, which is fairly described as queued. Where it does not, pending means nobody
     * has asked — nothing is coming, and saying "queued" promises work that will never
     * arrive.
     *
     * The *answer* rather than the stage's `mode`, which is what this used to carry. With
     * three modes the mode alone stopped being enough: an `optIn` stage is queued or not
     * depending on a setting the panel has no business reading, and shipping the mode would
     * have made the drawer keep a second copy of the rule in §7b. One boolean, decided
     * where the policy is already in hand.
     */
    sweeps: z.boolean(),
    /**
     * Work for this stage that has not finished yet: waiting in the queue, or running.
     *
     * Separate from `state` because the two answer different questions, and both are true at
     * once. `state` is the last outcome, and it stays until a new one replaces it: an item
     * whose text is being read again still has the text read last time. This says whether
     * a new one is on its way. Without it, a stage asked for by hand read exactly as it did
     * before the click, which is what made asking look like nothing had happened.
     */
    inFlight: z.enum(["queued", "running"]).nullable(),
});
export type ProvenanceEntry = z.infer<typeof provenanceEntrySchema>;

/**
 * One frame that could represent this item (§13).
 *
 * Three sources, one shape: the generated cover, the four alternates the cover job produces
 * alongside it, and stills a person captured from the player. The client picks among them
 * without caring which is which — except that a capture can be deleted and a generated frame
 * cannot, because only one of the two is somebody's work.
 */
/**
 * One string read out of an item's picture (§5d).
 *
 * A *finding*, not an assertion: it is what recognition elected across the frames it looked
 * at, and it is presented with the evidence for it rather than on its own. Confidence says
 * how well it was read; occurrences and stability say how much of the item it was on, which
 * is what separates a site watermark from a caption that went past once. A person judging
 * whether recognition is working on their library needs all three — a string alone is not
 * something anybody can check.
 */
export const mediaTextSchema = z.object({
    id: z.string(),
    /** The elected reading. May be one no single frame produced. */
    text: z.string(),
    /** 0-1, how well it was read. */
    confidence: z.number(),
    /** Frames it appeared in. */
    occurrences: z.number(),
    /** Fraction of sampled frames it appeared in, 0-1. */
    stability: z.number(),
    /**
     * Where in the item it was first seen, or null for a still.
     *
     * The reason a finding is checkable at all: it is what lets the player jump to the moment
     * and the person look at the frame the string was read from.
     */
    firstAtMs: z.number().nullable(),
    /**
     * What a person decided about it (§5d "Reviewing what was read"). Dismissed findings
     * reach administrators only, so one dismissed by mistake can be restored from where it
     * was dismissed.
     */
    reviewState: ocrReviewStateSchema.nullable(),
    /** The engine's reading, when somebody has corrected it. */
    originalText: z.string().nullable(),
});
export type MediaText = z.infer<typeof mediaTextSchema>;

/** Where a `MediaAttribute` came from — the column's CHECK, in the same order. */
export const mediaAttributeSourceSchema = z.enum([
    "user",
    "filename",
    "scraper",
    "ai",
    "ocr",
    "embedded",
]);

/**
 * One long-tail descriptive field (§5b): today, a tag the file carries about itself.
 *
 * For reading and searching, never for logic. `key` is the field's own name — `title`,
 * `comment`, `artist` — and the reader decides how to label it.
 */
export const mediaAttributeSchema = z.object({
    key: z.string(),
    value: z.string(),
    source: mediaAttributeSourceSchema,
});
export type MediaAttribute = z.infer<typeof mediaAttributeSchema>;

export const mediaFrameSchema = z.object({
    artifactId: z.string(),
    kind: z.enum(["cover", "poster", "capture"]),
    /** Grid-sized, for a strip of thumbnails. A capture's rendering rather than the still. */
    url: z.string(),
    /**
     * The same frame at the resolution it was taken, for the enlarged view.
     *
     * Equal to `url` for a generated frame, which is only ever produced grid-sized. A capture
     * keeps the source's own pixels, so the two differ and the strip must not use this one.
     */
    fullUrl: z.string(),
    /**
     * Where in the source this frame came from, or null.
     *
     * Present for anything pulled out of a video, which is what lets the player jump back to
     * the moment a still was taken. Null for a still image's downscaled copy, which has no
     * position to speak of.
     */
    atMs: z.number().nullable(),
    /** Whether this is the frame the library currently shows for the item. */
    isCover: z.boolean(),
    /**
     * Whether this frame *can* be made the cover.
     *
     * False only for a capture with no cover-sized rendering to point at — the grid must
     * never be handed a full-resolution still, so a capture whose rendering was not written
     * cannot be the cover however much anyone would like it to be. `captureFrame` allows
     * that outcome deliberately: a still whose downscale failed is still the viewer's still.
     *
     * Carried on the frame because it decides whether to *offer* the action. Without it the
     * button is drawn, pressed, and rejected by the service — a control that does nothing,
     * which is exactly how this was found.
     */
    coverable: z.boolean(),
    /**
     * Whether this viewer may alter this frame: discard it, or write its caption.
     *
     * Only a capture is ever discardable, and only by the person who took it or by an
     * administrator. Captures are library-wide, so without this the strip would offer a
     * destructive control over somebody else's non-regenerable work to every account that
     * can open the item (§6). The caption follows the same rule, so it rides on the same flag.
     */
    discardable: z.boolean(),
    /**
     * A capture's caption, or null. Always null for a generated frame.
     *
     * Visible to everyone who can see the item, like the capture itself (§9); written only by
     * whoever may discard it.
     */
    label: z.string().nullable(),
    /**
     * Who made it: `auto` is disposable generator output, `user` is somebody's capture.
     *
     * The distinction decides lifecycle, not appearance — a regeneration or a cleanup sweep
     * may replace an `auto` artifact at any time and must never touch a `user` one.
     */
    source: z.enum(["auto", "user"]),
    createdAt: z.string(),
});
export type MediaFrame = z.infer<typeof mediaFrameSchema>;

/** Capture the frame at this position of the original, as a still somebody keeps. */
export const captureFrameSchema = z.object({
    /**
     * Position in the *original*, in milliseconds.
     *
     * The player may be showing a web-safe rendition rather than the original, but both
     * carry the same timeline — a remux copies it and a re-encode preserves it — so one
     * number means the same moment in either (§8).
     */
    atMs: z.number().min(0),
});
export type CaptureFrameInput = z.infer<typeof captureFrameSchema>;

/**
 * Which frame represents the item, or `null` to go back to the generated one.
 *
 * Nullable rather than a separate "clear" endpoint: reverting is a real intention, and it is
 * the same one-row update in the other direction.
 */
export const setCoverSchema = z.object({
    artifactId: z.string().nullable(),
});
export type SetCoverInput = z.infer<typeof setCoverSchema>;

export const mediaDetailSchema = mediaListItemSchema.extend({
    codec: z.string().nullable(),
    container: z.string().nullable(),
    bitrate: z.number().nullable(),
    fps: z.number().nullable(),
    relPath: z.string(),
    rootLabel: z.string(),
    /**
     * Whether this item's root accepts writes, and so whether it could be deleted (§18.1).
     *
     * Carried on the item rather than looked up per root by the client, because deletion is
     * offered per item and an action that is sometimes there and sometimes not needs the
     * answer in the same payload as the thing it acts on.
     */
    deletable: z.boolean(),
    /** WebVTT thumbnail track for the scrubber, or null until the sprite job has run. */
    spriteVttUrl: z.string().nullable(),
    /**
     * What the player will receive, and why (§8).
     *
     * "original" is direct play. "segments" is direct play too, as a playlist of byte ranges of
     * the original (MPEG-TS, §8). "variant" means a web-safe rendition exists and is served
     * instead. "pending" means the original cannot be played and the rendition is still being
     * produced — the one state the UI has to explain rather than simply render.
     */
    playbackSource: z.enum(["original", "segments", "variant", "pending", "unavailable"]),
    /** Plain-language reasons the original cannot be played. Empty for direct play. */
    playbackBlockers: z.array(z.string()),
    /**
     * Tags on this item: library-wide ones plus this viewer's own.
     *
     * On the detail rather than the list because a grid tile has nowhere to put them, and
     * joining every tile to its tags would multiply the library query's row count by the
     * number of tags for a value the tile never shows.
     */
    tags: z.array(mediaTagSchema),
    /** Whether this viewer has hidden the item. */
    hidden: z.boolean(),
    /**
     * This viewer's private note, or null (§6, §14b).
     *
     * On the detail rather than the list because a tile has nowhere to draw it, and on the
     * item rather than in a library of notes because a note about nothing in particular is a
     * different feature.
     *
     * **Deliberately absent from the search index**, like every other per-user field. One
     * shared FTS document cannot hold per-user text without leaking it into another viewer's
     * results (§5c), so a note is something you read rather than something you search — and
     * that is the honest trade until per-user documents exist.
     */
    note: z.string().nullable(),
    /**
     * Every stage of the pipeline and what became of it, in the order they run.
     *
     * On the detail rather than its own endpoint: it is a handful of rows keyed by the id
     * already being fetched, and a second request would make the panel that shows it arrive
     * after the panel is open.
     */
    provenance: z.array(provenanceEntrySchema),
    /**
     * Every frame that could represent this item, the current one marked (§13).
     *
     * On the detail rather than its own endpoint, for the same reason `provenance` is: it is
     * a handful of rows keyed by the id already being fetched, and a second request would
     * make the strip arrive after the panel holding it is open.
     */
    frames: z.array(mediaFrameSchema),
    /**
     * **This viewer's** spans of this item, in timeline order (§14d).
     *
     * Here rather than behind an endpoint of its own, for the same reason `frames` is: a handful
     * of rows keyed by the id already being fetched, where a second request would make the strip
     * arrive after the page holding it.
     *
     * Yours only, deliberately. A clip is private raw material, so somebody else's spans on this
     * file are not listed here or anywhere else — the only place one reaches another account is
     * inside a reel they can open.
     */
    clips: z.array(clipSchema),
    /**
     * Text read out of the picture, strongest first (§5d).
     *
     * On the detail for the same reason as the two above, and for one more: these are the
     * only evidence a person has for judging whether recognition worked on their library.
     * Text that is stored but has no reader is text nobody can check.
     */
    text: z.array(mediaTextSchema),
    /**
     * What the file says about itself in its own tags, and any other long-tail field (§5b).
     *
     * On the detail for `text`'s reason: it is searched, and a search that matches on text the
     * page never shows reads as a search that matched nothing.
     */
    attributes: z.array(mediaAttributeSchema),
    /**
     * Where this item stands among its duplicates, or null when it has none (§10c).
     *
     * On the detail because this is where deletion is offered, and until it was carried here
     * deleting the best copy of a group was exactly as quiet as deleting the worst. The
     * review screen is where copies are compared; this is where one is actually removed, and
     * the two said nothing to each other.
     *
     * Both directions are stated. The warning on the best copy is what prevents a mistake;
     * the reassurance on every other copy is what stops that warning reading as a general
     * discouragement from tidying up, which across a library this size is the more expensive
     * failure.
     */
    duplicate: z
        .object({
            /** Copies that still have a file, this one included. */
            copies: z.number(),
            best: z.boolean(),
            /** One sentence: why to keep it, or what stays if it goes. */
            advice: z.string(),
            /**
             * Spans that would go with this copy, and the reels they are in (§10c, §14d).
             *
             * §10c deliberately does **not** move clips onto the surviving copy: a near duplicate
             * is a different encode with a different timeline, so a timecode carried across would
             * point at the wrong frames — a silent wrong answer, which is worse than a visible
             * loss. But §10c's other rule is that a merge nobody was told about is
             * indistinguishable from a loss, so the loss has to be named where the deletion
             * happens.
             *
             * `mine` and `reels` are this viewer's, and by the owner invariant the reels can be
             * named in full. `total` counts everybody's, because a bare count of spans discloses
             * nothing and destroying somebody's work with no notice at all is the worse failure.
             */
            clipsAtRisk: z.object({
                mine: z.number(),
                total: z.number(),
                reels: z.array(z.object({ id: z.string(), name: z.string() })),
            }),
        })
        .nullable(),
});
export type MediaDetail = z.infer<typeof mediaDetailSchema>;

/**
 * One configured library, as the room presents it (§14).
 *
 * A library is a root, and roots are already the unit of access control and the leading
 * column of every list index -- so "show each one separately" is the cheapest question the
 * schema can answer, not a new structure. The cover is a whole list item rather than a URL
 * because the invitation card wants the same shape a tile does, and inventing a second,
 * thinner cover type is how the two end up disagreeing about what "no cover yet" looks like.
 */
export const librarySummarySchema = z.object({
    id: z.string(),
    label: z.string(),
    items: z.number(),
    cover: mediaListItemSchema.nullable(),
});
export type LibrarySummary = z.infer<typeof librarySummarySchema>;

export const librariesResponseSchema = z.object({
    libraries: z.array(librarySummarySchema),
    /** Every item this viewer can see, across all of them. */
    total: z.number(),
});
export type LibrariesResponse = z.infer<typeof librariesResponseSchema>;

/**
 * What the shell polls: cheap, global, and fast-changing (§20).
 *
 * No item counts and no queue depth. The counts are `LibrariesResponse.total`, which is cached
 * per viewer and refreshed by the change feed; they cost an index entry per item, and polling
 * them stopped the web process for seconds at a time on the NAS. The queue depth had no reader
 * left once the shell's "queued" badge went — the admin Processing card has the queue in full.
 */
export const libraryStatsSchema = z.object({
    scanning: z.boolean(),
    /**
     * Root counts, so an empty library can say *why* it is empty.
     *
     * Roots are discovered disabled on purpose — mounting a share should not start a scan of
     * it — but without surfacing that, a first run is an empty grid with no visible cause and
     * nothing to click.
     */
    rootsTotal: z.number(),
    rootsEnabled: z.number(),
    everScanned: z.boolean(),
    /**
     * Whether the filter panel offers "Won't play in a browser" (§8). Here because it is global
     * and the same for everyone, and every viewer already polls this.
     */
    playbackCheck: z.boolean(),
});
export type LibraryStats = z.infer<typeof libraryStatsSchema>;

/**
 * Admin-controlled scanning settings (§12b).
 *
 * These live in the `Setting` table rather than `config.json` precisely so they can be
 * changed here — nobody should SSH into a NAS to stop a scan schedule.
 */
export const scanSettingsSchema = z.object({
    /**
     * Minutes between safety-net scans. **0 switches periodic scanning off entirely.**
     *
     * Safe to disable when every root is a local filesystem that filesystem events cover.
     * Not safe when a root is a remote mount, where another machine's writes are invisible
     * to the kernel doing the watching.
     */
    intervalMinutes: z.coerce
        .number()
        .int()
        .min(0)
        .max(60 * 24 * 30)
        .default(60 * 24),
    /** Whether to watch the filesystem for changes at all. */
    watch: z.boolean().default(true),
});
export type ScanSettings = z.infer<typeof scanSettingsSchema>;

export const scanStatusSchema = z.object({
    settings: scanSettingsSchema,
    roots: z.array(
        z.object({
            id: z.string(),
            label: z.string(),
            /** Where the library actually is, and the thing an admin edits to move it. */
            path: z.string(),
            /**
             * Whether that directory can be read right now.
             *
             * Reported rather than acted on: an unreachable library is a misconfiguration or
             * an offline share, and neither is a reason to touch what was catalogued from it.
             */
            available: z.boolean(),
            enabled: z.boolean(),
            writable: z.boolean(),
            lastScanAt: z.string().nullable(),
            fileCount: z.number(),
            /** Files hidden until a scan confirms them, after the library was repointed. */
            verifying: z.number(),
        })
    ),
    /** Directories under the media folder that are not libraries yet, offered when adding one. */
    candidates: z.array(z.string()),
    scanning: z.boolean(),
});
export type ScanStatus = z.infer<typeof scanStatusSchema>;

/**
 * The processing view (§13c): how far the library has got, and whether anything is moving.
 *
 * Deliberately separate from `scanStatusSchema` even though both live on the admin page. That
 * one describes libraries and settings and is cheap; this one aggregates over a table with a
 * row per item per stage and is polled every couple of seconds while work is running. Putting
 * them behind one endpoint would make the expensive half run every time the cheap half was
 * wanted.
 */
const stageProgressSchema = z.object({
    stage: z.string(),
    describe: z.string(),
    applicable: z.number(),
    done: z.number(),
    empty: z.number(),
    skipped: z.number(),
    failed: z.number(),
    remaining: z.number(),
    queued: z.number(),
});

export const processingStatusSchema = z.object({
    scan: z
        .object({
            rootId: z.string(),
            rootLabel: z.string(),
            filesSeen: z.number(),
            filesAdded: z.number(),
            filesChanged: z.number(),
            filesMoved: z.number(),
            /**
             * What the bar is measured against, or null when nothing can honestly say.
             *
             * A first scan of a library has no denominator — the walk does not know how many
             * files it will find. Null means "render a counter, not a bar".
             */
            estimatedTotal: z.number().nullable(),
            startedAt: z.string(),
        })
        .nullable(),
    stages: z.array(stageProgressSchema),
    queue: z.object({
        pending: z.number(),
        claimed: z.number(),
        failed: z.number(),
        /**
         * Whether a claimed job has beaten recently enough to believe the worker is alive.
         *
         * The one fact that separates "grinding through a long transcode" from "the worker
         * died and this will never finish", which look identical from a progress bar.
         */
        workerAlive: z.boolean(),
        /** Outstanding work by job kind, busiest first. Empty when the queue is drained. */
        byKind: z.array(z.object({ kind: z.string(), pending: z.number(), claimed: z.number() })),
    }),
    /**
     * Whether the pipeline is deliberately going slowly right now (§7c), or null when no
     * window is configured.
     *
     * Present for the same reason the liveness badge is. A throttled library and a dead
     * worker produce the same picture -- bars that barely move and a queue that does not
     * drain -- and the two call for opposite responses. Without this the feature's own
     * success looks like a fault.
     */
    throttle: z
        .object({
            active: z.boolean(),
            /** Local hour on the schedule's clock when this changes. */
            changesAtHour: z.number().int().min(0).max(23),
        })
        .nullable(),
    /**
     * What time the server thinks it is, on the clock the schedule is read against (§7c).
     *
     * **Not nested in `throttle`, and that was the bug.** It was, so a library with quiet
     * hours switched off — the default, and every library that has never configured them —
     * showed no clock at all, while the quiet hours card said in as many words that the
     * server clock was on the processing card. The one moment somebody needs to know what
     * time the server thinks it is, is while they are choosing the hours, which is precisely
     * when the feature is still off.
     *
     * An hour and no minutes, matching the granularity of the thing it explains. Claiming a
     * precision the schedule does not have would invite reading it as a live clock, which a
     * two-second poll that stops when the queue drains is not.
     */
    serverClock: z.object({
        hour: z.number().int().min(0).max(23),
        /** The IANA zone that hour is in, so the number is attributable rather than merely shown. */
        timeZone: z.string(),
        /** `UTC-05:00` at this instant, daylight saving included. */
        offsetLabel: z.string(),
        /** Whether that zone is the host's own or one an admin chose. */
        source: z.enum(["host", "configured"]),
    }),
});
export type ProcessingStatus = z.infer<typeof processingStatusSchema>;
export type StageProgressView = z.infer<typeof stageProgressSchema>;

/**
 * The playback check's test set (§8): the videos `assessPlayback` expects a browser to refuse,
 * grouped by what kind of file they are, with the same few samples of each for every device --
 * so a phone and a computer are tried on identical files and their answers compare.
 */
export const playbackCheckSchema = z.object({
    total: z.number(),
    groups: z.array(
        z.object({
            kind: z.string(),
            count: z.number(),
            samples: z.array(
                z.object({
                    id: z.string(),
                    title: z.string(),
                    durationMs: z.number().nullable(),
                    hasAudio: z.boolean(),
                })
            ),
        })
    ),
});
export type PlaybackCheck = z.infer<typeof playbackCheckSchema>;
