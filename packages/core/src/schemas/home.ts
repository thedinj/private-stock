import { z } from "zod";

import { mediaListItemSchema } from "./media.js";

/**
 * The home page, as an ordered list of shelves (§6).
 *
 * A shelf is a *reference* to something that produces items — a builtin, a saved filter, a
 * playlist, a tag — never a copy of the items themselves. So a shelf built on a saved filter
 * changes when the filter does, and none of this has to be rebuilt when the library grows.
 *
 * The layout is per user. An admin sets the default that accounts inherit; see
 * `home.defaultLayout` in the settings surface (§12b).
 */

export const builtinShelfSchema = z.enum([
    /** Items this viewer has watched or looked at, most recent first. */
    "recentlyViewed",
    "recentlyAdded",
    "topRated",
    "favorites",
    /** A different handful each time the page is opened — the point is to be surprised. */
    "random",
]);
export type BuiltinShelf = z.infer<typeof builtinShelfSchema>;

/** How many items a shelf may show. A row, not a page — the shelf links onward for the rest. */
const shelfLimit = z.coerce.number().int().min(1).max(24).default(12);

/**
 * A title the user chose, overriding the one the shelf would name itself.
 *
 * Optional throughout: a shelf on a saved filter is called after the filter, and repeating
 * that name into the layout would leave the two able to disagree after a rename.
 */
const shelfTitle = z.string().trim().min(1).max(100).optional();

export const shelfSchema = z.discriminatedUnion("source", [
    z.object({
        source: z.literal("builtin"),
        builtin: builtinShelfSchema,
        title: shelfTitle,
        limit: shelfLimit,
    }),
    z.object({
        source: z.literal("filter"),
        filterId: z.string(),
        title: shelfTitle,
        limit: shelfLimit,
    }),
    z.object({
        source: z.literal("playlist"),
        playlistId: z.string(),
        title: shelfTitle,
        limit: shelfLimit,
    }),
    z.object({
        source: z.literal("tag"),
        tagId: z.string(),
        title: shelfTitle,
        limit: shelfLimit,
    }),
]);
export type Shelf = z.infer<typeof shelfSchema>;

export const homeLayoutSchema = z.array(shelfSchema).max(20);
export type HomeLayout = z.infer<typeof homeLayoutSchema>;

/**
 * What a new account sees before anyone has configured anything.
 *
 * Deliberately modest and entirely builtin: it must work on a library with no tags, no
 * playlists and no saved filters, which is precisely the state of a library on the day it is
 * first scanned.
 */
export const DEFAULT_HOME_LAYOUT: HomeLayout = [
    { source: "builtin", builtin: "recentlyViewed", limit: 12 },
    { source: "builtin", builtin: "recentlyAdded", limit: 12 },
    { source: "builtin", builtin: "favorites", limit: 12 },
    { source: "builtin", builtin: "random", limit: 12 },
];

export const resolvedShelfSchema = z.object({
    /** Stable within a response, so the client can key rows without inventing an id. */
    key: z.string(),
    title: z.string(),
    /**
     * The descriptor this row was built from, carried back with it.
     *
     * So a client can link onward — "see all" — without the server inventing a URL for a page
     * it knows nothing about. The shelf is the query; where that query is shown is the UI's
     * business.
     */
    shelf: shelfSchema,
    items: z.array(mediaListItemSchema),
    /**
     * Why a shelf is empty, when it is empty for a reason worth saying.
     *
     * A deleted saved filter or playlist leaves a shelf that can never fill, and a row that
     * is simply blank gives no way to find out why or to remove it.
     */
    unavailable: z.string().nullable(),
});
export type ResolvedShelf = z.infer<typeof resolvedShelfSchema>;

export const homeResponseSchema = z.object({
    shelves: z.array(resolvedShelfSchema),
    /** Whether this is the inherited default rather than a layout the user arranged. */
    isDefault: z.boolean(),
});
export type HomeResponse = z.infer<typeof homeResponseSchema>;
