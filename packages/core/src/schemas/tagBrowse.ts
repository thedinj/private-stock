import { z } from "zod";

import { mediaListItemSchema } from "./media.js";
import { facetKindSchema, tagPictureSchema, tagScopeSchema, tagSchema } from "./tags.js";

/**
 * Looking at a vocabulary rather than curating it (§6 "Tags").
 *
 * Its own file because it joins the two halves: a browse row carries items as well as a tag,
 * and `media.ts` already imports `tags.ts`, so putting this in either would make them import
 * each other.
 */

export const tagBrowseSortSchema = z.enum(["count", "name", "recent"]);
export type TagBrowseSort = z.infer<typeof tagBrowseSortSchema>;

/**
 * How many rows a browse page holds.
 *
 * Small on purpose: each row carries a filmstrip, so a page is thirty tags and a few hundred
 * thumbnails, which is already more than a phone draws at once.
 */
export const TAG_BROWSE_PAGE_SIZE = 30;

/** Thumbnails per row. The row shows as many as fit; this is the most it can ask for. */
export const TAG_STRIP_LENGTH = 6;

export const tagBrowseQuerySchema = z.object({
    kind: facetKindSchema,
    scope: tagScopeSchema,
    search: z.string().trim().max(200).optional(),
    sort: tagBrowseSortSchema.default("count"),
    page: z.coerce.number().int().min(0).default(0),
    /** Only the viewer's favourites (§6 "Favourite tags"). Sent as `favorite=1` or left out. */
    favorite: z.coerce.boolean().optional(),
    /**
     * Which thumbnails each row shows.
     *
     * The client's, not the server's: it is the day unless somebody pressed reshuffle, and it
     * lives in the address so Back from a profile returns to the strips that were there.
     */
    seed: z.coerce.number().int().min(0).max(2_147_483_647),
});
export type TagBrowseQuery = z.infer<typeof tagBrowseQuerySchema>;

export const tagBrowseRowSchema = z.object({
    tag: tagSchema,
    /**
     * The viewer's own mark, on the row rather than on `tagSchema`: every picker and table
     * shares that one, and favourites are a Tags-area thing for now (§6 "Favourite tags").
     */
    favorite: z.boolean(),
    videoCount: z.number(),
    imageCount: z.number(),
    /** A few of its items, in the seed's order, already filtered to what the viewer may see. */
    strip: z.array(mediaListItemSchema),
});
export type TagBrowseRow = z.infer<typeof tagBrowseRowSchema>;

export const tagBrowseResponseSchema = z.object({
    rows: z.array(tagBrowseRowSchema),
    total: z.number(),
    page: z.number(),
    hasMore: z.boolean(),
});
export type TagBrowseResponse = z.infer<typeof tagBrowseResponseSchema>;

export const tagProfileQuerySchema = z.object({
    seed: z.coerce.number().int().min(0).max(2_147_483_647),
});

/**
 * How many of a performer's companions get a strip of the items they share.
 *
 * The rest stay as names. Sixteen strips would put a hundred thumbnails between the picture and
 * the shelves, and the people somebody appears with most are the ones worth seeing.
 */
export const COMPANION_STRIPS = 6;

export const tagCompanionSchema = z.object({
    tagId: z.string(),
    name: z.string(),
    /** Items carrying both. */
    shared: z.number(),
    /** Their picture, which leads their strip. */
    picture: tagPictureSchema.nullable(),
    /**
     * A few of the items carrying both, in the seed's order. Only the first `COMPANION_STRIPS`
     * companions have one; empty for the rest.
     */
    strip: z.array(mediaListItemSchema),
});
export type TagCompanion = z.infer<typeof tagCompanionSchema>;

/**
 * "Appears with" on a performer's page, asked for on its own (§6 "Tags", §20).
 *
 * Not part of the profile: the page draws without it, and it is fetched only once the tag's
 * own content is on screen and the section is near the viewport. Empty for anything but a
 * library performer.
 */
export const tagCompanionsResponseSchema = z.object({
    companions: z.array(tagCompanionSchema),
});
export type TagCompanionsResponse = z.infer<typeof tagCompanionsResponseSchema>;

/** One tag's page: who or what it is, and a first look at what carries it. */
export const tagProfileSchema = z.object({
    tag: tagSchema,
    favorite: z.boolean(),
    videoCount: z.number(),
    imageCount: z.number(),
    /** The picture at the top, from the seed's shuffle. Null when nothing visible carries it. */
    hero: mediaListItemSchema.nullable(),
    shelves: z.object({
        recent: z.array(mediaListItemSchema),
        topRated: z.array(mediaListItemSchema),
        shuffled: z.array(mediaListItemSchema),
    }),
});
export type TagProfile = z.infer<typeof tagProfileSchema>;

/**
 * Which kind a tag's page shows: its videos, or its photos when it has no videos (§14e "Videos
 * unless you ask"). The server fills the shelves with it and the page builds its links with it,
 * so the two cannot disagree; the photos of a tag that has videos are one click away on its
 * counts.
 */
export const tagProfileKind = (counts: Pick<TagProfile, "videoCount">): "video" | "image" =>
    counts.videoCount > 0 ? "video" : "image";

/** The viewer's own marks on a tag (§6 "Favourite tags"). Not a ChangeLog edit: it is private. */
export const userTagPatchSchema = z.object({
    favorite: z.boolean(),
});
export type UserTagPatch = z.infer<typeof userTagPatchSchema>;
