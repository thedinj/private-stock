import { z } from "zod";

import { playlistSortModeSchema, collectionVisibilitySchema } from "../domain.js";
import { BULK_SELECTION_LIMIT } from "./filters.js";
import { mediaListItemSchema } from "./media.js";

/**
 * Playlist contracts (§6).
 *
 * Private by default and shareable read-only. `visibility` is the only word in the API for
 * who can see one — there is no per-user grant list, because "shared" here means shared with
 * everyone who has an account on a personal server, and anything finer would be a permission
 * model nobody asked for.
 */

export const createPlaylistSchema = z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).nullish(),
    visibility: collectionVisibilitySchema.default("private"),
    pinned: z.boolean().default(false),
    /**
     * Items to start it with, for "make a playlist out of what I have selected" (§14b).
     *
     * On the create rather than left to a second request, so the playlist and its contents
     * arrive together. Two requests can half-fail, and the half that survives is an empty
     * playlist named after something it does not contain -- which reads as the feature having
     * worked and then lost everything.
     *
     * Ids the viewer cannot see are dropped by the service, exactly as they are when adding to
     * an existing one: the same rule, because this is the same operation with a create in
     * front of it.
     */
    mediaIds: z.array(z.string()).max(BULK_SELECTION_LIMIT).optional(),
});
export type CreatePlaylistInput = z.infer<typeof createPlaylistSchema>;

/**
 * A patch. Every field optional, and `description: null` clears it.
 *
 * Distinguishing "not mentioned" from "set to nothing" matters here because the two are
 * different intentions and a PATCH that could not express the second would need a separate
 * endpoint to remove a description.
 */
export const updatePlaylistSchema = z
    .object({
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(1000).nullable().optional(),
        visibility: collectionVisibilitySchema.optional(),
        pinned: z.boolean().optional(),
        position: z.number().int().min(0).optional(),
        /**
         * The order this list opens in, or `null` to stop having an opinion.
         *
         * Nullable for the same reason `description` is: "no default" is a state someone can
         * mean, and a patch that could only ever set one would have no way back to it.
         */
        sortMode: playlistSortModeSchema.nullable().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, { message: "Nothing to change" });
export type UpdatePlaylistInput = z.infer<typeof updatePlaylistSchema>;

export const playlistSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    visibility: collectionVisibilitySchema,
    /**
     * Entries, including any the viewer cannot currently see.
     *
     * Deliberately not the number of items that would come back from the items endpoint: an
     * unmounted library or another viewer's hidden items make that smaller, and a count that
     * shrinks when a share goes offline reads as data loss (§12b).
     */
    itemCount: z.number(),
    ownerName: z.string(),
    /**
     * Up to eight cover images from inside it: a row's strip, of which the card takes the first
     * four (§14b, §14c).
     *
     * A playlist has no picture of its own, so a list of them was a list of names on empty
     * cards — the one screen in the app that showed nothing of what it held. These are drawn
     * from across the whole list rather than off the top of it, so the card is a glimpse of
     * the playlist and not just of its first item.
     *
     * Each viewer's own: an item in a library this account cannot reach contributes nothing,
     * because a thumbnail is as much a disclosure as a row. Empty is normal — a new playlist,
     * or one whose covers have not been generated yet.
     */
    covers: z.array(z.string()),
    /** Whether this viewer may change it. False for a playlist shared by someone else. */
    editable: z.boolean(),
    /**
     * The owner's own arrangement of their sidebar.
     *
     * Whether this collection sits in **this viewer's** sidebar.
     *
     * Resolved per viewer, not read off the row (§14b). It used to be the owner's pin and
     * nothing else, which meant a playlist shared with the household could not be pinned by
     * anybody it was shared with — there was nowhere for their pin to live. The owner's pin is
     * now their own sidebar on a private collection and the household's default on a shared
     * one, and anybody may override that default for themselves: `resolvePin` is the rule and
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
    /**
     * Which order opening this list lands in, when the address says nothing (§14b).
     *
     * A default and nothing more. Shuffling is a seed in the URL, so the toolbar toggle
     * never writes here — "shuffle this visit" and "this is a shuffle list" are different
     * statements, and one control saying both would collapse them.
     */
    sortMode: playlistSortModeSchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type Playlist = z.infer<typeof playlistSchema>;

export const playlistItemsResponseSchema = z.object({
    items: z.array(mediaListItemSchema),
    page: z.number(),
    pageSize: z.number(),
    hasMore: z.boolean(),
    /** Entries in the playlist, against which a short page of items can be understood. */
    total: z.number(),
    /**
     * The permutation this page was drawn from, or null for the stored order.
     *
     * Echoed back so the response says which of the two orders it is, rather than leaving
     * that to be inferred from what was asked for.
     */
    seed: z.number().nullable(),
});
export type PlaylistItemsResponse = z.infer<typeof playlistItemsResponseSchema>;

/**
 * What to add: a list of items, or everything a saved filter matches.
 *
 * The second is what freezing a dynamic list into a fixed one means. A saved filter answers
 * "what matches right now" and keeps changing its mind; a playlist is the answer written
 * down, in an order somebody chose. Being able to cross from one to the other is the whole
 * relationship between the two — it is also why they are not one feature, because nothing
 * can freeze a set that has no separate identity.
 *
 * A union rather than an optional field, so a request cannot ask for both and leave the
 * server to decide which one it meant.
 */
export const addPlaylistItemsSchema = z.union([
    z.object({ mediaIds: z.array(z.string()).min(1).max(1000) }),
    z.object({
        filterId: z.string(),
        /** The filter approximates intent; these correct it, exactly as in bulk tagging. */
        excludeIds: z.array(z.string()).max(BULK_SELECTION_LIMIT).default([]),
    }),
]);
export type AddPlaylistItemsInput = z.infer<typeof addPlaylistItemsSchema>;

export const movePlaylistItemSchema = z.object({
    mediaId: z.string(),
    /** Zero-based destination, clamped to the ends rather than rejected. */
    toIndex: z.number().int().min(0),
});
export type MovePlaylistItemInput = z.infer<typeof movePlaylistItemSchema>;

/**
 * Where this viewer wants a collection in their own sidebar (§14b).
 *
 * `null` is not a synonym for false. False means "keep this out of my sidebar"; null clears the
 * decision, which puts the collection back on whatever the household offers. Both are gestures
 * somebody makes deliberately, so both need a spelling.
 */
export const setCollectionPinSchema = z.object({
    pinned: z.boolean().nullable(),
});
export type SetCollectionPinInput = z.infer<typeof setCollectionPinSchema>;
