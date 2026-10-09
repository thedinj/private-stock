import { z } from "zod";

import { allowsPrivate, tagKinds, tagSourceSchema } from "../domain.js";

/**
 * Faceted tags (§5b).
 *
 * One table covers genres, performers, series, studios and source sites, because the
 * difference between them is a value in `kind` rather than a shape. Adding a facet is a row,
 * not a migration — which is the whole reason this was built faceted on day one.
 */

/**
 * Whether a facet is one the UI has a section and an ordering for.
 *
 * `tagKinds` in `domain.ts` is a *display* list, not a constraint: `Tag.kind` is an open
 * string and the database accepts anything. A tag with an unknown kind still works, still
 * searches and still filters -- it simply groups under "other" rather than getting its own
 * section. Keeping it open is what makes a future scraper cheap: it can invent `director`
 * and nothing rejects the write.
 */
export const isKnownFacet = (kind: string): kind is (typeof tagKinds)[number] =>
    (tagKinds as readonly string[]).includes(kind);

export const facetKindSchema = z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/, "A facet is lowercase letters, digits and dashes");

/** A name as somebody types it. Exported because every write that carries one shares it. */
export const tagNameSchema = z.string().trim().min(1).max(200);

/**
 * Which of the two tagging systems a write addresses (§6).
 *
 * Public tags are the library's: everybody sees them and anybody may set or remove one.
 * Private tags are one person's, invisible to everyone else including an administrator.
 *
 * **Required, with no default.** A default is the failure this shape exists to prevent --
 * publishing something somebody meant to keep. Two separate systems means two separate
 * gestures, so every write says which one it is, and a caller that forgets does not compile.
 */
export const tagScopeSchema = z.enum(["public", "private"]);
export type TagScope = z.infer<typeof tagScopeSchema>;

/**
 * Only `tag` can be private (§6).
 *
 * A predicate and a message rather than a wrapper function, and that is not style: a generic
 * helper taking `z.ZodType<T>` collapses zod's input and output types into one, so every schema
 * it wrapped started inferring its *input* — `sort` and `limit` optional, their defaults not yet
 * applied. `.refine` called on the object itself keeps both.
 *
 * Applied to every input carrying a facet and a scope together, so the refusal arrives as a
 * readable 400 naming the facet. The repo enforces the same rule, which is not redundant: this
 * is the message, that is the guarantee.
 */
export const scopeFitsFacet = (value: { kind: string; scope: TagScope }): boolean =>
    value.scope === "public" || allowsPrivate(value.kind);

export const PRIVATE_FACET_MESSAGE =
    "Only tags can be private — a performer or a source is a fact about the item";

/**
 * A list of tag ids, as the URL spells it.
 *
 * Accepts a comma-separated string as well as an array, since this is what a grid puts in the
 * address and a URL has to stay readable and hand-editable (§14). At most 20, like a group.
 */
export const tagIdListSchema = z.preprocess(
    (value) =>
        typeof value === "string"
            ? value
                  .split(",")
                  .map((part) => part.trim())
                  .filter(Boolean)
            : value,
    z.array(z.string()).max(20)
);

export const privateFacetRefinement = {
    message: PRIVATE_FACET_MESSAGE,
    path: ["scope"],
};

/**
 * A tag's picture, as the client draws it (§6 "A tag's picture").
 *
 * Two URLs because two sizes are drawn and neither may stand in for the other: the large one on
 * every small card is megabytes for a row of tags, and the small one on a tile is a blur.
 */
export const tagPictureSchema = z.object({
    /** About 600 pixels wide: the browse tile and the tag page's inset. */
    url: z.string(),
    /** About 240 pixels wide: everything drawn at 72–88 CSS pixels. */
    smallUrl: z.string(),
    /** Chosen by somebody, or read from their confirmed faces until somebody does. */
    source: z.enum(["user", "auto"]),
    /** The item it was taken from, while that item exists; the inset opens it there. */
    mediaId: z.string().nullable(),
    atMs: z.number().nullable(),
});
export type TagPicture = z.infer<typeof tagPictureSchema>;

/** A region of a frame, as fractions of its width and height. */
export const pictureCropSchema = z
    .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        w: z.number().gt(0).max(1),
        h: z.number().gt(0).max(1),
    })
    .refine((crop) => crop.x + crop.w <= 1.0001 && crop.y + crop.h <= 1.0001, {
        message: "The crop runs off the picture",
    });
export type PictureCropInput = z.infer<typeof pictureCropSchema>;

/**
 * "Use this as their picture": a moment of an item and the part of it to keep. The server takes
 * the frame from the original again, so the picture is as sharp as the file allows whatever the
 * dialogue was shown.
 */
export const setTagPictureSchema = z.object({
    mediaId: z.string().min(1).max(64),
    /** Where in a video; null for a photograph. */
    atMs: z.number().int().min(0).nullable(),
    crop: pictureCropSchema,
});
export type SetTagPictureInput = z.infer<typeof setTagPictureSchema>;

export const tagSchema = z.object({
    id: z.string(),
    kind: facetKindSchema,
    name: tagNameSchema,
    /** Normalised form, for matching. Derived on write — never supplied by a client. */
    nameNorm: z.string(),
    colorKey: z.string().nullable(),
    description: z.string().nullable(),
    /**
     * How many items the viewer can see carry this tag. On listings, not on a single read.
     *
     * Counted over items the library would actually show, so clicking it lands on that many
     * rows. A raw assignment count includes trashed and archived media, and a tag that
     * promises 412 and delivers 380 reads as broken data rather than as two questions.
     */
    mediaCount: z.number().optional(),
    /**
     * Who coined the name, or null once that account is gone (§6).
     *
     * A display name rather than an id, like every other person on the wire. The only
     * provenance a public tag has, and the question an open vocabulary invites: anybody may
     * add to it, so "where did this one come from" is asked about names nobody recognises.
     */
    createdBy: z.string().nullable().optional(),
    /**
     * Its other names, alphabetically (§5b "Aliases"). On listings and single reads.
     *
     * Each one resolves to this tag wherever a name is typed, and is searched with it.
     */
    aliases: z.array(z.string()).optional(),
    /**
     * Whether this tag belongs to the viewer rather than to the library (§6).
     *
     * A boolean rather than the owner's id, because the only two answers anybody can be
     * given are "yours" and "the library's" — a third person's tag is not in the response
     * at all. Sending the id would put one account's identifier in another's payload for a
     * question already answered.
     */
    private: z.boolean(),
    /**
     * Its picture, where the reader draws one: browse pages, the tag's page, an item's tags and
     * the tag boxes' suggestions. Null when it has none the viewer may see; absent elsewhere.
     */
    picture: tagPictureSchema.nullable().optional(),
});
export type Tag = z.infer<typeof tagSchema>;

/**
 * What a tag box is offered for what was typed (§5b "One rule for names"), best match first.
 * `near` is true when nothing matched as typed and these are close spellings instead — the box
 * then offers the new name first, since it may really be somebody else.
 */
/**
 * "Not them", said from "Find untagged" of items whose own text names a tag (§5d): they stop
 * being offered for it.
 */
export const mentionRefusalSchema = z.object({
    mediaIds: z.array(z.string().min(1).max(64)).min(1).max(500),
});
export type MentionRefusal = z.infer<typeof mentionRefusalSchema>;

export const tagSearchResponseSchema = z.object({
    tags: z.array(tagSchema),
    near: z.boolean(),
});
export type TagSearchResponse = z.infer<typeof tagSearchResponseSchema>;

export const createTagSchema = z
    .object({
        kind: facetKindSchema,
        name: tagNameSchema,
        scope: tagScopeSchema,
        colorKey: z.string().trim().max(40).optional(),
        description: z.string().trim().max(1000).optional(),
    })
    .refine(scopeFitsFacet, privateFacetRefinement);
export type CreateTagInput = z.infer<typeof createTagSchema>;

export const updateTagSchema = z.object({
    name: tagNameSchema.optional(),
    /**
     * Moving a tag between facets — a performer filed as a plain tag, most often.
     *
     * Retroactive like a rename, and rejected rather than merged when the target facet already
     * holds the name: silently folding two tags together is a different, lossier operation than
     * the one somebody asked for.
     */
    kind: facetKindSchema.optional(),
    colorKey: z.string().trim().max(40).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    /**
     * The tag's complete set of aliases, replacing whatever it had (§5b "Aliases").
     *
     * The whole set rather than additions and removals, because the screen edits a set and
     * saves it with the name. An alias equal to the (new) name is dropped, which is how
     * renaming onto one of the tag's own aliases works.
     */
    aliases: z.array(tagNameSchema).max(50).optional(),
    /**
     * Whether a rename keeps the old name as an alias.
     *
     * Off unless asked for: most renames correct a spelling, and keeping the misspelling as
     * something that still resolves is the opposite of what was wanted. On is for the name
     * that changed -- a performer who married -- where the old one is still how people know them.
     */
    keepOldNameAsAlias: z.boolean().optional(),
});
export type UpdateTagInput = z.infer<typeof updateTagSchema>;

/** Folding one tag into another (§6). */
export const mergeTagsSchema = z.object({
    /** The tag that survives. The one in the path is folded into it, then removed. */
    intoTagId: z.string().min(1),
    /**
     * Whether the folded tag's name becomes an alias of the survivor (§5b "Aliases").
     *
     * On by default, because a merge that forgets the name invites the duplicate back: the
     * next person to type it coins it again. Off is for the stray typo nobody should be able
     * to type their way back to.
     */
    keepAlias: z.boolean().default(true),
});
export type MergeTagsInput = z.infer<typeof mergeTagsSchema>;

/**
 * Applying tags to one item.
 *
 * Names rather than ids, because the overwhelmingly common action is typing a name that may
 * or may not exist yet. Making the client resolve that first turns one gesture into two
 * round trips and a race — two people adding the same new performer at once would each
 * create it. Resolution happens server-side in one transaction instead.
 */
export const applyTagsSchema = z
    .object({
        kind: facetKindSchema,
        names: z.array(tagNameSchema).max(50),
        /**
         * Which system these names belong to.
         *
         * The names resolve in that system's vocabulary and nowhere else. Typing "beach"
         * privately makes *your* "beach", separate from the library's, rather than borrowing the
         * curated name -- which is what keeps the two systems from entangling, and the price of
         * not having to explain why one chip means two different things (§6).
         */
        scope: tagScopeSchema,
        /**
         * Whether these names become the complete set for this facet, or are added to or
         * taken from it.
         *
         * "add" and "remove" are what the item page sends: one chip per request, so two quick
         * edits cannot erase each other. Its box used to submit "replace" with the whole facet,
         * built from the last response, and a second chip added before the first came back
         * replaced the first away. "replace" stays for callers that really mean the full set.
         */
        mode: z.enum(["replace", "add", "remove"]).default("replace"),
    })
    .refine(scopeFitsFacet, privateFacetRefinement);
export type ApplyTagsInput = z.infer<typeof applyTagsSchema>;

/**
 * A tag as it appears attached to an item.
 *
 * Carries the assignment's own fields — a low-confidence AI suggestion has to be
 * distinguishable from something a person typed, or phase 10 quietly pollutes the library.
 */
export const mediaTagSchema = z.object({
    tagId: z.string(),
    kind: z.string(),
    name: z.string(),
    colorKey: z.string().nullable(),
    source: tagSourceSchema,
    confidence: z.number().nullable(),
    position: z.number().nullable(),
    /**
     * Who applied it, or null if that account is gone or it predates attribution (§6).
     *
     * A display name rather than an id: the question is "who tagged this", and an id would
     * put one account's identifier in another's payload for a question already answered.
     * Null renders as nothing rather than as "unknown", which would imply the app once knew.
     */
    addedBy: z.string().nullable(),
    /**
     * Whether this tag is the viewer's own rather than the library's.
     *
     * A property of the tag, not of this assignment of it. The two systems are separate, so
     * a tag cannot be carried both ways at once -- the case the old wording had to hedge
     * about ("false when the library carries it too") can no longer arise (§6).
     */
    private: z.boolean(),
    /** The tag's picture, which the item's tags show in place of a chip when there is one. */
    picture: tagPictureSchema.nullable().optional(),
});
export type MediaTag = z.infer<typeof mediaTagSchema>;

/**
 * One facet's values with counts, for the filter panel (§5c, §20).
 *
 * **The list is the vocabulary, the counts are the filter.** Which values exist comes from
 * the `Tag` table, so it is complete and cannot depend on how large the library is; what each
 * one holds *right now* is counted against the current filter, exactly, so the panel still
 * says which values would dead-end rather than finding out by clicking.
 *
 * It used to be one question rather than two: values were discovered by scanning the filtered
 * media and grouping, which is proportional to the library and therefore had to be capped.
 * Past the cap the list was a sample — a tag applied to one item simply was not offered, with
 * nothing on screen to say a value had been left out.
 */
/**
 * Reading one system's whole vocabulary, for the management screen (§6).
 *
 * Paged, searched and filtered on the server. The alternative — fetch every tag and filter in
 * the browser — is fine at fifty tags and not at the several thousand a performer facet reaches
 * on a real library, which is the size this screen exists to make manageable.
 */
export const vocabularyQuerySchema = z.object({
    scope: tagScopeSchema,
    kind: facetKindSchema.optional(),
    search: z.string().trim().max(200).optional(),
    /** Only tags nothing carries. The cleanup case, and the one a count-ordered list hides. */
    unusedOnly: z.coerce.boolean().optional(),
    /** Most-carried first, or by name. Name by default: this is a list to find a tag in. */
    sort: z.enum(["count", "name"]).default("name"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});
export type VocabularyQuery = z.infer<typeof vocabularyQuerySchema>;

export const vocabularyResponseSchema = z.object({
    tags: z.array(tagSchema),
    /** Matching tags before the page, so the pager knows how many pages there are. */
    total: z.number(),
});
export type VocabularyResponse = z.infer<typeof vocabularyResponseSchema>;

/**
 * Every facet that has a tag in it, known ones first (`GET /api/tags` with no `kind`).
 *
 * What the management screen builds its sections from, so a facet a scraper invented still
 * gets one: a tag that cannot be seen is a tag nobody can remove.
 */
export const facetKindsResponseSchema = z.object({
    kinds: z.array(z.string()),
});
export type FacetKindsResponse = z.infer<typeof facetKindsResponseSchema>;

/** What a retroactive vocabulary change actually did, so the UI can report it. */
export const tagChangeResultSchema = z.object({
    /** Items whose tags changed. Zero is a real answer, not a failure. */
    affected: z.number(),
    /**
     * Aliases a publish or unpublish had to leave behind, because the vocabulary the tag moved
     * into already gives those names to other tags (§5b "Aliases"). Absent when none were.
     */
    aliasesDropped: z.number().optional(),
});
export type TagChangeResult = z.infer<typeof tagChangeResultSchema>;

export const facetValueSchema = z.object({
    tagId: z.string(),
    name: z.string(),
    colorKey: z.string().nullable(),
    /**
     * How many items the current filter would leave carrying this value. Exact.
     *
     * Zero is a real answer and is shown rather than hidden: with AND semantics a filter can
     * exclude everything a value is on, and "Noir (0)" is how somebody understands why the
     * grid is empty and what to click to fix it. Dropping the row instead would make the
     * value disappear from a list that is otherwise complete, which is the one thing the
     * vocabulary-sourced list exists to prevent.
     */
    count: z.number(),
});

/**
 * Values per facet when one has been expanded (§5c).
 *
 * The collapsed twenty is a suggestion of what to click next; this is the answer to "show me
 * the rest", and it is a ceiling rather than "all" on purpose. A facet can hold thousands of
 * values, and thousands of chips is not a list anybody reads — it is a slow page. Past this
 * the panel keeps saying how many it is not showing, which is the honest version of the same
 * information.
 */
export const FACET_EXPANDED_LIMIT = 500;

export const facetSchema = z.object({
    kind: z.string(),
    /**
     * Which system this facet's values were counted in (§6).
     *
     * On the facet rather than on each value, because a facet is counted within one system:
     * a public count is library assignments only, so it is the same number for everybody,
     * and a private count is the viewer's own. Mixing them is what used to make one chip
     * mean two things and one number differ per viewer.
     */
    scope: tagScopeSchema,
    values: z.array(facetValueSchema),
    /**
     * Whether values were cut off by the response limit.
     *
     * A performer facet on a real library has thousands of entries. The panel shows the top
     * few and says so; without this flag it would silently imply the list is complete.
     */
    truncated: z.boolean(),
    /**
     * Distinct values this facet's vocabulary holds, before any cap.
     *
     * Carried so "show all" can say what "all" is. A control that offers to expand a list
     * without saying how long it is asks somebody to agree to an unknown amount of scrolling
     * — and the number is already computed for `truncated`, so declining to send it was
     * withholding something free.
     *
     * Counted over the vocabulary rather than over the current filter, which is what makes it
     * a number the list can be trusted against: it is how many values the *panel* could show,
     * not how many the filter reaches. Values the filter reaches are what `count` says, one
     * chip at a time.
     */
    total: z.number(),
    /**
     * The Favourites ♥ chip (§14e), or null when the viewer has no favourites of this facet --
     * the cue to leave the chip out rather than draw one that can only ever say nought.
     *
     * Two numbers, and the chip says both with their units ("2 favourite performers · 3
     * items"). It used to say one, in brackets like every other chip, and beside "brian (3)"
     * a "Favourites ♥ (3)" read as "you have three favourites" -- the one thing it did not
     * mean. `items` is counted like the facet's other chips: without the facet's own group, so
     * it says what choosing the chip shows, or under "without" how many it is hiding.
     *
     * Set on one facet per kind, the first drawn (the public one where both exist), because
     * the chip means every favourite of the kind whichever system it is in.
     */
    favorites: z
        .object({
            /** Favourite tags of this facet the viewer has, that they can see. */
            tags: z.number(),
            /** Items under the current filter carrying any of them. */
            items: z.number(),
        })
        .nullable(),
});
export type Facet = z.infer<typeof facetSchema>;

/** What a filter's tag ids name, for chips and the Advanced editor (§14e). */
export const referencedTagSchema = z.object({
    name: z.string(),
    kind: z.string(),
    private: z.boolean(),
});
export type ReferencedTag = z.infer<typeof referencedTagSchema>;

export const facetsResponseSchema = z.object({
    facets: z.array(facetSchema),
    /**
     * Every tag the filter names -- with, without, or in a group -- that the viewer can see.
     *
     * The address carries ids, which nobody can read; this is how a chip says "without
     * Grandma" rather than "without 3f2a…". An id missing from it is a tag that has gone, or
     * one that is not the viewer's to see, and is drawn as such.
     */
    referencedTags: z.record(z.string(), referencedTagSchema),
});
export type FacetsResponse = z.infer<typeof facetsResponseSchema>;
