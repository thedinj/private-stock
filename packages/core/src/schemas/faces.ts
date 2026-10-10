import { z } from "zod";

import { mediaKindCountsSchema, mediaKindSchema } from "../domain.js";
import { mentionFields } from "../ocrTagMatch.js";
import { spriteRectSchema } from "./clips.js";
import { mediaListItemSchema } from "./media.js";
import { tagNameSchema } from "./tags.js";

/**
 * What a performer's page says about faces, and what may be said back (§5f "Starting from the
 * performer").
 */

/**
 * A face, cropped out of a picture the browser can already fetch: a sprite sheet for a video,
 * the cover for a photograph. A square around the face, so a row of them lines up.
 */
export const faceCropSchema = z.object({
    url: z.string(),
    rect: spriteRectSchema,
    /** The whole picture the face was found in — the tile, or the cover — for a closer look. */
    frame: spriteRectSchema,
});
export type FaceCrop = z.infer<typeof faceCropSchema>;

/** A face as a list shows it: the crop, and the item and moment it opens. */
export const faceReviewFaceSchema = z.object({
    /** The face itself: what its likeness is asked about by. */
    id: z.string(),
    crop: faceCropSchema,
    mediaId: z.string(),
    kind: z.enum(["video", "image"]),
    atMs: z.number().nullable(),
    /**
     * Where the face is, as fractions of the frame: what a tag's picture is framed around when it
     * is chosen from this face (§6 "A tag's picture").
     */
    box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
});
export type FaceReviewFace = z.infer<typeof faceReviewFaceSchema>;

/**
 * Every face confirmed as a performer, a page at a time, largest first: what their picture is
 * chosen from (§6 "A tag's picture"). Every moment, not one an item: the best picture of somebody
 * is often a second look in the same video.
 */
export const confirmedFacesQuerySchema = z.object({
    page: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(96).default(48),
});
export type ConfirmedFacesQuery = z.infer<typeof confirmedFacesQuerySchema>;

export const confirmedFacesPageSchema = z.object({
    faces: z.array(faceReviewFaceSchema),
    hasMore: z.boolean(),
    total: z.number(),
});
export type ConfirmedFacesPage = z.infer<typeof confirmedFacesPageSchema>;

/**
 * Why a group is on a performer's page: somebody said these faces are them (`confirmed`), or
 * the items they are on are tagged with them (`proposed`).
 */
export const faceGroupStateSchema = z.enum(["confirmed", "proposed"]);
export type FaceGroupState = z.infer<typeof faceGroupStateSchema>;

/**
 * Why a group might be a performer anywhere it is asked about: confirmed, proposed by their tags,
 * or `resembles` — no tags or decisions of its own, but like a group confirmed as them (§5f
 * "Groups of one person").
 */
export const faceMatchStateSchema = z.enum(["confirmed", "proposed", "resembles"]);
export type FaceMatchState = z.infer<typeof faceMatchStateSchema>;

/** "No single face", said of a performer, or taken back (§5f). */
export const noSingleFaceSchema = z.object({ noSingleFace: z.boolean() });
export type NoSingleFace = z.infer<typeof noSingleFaceSchema>;

/**
 * One item on a performer's "Likely" list, with the evidence for it (§5f): a face in one of
 * their groups, the name in its filename, title or burned-in text — any of those, best first.
 */
export const likelyItemSchema = z.object({
    item: mediaListItemSchema,
    /** The strongest face evidence: a face in a group confirmed, proposed or like theirs. */
    face: faceMatchStateSchema.nullable(),
    /** That face, to compare with "Their face". */
    crop: faceCropSchema.nullable(),
    /** Where the name was found on the item, if anywhere. */
    mentions: z.array(z.enum(mentionFields)),
});
export type LikelyItem = z.infer<typeof likelyItemSchema>;

export const likelyQuerySchema = z.object({
    page: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(60).default(24),
});
export type LikelyQuery = z.infer<typeof likelyQuerySchema>;

export const likelyPageSchema = z.object({
    items: z.array(likelyItemSchema),
    hasMore: z.boolean(),
    total: z.number(),
    /** Untagged items with only their name: what "Find untagged" opens. */
    nameOnly: z.number(),
});
export type LikelyPage = z.infer<typeof likelyPageSchema>;

/**
 * Answering a "Likely" list: tag items with the performer, as one batch that can be undone, or
 * say an item's face is not them.
 */
export const likelyDecisionSchema = z.discriminatedUnion("verdict", [
    z.object({ verdict: z.literal("add"), mediaIds: z.array(z.string().min(1)).min(1).max(200) }),
    /** Every item the list holds, as the server counts it — not what happens to be loaded. */
    z.object({ verdict: z.literal("addAll") }),
    /** Not them: the item's faces in their groups, and its name match, both refused. */
    z.object({ verdict: z.literal("refuse"), mediaId: z.string().min(1) }),
]);
export type LikelyDecision = z.infer<typeof likelyDecisionSchema>;

/**
 * Review › Faces (§5f "One review, two sources"): face groups across the whole library, one row a
 * group. **Matches** are groups that are, or might be, a performer, with items not tagged with
 * them yet; **Unnamed** are the largest groups nobody's tags or decisions point anywhere.
 */
export const faceReviewTabSchema = z.enum(["matches", "unnamed"]);
export type FaceReviewTab = z.infer<typeof faceReviewTabSchema>;

export const faceReviewRowSchema = z.object({
    groupId: z.string(),
    /**
     * The faces being decided about: one an item, on the items a decision would tag — on
     * Matches, those not carrying the performer yet; on Unnamed, all of them. Largest first.
     */
    faces: z.array(faceReviewFaceSchema),
    /** Items like those past the ones shown, which come back as the row once these are decided. */
    more: z.number(),
    /**
     * Its faces hold together loosely (`LOOSE_GROUP`): perhaps several people, faces turned away or
     * obscured. Asked about last, and marked so.
     */
    loose: z.boolean(),
    /** On Matches, a few faces from items already tagged with the performer, to compare with. */
    reference: z.array(faceReviewFaceSchema),
    faceCount: z.number(),
    itemCount: z.number(),
    /** Who the group is, or might be, on Matches; null on Unnamed. */
    candidate: z
        .object({
            tagId: z.string(),
            name: z.string(),
            state: faceMatchStateSchema,
            /** Items in the group not tagged with them yet. */
            untagged: z.number(),
            /**
             * Their picture, small, to compare the faces with (§6 "A tag's picture"); null when
             * they have none.
             */
            pictureUrl: z.string().nullable(),
        })
        .nullable(),
});
export type FaceReviewRow = z.infer<typeof faceReviewRowSchema>;

export const faceReviewQuerySchema = z.object({
    tab: faceReviewTabSchema.default("matches"),
    /** Matches for one performer only, from their page. */
    performer: z.string().min(1).max(64).optional(),
    /**
     * The visit's list, from its first page (§5f "A list that holds still"): later pages are
     * slices of it, in the order it had. Made afresh when absent or no longer kept.
     */
    list: z.string().min(1).max(64).optional(),
    /**
     * Ask only about faces on videos, or on photos; both when absent. Which group is whose is
     * still judged from every item — this narrows what a row asks, not what decides it.
     */
    media: mediaKindSchema.optional(),
    page: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type FaceReviewQuery = z.infer<typeof faceReviewQuerySchema>;

export const faceReviewPageSchema = z.object({
    /** The list this page is a slice of: what the next page asks for. */
    list: z.string(),
    rows: z.array(faceReviewRowSchema),
    /** The performer Matches is narrowed to, by name, for the page to say so. */
    performer: z.object({ id: z.string(), name: z.string() }).nullable(),
    hasMore: z.boolean(),
    total: z.number(),
    /** Rows this tab would have under Videos and under Photos: the counts on the kind control. */
    byMedia: mediaKindCountsSchema,
});
export type FaceReviewPage = z.infer<typeof faceReviewPageSchema>;

/** The items a row's decision is about: those ticked, and those shown and unticked. */
const shownItems = {
    groupId: z.string().min(1).max(64),
    mediaIds: z.array(z.string().min(1).max(64)).min(1).max(100),
    /** Shown and unticked: "not them", once there is a them. */
    excludedMediaIds: z.array(z.string().min(1).max(64)).max(100).default([]),
    /** Shown and marked unsure: left undecided, to be asked about again later (§5f "Unsure"). */
    unsureMediaIds: z.array(z.string().min(1).max(64)).max(100).default([]),
    /** Every face that was on screen, ticked or not: decided as `shown`, the rest `inferred`. */
    shownFaceIds: z.array(z.string().min(1).max(64)).max(100).default([]),
};

/**
 * Answering a row. `accept` tags the ticked items as the performer, as one batch the undo list
 * can withdraw, confirms their faces, and refuses the unticked ones; `refuse` says the whole
 * group is not them; `name` does what `accept` does for a performer typed in — coined if new —
 * after refusing `instead`, the one proposed, for the ticked items; `skip` is "can't tell".
 */
export const faceReviewDecisionSchema = z.discriminatedUnion("verdict", [
    z.object({ verdict: z.literal("accept"), tagId: z.string().min(1).max(64), ...shownItems }),
    z.object({
        verdict: z.literal("refuse"),
        groupId: z.string().min(1).max(64),
        tagId: z.string().min(1).max(64),
        shownFaceIds: z.array(z.string().min(1).max(64)).max(100).default([]),
    }),
    z.object({
        verdict: z.literal("name"),
        name: tagNameSchema,
        /** The one proposed, refused for the ticked items: they are someone else. */
        instead: z.string().min(1).max(64).optional(),
        ...shownItems,
    }),
    /** "Not one person": the group's undecided faces out of grouping for good (§5f "Grab bags"). */
    z.object({
        verdict: z.literal("scatter"),
        groupId: z.string().min(1).max(64),
    }),
    /** "Can't tell", of an unnamed group's faces on these items. */
    z.object({
        verdict: z.literal("skip"),
        groupId: z.string().min(1).max(64),
        mediaIds: z.array(z.string().min(1).max(64)).min(1).max(100),
    }),
]);
export type FaceReviewDecision = z.infer<typeof faceReviewDecisionSchema>;

/** What a decision did, for the line that says so. */
export const faceReviewResultSchema = z.object({
    name: z.string().nullable(),
    tagged: z.number(),
    coined: z.boolean(),
});
export type FaceReviewResult = z.infer<typeof faceReviewResultSchema>;

/**
 * How alike each of a row's faces is to the person it is asked about (§5f "Checking faces
 * quickly"): to the performer's confirmed faces where there are some, else to the row's own
 * faces. The row shows the least alike first, flagged below `doubt`.
 */
export const faceLikenessQuerySchema = z.object({
    groupId: z.string().min(1).max(64),
    tagId: z.string().min(1).max(64).optional(),
    ids: z
        .string()
        .max(24 * 40)
        .transform((value) => value.split(",").filter(Boolean))
        .pipe(z.array(z.string().min(1).max(64)).min(1).max(24)),
});
export type FaceLikenessQuery = z.infer<typeof faceLikenessQuerySchema>;

export const faceLikenessSchema = z.object({
    /** By face id; a face whose vector cannot be read is absent. */
    scores: z.record(z.string(), z.number()),
    /** Whether the scores are against the performer's confirmed faces, not the row's own. */
    anchored: z.boolean(),
    doubt: z.number(),
});
export type FaceLikeness = z.infer<typeof faceLikenessSchema>;

/** A closer look at one face: the item's other faces in the same group — other moments of them. */
export const facePeekQuerySchema = z.object({
    groupId: z.string().min(1).max(64),
    mediaId: z.string().min(1).max(64),
});
export type FacePeekQuery = z.infer<typeof facePeekQuerySchema>;

export const facePeekSchema = z.object({ faces: z.array(faceReviewFaceSchema) });
export type FacePeek = z.infer<typeof facePeekSchema>;

/**
 * Tagging by itself (§5f "Tagging by itself"): what the rule would tag, to be checked before it
 * tags anything — `proposed`, in a random order so a sample is a fair one — and what was checked.
 */
export const autoTagStateSchema = z.enum(["proposed", "right", "wrong", "applied", "removed"]);
export type AutoTagState = z.infer<typeof autoTagStateSchema>;

export const autoTagQuerySchema = z.object({
    state: autoTagStateSchema.default("proposed"),
    /** The order a visit sees, so a sample is random but pages do not reshuffle under it. */
    seed: z.coerce
        .number()
        .int()
        .min(0)
        .max(2 ** 31)
        .default(0),
    page: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(60).default(24),
});
export type AutoTagQuery = z.infer<typeof autoTagQuerySchema>;

export const autoTagEntrySchema = z.object({
    item: mediaListItemSchema,
    tagId: z.string(),
    name: z.string(),
    /** The face that matched them best, to check it by. */
    face: faceReviewFaceSchema.nullable(),
    score: z.number(),
    strongFaces: z.number(),
    named: z.boolean(),
    state: autoTagStateSchema,
});
export type AutoTagEntry = z.infer<typeof autoTagEntrySchema>;

export const autoTagPageSchema = z.object({
    rows: z.array(autoTagEntrySchema),
    hasMore: z.boolean(),
    total: z.number(),
    /** Every state's count: how much was checked, and how much of it was right. */
    counts: z.object({
        proposed: z.number(),
        right: z.number(),
        wrong: z.number(),
        applied: z.number(),
        removed: z.number(),
    }),
    /** Whether faces tag by themselves, since when — and whether what was taken back stopped it. */
    enabled: z.boolean(),
    since: z.string().nullable(),
    braked: z.boolean(),
});
export type AutoTagPage = z.infer<typeof autoTagPageSchema>;

export const autoTagDecisionSchema = z.object({
    mediaId: z.string().min(1).max(64),
    tagId: z.string().min(1).max(64),
    verdict: z.enum(["right", "wrong"]),
});
export type AutoTagDecision = z.infer<typeof autoTagDecisionSchema>;

/** Letting faces tag by themselves, or stopping them. */
export const autoTagSwitchSchema = z.object({ enabled: z.boolean() });
export type AutoTagSwitch = z.infer<typeof autoTagSwitchSchema>;

/**
 * "Maybe in this item" (§5f "In the viewer"): library performers an item does not carry, whose face
 * looks like a face in it, or whose name it shows — with the face, to jump to and compare.
 */
export const itemSuspectSchema = z.object({
    tagId: z.string(),
    name: z.string(),
    /** Their best-matching face in the item, if a face put them here. */
    face: faceReviewFaceSchema.nullable(),
    /** That face's likeness to their reference. */
    score: z.number().nullable(),
    /** Faces at different moments that match them strongly (`AUTO_TAG_LINE`). */
    strongFaces: z.number(),
    /** Where their name is on the item. */
    mentions: z.array(z.enum(mentionFields)),
});
export type ItemSuspect = z.infer<typeof itemSuspectSchema>;

export const itemSuspectsSchema = z.object({ suspects: z.array(itemSuspectSchema) });
export type ItemSuspects = z.infer<typeof itemSuspectsSchema>;

/** "Add" them to the item, or "Not them". */
export const itemSuspectDecisionSchema = z.object({
    tagId: z.string().min(1).max(64),
    verdict: z.enum(["add", "refuse"]),
    /** The face shown with them: confirmed as theirs on "Add". */
    faceId: z.string().min(1).max(64).nullable().default(null),
});
export type ItemSuspectDecision = z.infer<typeof itemSuspectDecisionSchema>;

/**
 * History (§5f "Decisions you can take back"): every face decision, newest first — by a person or
 * by the app tagging by itself — each with what it wrote, and undoable.
 */
export const faceDecisionActorSchema = z.enum(["user", "app"]);
export const faceDecisionVerdictSchema = z.enum(["is", "isNot", "notOnePerson", "later"]);
export type FaceDecisionVerdict = z.infer<typeof faceDecisionVerdictSchema>;

export const faceHistoryQuerySchema = z.object({
    /** Whose decisions: everybody's, the people's, or the app's own. */
    actor: z.enum(["all", "user", "app"]).default("all"),
    /** One performer's decisions only. */
    tagId: z.string().min(1).max(64).optional(),
    /** The page after this decision: its `createdAt` and id, as `next` gave them. */
    before: z.string().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
});
export type FaceHistoryQuery = z.infer<typeof faceHistoryQuerySchema>;

export const faceHistoryEntrySchema = z.object({
    id: z.string(),
    actor: faceDecisionActorSchema,
    verdict: faceDecisionVerdictSchema,
    /** Where it was said: "review", "performer", "item", "wouldTag", "untag", "auto", … */
    surface: z.string(),
    /** Who it was about; null for "can't tell" and "not one person", or a performer since deleted. */
    performer: z.object({ id: z.string(), name: z.string() }).nullable(),
    faceCount: z.number(),
    itemCount: z.number(),
    /** A few of the faces it still holds, the largest first. */
    faces: z.array(faceReviewFaceSchema),
    /** Whether it made tags (a batch the undo takes back with it). */
    tagged: z.boolean(),
    createdAt: z.string(),
    undoneAt: z.string().nullable(),
});
export type FaceHistoryEntry = z.infer<typeof faceHistoryEntrySchema>;

export const faceHistoryPageSchema = z.object({
    entries: z.array(faceHistoryEntrySchema),
    /** What to ask for the next page with; null at the end. */
    next: z.string().nullable(),
});
export type FaceHistoryPage = z.infer<typeof faceHistoryPageSchema>;

/**
 * Undo a decision: everything it wrote that still stands is taken back, its tags with it. `wrong`
 * is for the app's own: also "not them" on those items, so it never tags them again, and counted
 * against tagging by itself.
 */
export const faceUndoSchema = z.object({ wrong: z.boolean().default(false) });
export type FaceUndo = z.infer<typeof faceUndoSchema>;

/**
 * Suggestions (§5f "Suggestions"): people in items — one person in one item, an appearance — that
 * look clearly like a performer, by performer. What replaces Matches.
 */
export const suggestionPerformersQuerySchema = z.object({ media: mediaKindSchema.optional() });
export type SuggestionPerformersQuery = z.infer<typeof suggestionPerformersQuerySchema>;

export const suggestionPerformersSchema = z.object({
    performers: z.array(
        z.object({
            tagId: z.string(),
            name: z.string(),
            pictureUrl: z.string().nullable(),
            count: z.number(),
        })
    ),
});
export type SuggestionPerformers = z.infer<typeof suggestionPerformersSchema>;

export const suggestionsQuerySchema = z.object({
    tagId: z.string().min(1).max(64),
    media: mediaKindSchema.optional(),
    /** The page after this suggestion: its score and id, as `next` gave them. */
    after: z.string().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(60).default(24),
});
export type SuggestionsQuery = z.infer<typeof suggestionsQuerySchema>;

export const suggestionSchema = z.object({
    /** The appearance: one person in one item. */
    id: z.string(),
    mediaId: z.string(),
    kind: mediaKindSchema,
    title: z.string(),
    /** How many of the item's faces are this person. */
    moments: z.number(),
    /** Their clearest face: what the card shows. */
    face: faceReviewFaceSchema,
    /** A few more of their faces in the item, for a closer look. */
    others: z.array(faceReviewFaceSchema),
    /** Every face of theirs in the item: what a decision is about. */
    faceIds: z.array(z.string()),
    score: z.number(),
    /** The item's own text names them too. */
    named: z.boolean(),
});
export type Suggestion = z.infer<typeof suggestionSchema>;

export const suggestionsPageSchema = z.object({
    performer: z.object({ id: z.string(), name: z.string(), pictureUrl: z.string().nullable() }),
    suggestions: z.array(suggestionSchema),
    next: z.string().nullable(),
});
export type SuggestionsPage = z.infer<typeof suggestionsPageSchema>;

/**
 * Saying who people in items are, a page of cards at once: one decision. `is` tags the items and
 * confirms the person's faces; `isNot` refuses them for the performer — that person only, not the
 * item, which may hold them elsewhere. Cards left unsure are not sent.
 */
export const suggestionDecisionSchema = z.object({
    tagId: z.string().min(1).max(64),
    people: z
        .array(
            z.object({
                mediaId: z.string().min(1).max(64),
                faceIds: z.array(z.string().min(1).max(64)).min(1).max(24),
                shownFaceId: z.string().min(1).max(64),
                verdict: z.enum(["is", "isNot"]),
            })
        )
        .min(1)
        .max(60),
});
export type SuggestionDecision = z.infer<typeof suggestionDecisionSchema>;

/**
 * A performer's Faces tab (§5f "Their faces"): their confirmed people, their own items with
 * nobody confirmed to pick from, and the people ruled out — every one a card, each correctable.
 */
export const personCardSchema = z.object({
    /** What the card is: an appearance, or an item's person as decided. */
    id: z.string(),
    mediaId: z.string(),
    kind: mediaKindSchema,
    title: z.string(),
    moments: z.number(),
    face: faceReviewFaceSchema,
    others: z.array(faceReviewFaceSchema),
    /** Every face of theirs on the item the card speaks for. */
    faceIds: z.array(z.string()),
});
export type PersonCard = z.infer<typeof personCardSchema>;

export const performerPeopleQuerySchema = z.object({
    section: z.enum(["confirmed", "items", "ruledOut"]),
    /** Ruled out: also the faces refused along with others, nobody saw. */
    all: z.coerce.boolean().default(false),
    page: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(60).default(24),
});
export type PerformerPeopleQuery = z.infer<typeof performerPeopleQuerySchema>;

export const performerPeoplePageSchema = z.object({
    /** Confirmed and ruled out: a card an item. Their items: an item's people, to pick one. */
    groups: z.array(
        z.object({ mediaId: z.string(), title: z.string(), people: z.array(personCardSchema) })
    ),
    hasMore: z.boolean(),
    total: z.number(),
    /** Said to have no single face (§5f): face matching leaves them out. */
    noSingleFace: z.object({ since: z.string() }).nullable(),
});
export type PerformerPeoplePage = z.infer<typeof performerPeoplePageSchema>;

/**
 * What a performer's Faces tab says, a page of cards at once: one decision, except a restore.
 * `takeBack` — confirmed but not them; `pick` — this person on their item is them; `restore` —
 * ruled out by mistake, undecided again.
 */
export const performerPeopleDecisionSchema = z.object({
    action: z.enum(["takeBack", "pick", "restore"]),
    people: z
        .array(
            z.object({
                mediaId: z.string().min(1).max(64),
                faceIds: z.array(z.string().min(1).max(64)).min(1).max(24),
                shownFaceId: z.string().min(1).max(64),
            })
        )
        .min(1)
        .max(60),
});
export type PerformerPeopleDecision = z.infer<typeof performerPeopleDecisionSchema>;
