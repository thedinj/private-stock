import { z } from "zod";

import { MAX_CLIP_SPEED, MIN_CLIP_MS, MIN_CLIP_SPEED } from "../clips.js";
import { clipTagKinds, sortDirectionSchema, type SortDirection } from "../domain.js";
import {
    mediaTagSchema,
    privateFacetRefinement,
    scopeFitsFacet,
    tagIdListSchema,
    tagNameSchema,
    tagScopeSchema,
} from "./tags.js";

/**
 * Clip contracts (§14d).
 *
 * A clip is a span of one item, marked by one person and **private to them**. Unlike a capture
 * (§9) it is not library-wide to read: it is a working note about where something happens and
 * most are never used, so `/clips` and the item page list your own and nothing else. The only
 * way a span reaches another account is as an entry in a reel they can open, and the reel is
 * what grants that read.
 *
 * Separate from `reels.ts` so that `media.ts` can carry an item's clips on its detail without
 * the two schema files importing each other.
 */

const speedSchema = z.number().min(MIN_CLIP_SPEED).max(MAX_CLIP_SPEED);

/**
 * How fast a span is meant to be seen, or `null` for however fast the viewer is watching.
 *
 * Nullable rather than defaulted to 1: a stored 1.0 cannot be told from "nobody chose", and the
 * badge in the strip is drawn for a speed somebody set, not for every clip in the library.
 */
const nullableSpeedSchema = speedSchema.nullish();

/**
 * The facets a clip takes (§14d "Tagging clips"): performer and keyword, never source.
 *
 * The same vocabulary as items, assigned separately -- "Mia" on a clip is the same tag as "Mia"
 * on a video, so a rename or a merge reaches both.
 */
export const clipFacetSchema = z.enum(clipTagKinds);

/** One name typed while marking a span, with the system it belongs to. */
const clipTagNameSchema = z
    .object({ kind: clipFacetSchema, name: tagNameSchema, scope: tagScopeSchema })
    .refine(scopeFitsFacet, privateFacetRefinement);

export const createClipSchema = z
    .object({
        startMs: z.number().int().min(0),
        endMs: z.number().int().min(0),
        label: z.string().trim().max(200).nullish(),
        speed: nullableSpeedSchema,
        /** Tags to put on it as it is saved, so marking and tagging are one gesture. */
        tags: z.array(clipTagNameSchema).max(50).optional(),
    })
    .refine((value) => value.endMs - value.startMs >= MIN_CLIP_MS, {
        message: "That span is too short to be a clip",
        path: ["endMs"],
    });
export type CreateClipInput = z.infer<typeof createClipSchema>;

/**
 * A patch. `label: null` clears the name and `speed: null` returns the span to normal rate.
 *
 * Both nullable for the same reason `Playlist.description` is: "no name" and "no opinion about
 * speed" are states somebody can mean, and a patch that could only ever set one would leave no
 * way back.
 */
export const updateClipSchema = z
    .object({
        startMs: z.number().int().min(0).optional(),
        endMs: z.number().int().min(0).optional(),
        label: z.string().trim().max(200).nullable().optional(),
        speed: speedSchema.nullable().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, { message: "Nothing to change" })
    .refine(
        (value) =>
            value.startMs === undefined ||
            value.endMs === undefined ||
            value.endMs - value.startMs >= MIN_CLIP_MS,
        { message: "That span is too short to be a clip", path: ["endMs"] }
    );
export type UpdateClipInput = z.infer<typeof updateClipSchema>;

/**
 * Adding names to, or taking them from, one clip's facet.
 *
 * Add and remove only, one chip per request, for the reason `applyTagsSchema` gave up sending the
 * whole facet: two quick edits must not erase each other.
 */
export const editClipTagsSchema = z
    .object({
        kind: clipFacetSchema,
        names: z.array(tagNameSchema).max(50),
        scope: tagScopeSchema,
        mode: z.enum(["add", "remove"]),
    })
    .refine(scopeFitsFacet, privateFacetRefinement);
export type EditClipTagsInput = z.infer<typeof editClipTagsSchema>;

/** How many clips one bulk tagging may touch -- more than anybody holds (§14d: hundreds). */
export const CLIP_BULK_LIMIT = 500;

/**
 * Tagging a selection of clips in one action, withdrawable as a batch (§5d).
 *
 * A selection rather than a filter, so no preview: the person ticked exactly these.
 */
export const bulkClipTagSchema = z
    .object({
        clipIds: z.array(z.string()).min(1).max(CLIP_BULK_LIMIT),
        kind: clipFacetSchema,
        names: z.array(tagNameSchema).min(1).max(20),
        scope: tagScopeSchema,
    })
    .refine(scopeFitsFacet, privateFacetRefinement);
export type BulkClipTagInput = z.infer<typeof bulkClipTagSchema>;

/**
 * A tag as it sits on a clip: the item-tag shape without the fields only items have.
 *
 * No `source`, `confidence` or `addedBy` -- only the clip's owner writes to it, and only by typing.
 */
export const clipTagSchema = mediaTagSchema.pick({
    tagId: true,
    kind: true,
    name: true,
    colorKey: true,
    position: true,
    private: true,
});
export type ClipTag = z.infer<typeof clipTagSchema>;

/** A reel this clip is in. Always complete: by the owner invariant, they are all the viewer's. */
export const clipReelRefSchema = z.object({ id: z.string(), name: z.string() });

/**
 * One tile of a sprite sheet: where it is, and how big the sheet is (§14d).
 *
 * The sheet's own size is here so the crop can be expressed as percentages: a card in a fluid
 * grid has no fixed width, and `background-size` in percent scales the whole sheet with the box
 * while `background-position` in percent keeps the requested tile in frame. Given only the tile's
 * pixel rectangle the caller would have to know its rendered width in advance, which in a grid is
 * exactly what it does not.
 */
export const spriteRectSchema = z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    sheetWidth: z.number(),
    sheetHeight: z.number(),
});

export const clipSchema = z.object({
    id: z.string(),
    mediaId: z.string(),
    /** The item's title, so a row in the browser says what it is a piece of. */
    mediaTitle: z.string(),
    startMs: z.number(),
    endMs: z.number(),
    speed: z.number().nullable(),
    /**
     * How long it takes to watch, which is **not** `endMs - startMs` once a speed is set.
     *
     * Computed rather than left to the client so that every surface reporting a duration reports
     * the same number. See `spanRunMs`.
     */
    runMs: z.number(),
    label: z.string().nullable(),
    /**
     * The clip's tags, for its owner only.
     *
     * Always empty through a reel: a shared reel grants the span, not its owner's filing of it.
     */
    tags: z.array(clipTagSchema),
    /**
     * A thumbnail for the span, and the rectangle to crop out of it.
     *
     * The scrubber's sprite sheet, reused. Every video already carries a tile roughly every few
     * seconds, so the face of a clip costs no ffmpeg, no `Artifact` row and no disk — it is a
     * `background-position` into a sheet the browser has probably already fetched. Null when the
     * item has no sprite yet, where the caller falls back to the item's cover.
     */
    thumbUrl: z.string().nullable(),
    /** Which tile of the sheet, and how big the sheet is. */
    thumbRect: spriteRectSchema.nullable(),
    /** Whether this viewer marked it. False only for an unattributed clip inside a shared reel. */
    mine: z.boolean(),
    /** Whether this viewer may retime or discard it. See `mayAlterOwnWork`. */
    editable: z.boolean(),
    /**
     * How many reels hold it.
     *
     * The count rather than the names, because the browser draws several hundred rows and it
     * only needs enough to answer "have I used this yet". The dialogues that need to name them
     * read `reels` off the single-clip response.
     */
    reelCount: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type Clip = z.infer<typeof clipSchema>;

/** One clip, with the reels it is in named — what a retime or a discard has to say out loud. */
export const clipDetailSchema = clipSchema.extend({
    reels: z.array(clipReelRefSchema),
});
export type ClipDetail = z.infer<typeof clipDetailSchema>;

export const clipSorts = ["created", "startMs", "duration", "label"] as const;
export const clipSortSchema = z.enum(clipSorts);
export type ClipSort = z.infer<typeof clipSortSchema>;

/**
 * Which way round each clip sort naturally reads (§14's `naturalDirection`, same idea).
 *
 * A table keyed by sort rather than a rule about types, and exhaustive, so adding a sort without
 * deciding its direction is a compile error rather than a silent descending.
 */
const CLIP_NATURAL_DIRECTION: Record<ClipSort, SortDirection> = {
    created: "desc",
    startMs: "asc",
    duration: "desc",
    label: "asc",
};
export const clipNaturalDirection = (sort: ClipSort): SortDirection => CLIP_NATURAL_DIRECTION[sort];

/** How the "with" picks of one field combine. "none" is spelled by the field's without list. */
export const tagMatchSchema = z.enum(["any", "all"]);
export type TagMatch = z.infer<typeof tagMatchSchema>;

/**
 * Tag filters on /clips: what the **video** carries and what the **clip** carries, as two fields
 * (§14d "Tagging clips").
 *
 * Strict by default -- "Clip has: Mia" means somebody tagged the span, not that Mia is somewhere
 * in a two-hour video. `orVideo` names the clip-side picks that may be satisfied by the video
 * instead, one tag at a time.
 *
 * Flat lists rather than `FilterGroup`s: groups carry rating, measure and root rules that mean
 * nothing to a clip, and the "or its video" mode would leak into `MediaQuery`.
 */
const clipQueryShape = z.object({
    /** Free text over the label. */
    search: z.string().trim().max(200).optional(),
    /** Tags the clip's video carries: "with" these. */
    videoTags: tagIdListSchema.optional(),
    /** Tags the clip's video must not carry. */
    videoNotTags: tagIdListSchema.optional(),
    /** How `videoTags` combine. Absent is "all". */
    videoMatch: tagMatchSchema.optional(),
    /** Tags on the clip itself. */
    clipTags: tagIdListSchema.optional(),
    clipNotTags: tagIdListSchema.optional(),
    clipMatch: tagMatchSchema.optional(),
    /** Clip-side picks that also match when the video carries the tag instead. */
    orVideo: tagIdListSchema.optional(),
    /** Narrow to clips of one item, which is what the item page asks for. */
    mediaId: z.string().optional(),
    rootId: z.string().optional(),
    /** Only clips not yet in any reel — the question somebody assembling one keeps asking. */
    unusedOnly: z.coerce.boolean().optional(),
    minDurationMs: z.coerce.number().int().min(0).optional(),
    maxDurationMs: z.coerce.number().int().min(0).optional(),
    sort: clipSortSchema.default("created"),
    direction: sortDirectionSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(60),
    page: z.coerce.number().int().min(0).default(0),
});

export const clipQuerySchema = clipQueryShape.refine(
    (value) =>
        (value.orVideo ?? []).every(
            (id) => value.clipTags?.includes(id) || value.clipNotTags?.includes(id)
        ),
    { message: '"Or its video" applies only to a tag picked under "Clip has"', path: ["orVideo"] }
);
export type ClipQuery = z.infer<typeof clipQuerySchema>;

export const clipListResponseSchema = z.object({
    items: z.array(clipSchema),
    page: z.number(),
    pageSize: z.number(),
    hasMore: z.boolean(),
    total: z.number(),
});
export type ClipListResponse = z.infer<typeof clipListResponseSchema>;

/** One tag in a /clips facet list, with how many of your clips it reaches. */
export const clipTagFacetValueSchema = z.object({
    tagId: z.string(),
    kind: z.string(),
    name: z.string(),
    private: z.boolean(),
    count: z.number(),
});
export type ClipTagFacetValue = z.infer<typeof clipTagFacetValueSchema>;

/**
 * The chips for /clips: tags on your clips, and tags on the videos your clips come from.
 *
 * Counts over all your clips, not the current filter, so a chip does not move under the pointer
 * when another is picked (§5b).
 */
export const clipTagFacetsSchema = z.object({
    clip: z.array(clipTagFacetValueSchema),
    video: z.array(clipTagFacetValueSchema),
});
export type ClipTagFacets = z.infer<typeof clipTagFacetsSchema>;
