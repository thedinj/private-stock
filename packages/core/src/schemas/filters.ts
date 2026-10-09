import { z } from "zod";

import { collectionVisibilitySchema } from "../domain.js";
import { groupsArePersonal } from "./filterLogic.js";
import { mediaQuerySchema } from "./media.js";

/**
 * Saved filters (§6).
 *
 * A saved filter is a `MediaQuery` with a name on it, so the query is validated by the same
 * schema the grid uses rather than a looser copy. Anything the filter panel cannot express
 * therefore cannot be saved, and anything saved can be run.
 *
 * Paging is stripped before storing. A filter is a way of looking at the library, not a
 * position in it, and saving "page 7" would drop the user somewhere arbitrary the next time
 * the library grew.
 *
 * A saved filter is a dynamic playlist, and is deliberately shaped like one: same name,
 * description, pin and share, same shape of items response. What is *not* shared between them
 * is ordering — position is a playlist's content, where a filter carries a sort instead — and
 * the item total, which is a cheap count for a playlist and a scan of the matching set for a
 * filter (§20).
 */

/**
 * What a saved filter keeps: a library query without its position, and without a look.
 *
 * A look is left out for now, not by design (§5e "Search runs in two passes"). It is ranked in the
 * web process from a vector that takes a model to compute, so every place that reads a saved filter
 * -- a home shelf, a card face, bulk tagging, freezing into a playlist -- would need to wait on it;
 * until they do, a saved look would be silently answered as the library without it, and a bulk
 * action would reach far more than was on screen.
 */
export const savedQuerySchema = mediaQuerySchema.omit({ page: true, lookText: true, like: true });
export type SavedQuery = z.infer<typeof savedQuerySchema>;

/**
 * The largest set one action may act on at once.
 *
 * A limit, not a page size, and shared by everything that operates on a filtered set —
 * bulk tagging and freezing a filter into a playlist. These are the operations that can be
 * wrong about tens of thousands of items from a single careless query, and refusing to
 * proceed is a far better failure than quietly acting on an arbitrary ten thousand of them.
 */
export const BULK_SELECTION_LIMIT = 10_000;

/**
 * Predicates that resolve against whoever is looking, rather than against the library.
 *
 * This is the whole difference between sharing a playlist and sharing a filter. A shared
 * playlist names the same items for everyone; a shared filter containing one of these names
 * *your* favourites when you open it and *mine* when I do.
 *
 * That is sometimes exactly the point — "unwatched, five stars" is more useful per-person
 * than frozen to one person's ratings — so it is surfaced rather than forbidden. The UI can
 * then say the row shows your own ratings, instead of leaving you to discover that a filter
 * called "Dad's favourites" is quietly showing you yours.
 */
/**
 * Whose personal judgements a shared filter asks about.
 *
 * `viewer` — the default — means the query resolves against whoever opens it. `owner` means
 * it resolves against the person who saved it, so "five stars, unwatched" shared by one
 * account stays *their* five stars for everyone who looks.
 *
 * Whole-filter rather than per-predicate. Per-predicate would have to live inside
 * `mediaQuerySchema`, which travels in every grid URL and would then carry a structure that
 * only means something for a saved, shared filter; it would also leave `sort: "rating"` with
 * no answer to "whose". This can gain per-predicate overrides later with the filter's choice
 * as their default; the reverse is not available.
 */
export const resolveAsSchema = z.enum(["viewer", "owner"]);
export type ResolveAs = z.infer<typeof resolveAsSchema>;

export const isViewerRelative = (query: SavedQuery): boolean =>
    query.favorite !== undefined ||
    query.unrated !== undefined ||
    query.minRating !== undefined ||
    query.maxRating !== undefined ||
    // A rating or a favourite inside a group, or "any of my favourite performers" (§14e).
    groupsArePersonal(query.groups);

export const createSavedFilterSchema = z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).nullish(),
    query: savedQuerySchema,
    pinned: z.boolean().default(false),
    visibility: collectionVisibilitySchema.default("private"),
    resolveAs: resolveAsSchema.default("viewer"),
});
export type CreateSavedFilterInput = z.infer<typeof createSavedFilterSchema>;

export const updateSavedFilterSchema = z
    .object({
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(1000).nullable().optional(),
        query: savedQuerySchema.optional(),
        pinned: z.boolean().optional(),
        position: z.number().int().min(0).optional(),
        visibility: collectionVisibilitySchema.optional(),
        resolveAs: resolveAsSchema.optional(),
    })
    .refine((value) => Object.keys(value).length > 0, { message: "Nothing to change" });
export type UpdateSavedFilterInput = z.infer<typeof updateSavedFilterSchema>;

export const savedFilterSchema = z.object({
    id: z.string(),
    name: z.string(),
    /**
     * The stored query, or null if it can no longer be parsed.
     *
     * Null rather than omitting the filter. A stored query becomes unreadable only when the
     * query schema changes under it, and a filter that quietly disappeared would look like
     * data loss with no way to find out what happened — where a filter shown as broken can be
     * inspected and deleted deliberately.
     */
    query: savedQuerySchema.nullable(),
    description: z.string().nullable(),
    visibility: collectionVisibilitySchema,
    /** Whether this viewer may change it. False for a filter shared by someone else. */
    editable: z.boolean(),
    ownerName: z.string(),
    /**
     * Whether the query resolves against the viewer rather than the library.
     *
     * Computed rather than stored, so it can never disagree with the query it describes.
     * Null when the query can no longer be read, because then there is nothing to judge.
     */
    viewerRelative: z.boolean().nullable(),
    resolveAs: resolveAsSchema,
    /**
     * Whether this viewer is actually seeing somebody else's judgements.
     *
     * True only when all three hold: the filter resolves against its owner, the viewer is not
     * the owner, and the query asks about ratings at all. The UI needs the conclusion, not the
     * three facts — this is what a row saying "rated by Alice" hangs on, and computing it
     * client-side is three chances to get it wrong.
     */
    showsOwnerRatings: z.boolean(),
    /**
     * Whether this collection sits in **this viewer's** sidebar.
     *
     * Resolved per viewer, not read off the row (§14b). The owner's pin is their own sidebar on
     * a private collection and the household's default on a shared one, and anybody may
     * override that default for themselves — `resolvePin` is the whole rule and
     * `CollectionPin` is where an override lives.
     */
    pinned: z.boolean(),
    /**
     * Whether it is in this viewer's sidebar because the house put it there.
     *
     * A pin somebody chose and one they inherited look identical, and the difference decides
     * what an unpin control means: removing your own bookmark, or opting out of something an
     * administrator offered the household. False on your own collections, and false once this
     * viewer has made any decision of their own — see `resolvePin`.
     */
    curated: z.boolean(),
    position: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type SavedFilter = z.infer<typeof savedFilterSchema>;

/**
 * A saved view's face (§14c): up to eight covers from the first of what it answers -- a row's
 * strip, of which a card takes four -- fetched per card
 * as it comes on screen rather than with the list, because answering every view to draw the
 * list would make its cost the number of views somebody keeps. Empty when there is nothing to
 * show, and the card falls back to the view's terms.
 */
export const savedFilterCoversSchema = z.object({ covers: z.array(z.string()) });
export type SavedFilterCovers = z.infer<typeof savedFilterCoversSchema>;
