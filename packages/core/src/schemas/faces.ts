import { z } from "zod";

import { mediaKindSchema } from "../domain.js";
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
 * The frames a face's moment may really be (§9 "What a tile shows"): a face is found on a sprite
 * tile, and a tile's picture is seldom the frame its time names. Asked of a video's face by its
 * `atMs`.
 */
export const faceMomentsQuerySchema = z.object({
    at: z.coerce.number().int().min(0),
});
export type FaceMomentsQuery = z.infer<typeof faceMomentsQuerySchema>;

export const faceMomentsSchema = z.object({
    /** Earliest first: each frame's time, for `?at=` on the still, and a thumbnail of it. */
    moments: z.array(z.object({ atMs: z.number().int(), thumbUrl: z.string() })),
    /** The one that looks most like the tile the face was found on; null with no tile to ask. */
    matched: z.number().int().nullable(),
});
export type FaceMoments = z.infer<typeof faceMomentsSchema>;

/** "No single face", said of a performer, or taken back (§5f). */
export const noSingleFaceSchema = z.object({ noSingleFace: z.boolean() });
export type NoSingleFace = z.infer<typeof noSingleFaceSchema>;

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
    /** Their picture, beside the name: who the face is being compared with. */
    pictureUrl: z.string().nullable(),
    /** The face that matched them best, to check it by. */
    face: faceReviewFaceSchema.nullable(),
    /** The same person's other moments in the item, for the closer look. */
    others: z.array(faceReviewFaceSchema),
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
    /**
     * The rule's trial (§5f "Tagging by itself"): how many of its own proposals were checked right
     * and wrong, and how many right with none wrong let it tag by itself.
     */
    trial: z.object({ right: z.number(), wrong: z.number(), needed: z.number() }),
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

/**
 * A performer's face from a few of their items, beside one that may be them (§5f "Suggestions").
 * `confirmed` false: nobody has confirmed a face of theirs, and these are the people most like them
 * on items tagged with them.
 */
export const faceComparisonSchema = z.object({
    faces: z.array(faceReviewFaceSchema),
    confirmed: z.boolean(),
});
export type FaceComparison = z.infer<typeof faceComparisonSchema>;

/**
 * People in this item (§5f "People in this item"): every person in it, each with what is known —
 * confirmed by you or tagged by the app, suggested, or nobody yet — and the performers its own
 * text names who are not on it. What replaces "Maybe in this item".
 */
export const itemPeopleSchema = z.object({
    people: z.array(
        z.object({
            card: personCardSchema,
            state: z.enum(["confirmed", "suggested", "unknown"]),
            /** Who: confirmed as, or suggested; with their picture, to compare the face with. */
            performer: z
                .object({ id: z.string(), name: z.string(), pictureUrl: z.string().nullable() })
                .nullable(),
            /** Confirmed, and the item's tag was made by the app's own matching. */
            byApp: z.boolean(),
            /** The item already carries them. */
            tagged: z.boolean(),
        })
    ),
    named: z.array(
        z.object({
            tagId: z.string(),
            name: z.string(),
            fields: z.array(z.enum(mentionFields)),
        })
    ),
});
export type ItemPeople = z.infer<typeof itemPeopleSchema>;

const itemPerson = z.object({
    faceIds: z.array(z.string().min(1).max(64)).min(1).max(24),
    shownFaceId: z.string().min(1).max(64),
});

/**
 * What the item's page says of a person in it, or of a performer its text names: one decision.
 * `is` tags the item if it does not carry them and confirms the person's faces; `isNot` refuses
 * the person for them, taking back a confirmation; `name` is `is` for a name typed, coined if new;
 * `addNamed` tags a performer the text names; `refuseNamed` is "not them" on the item.
 */
export const itemPeopleDecisionSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("is"), tagId: z.string().min(1).max(64), person: itemPerson }),
    z.object({ action: z.literal("isNot"), tagId: z.string().min(1).max(64), person: itemPerson }),
    z.object({ action: z.literal("name"), name: tagNameSchema, person: itemPerson }),
    z.object({ action: z.literal("addNamed"), tagId: z.string().min(1).max(64) }),
    z.object({ action: z.literal("refuseNamed"), tagId: z.string().min(1).max(64) }),
]);
export type ItemPeopleDecision = z.infer<typeof itemPeopleDecisionSchema>;

/**
 * New people (§5f "New people"): people in items who match nobody known, gathered across the
 * library, a few cards each. What replaces Unnamed.
 */
export const newPeopleQuerySchema = z.object({
    page: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(20).default(6),
});
export type NewPeopleQuery = z.infer<typeof newPeopleQuerySchema>;

export const newPeoplePageSchema = z.object({
    people: z.array(
        z.object({
            /** The gathering: made anew each references run, so only good for this visit. */
            id: z.string(),
            /** Items it is on; its cards are a few of them. */
            items: z.number(),
            cards: z.array(personCardSchema),
        })
    ),
    hasMore: z.boolean(),
    total: z.number(),
});
export type NewPeoplePage = z.infer<typeof newPeoplePageSchema>;

const newPeoplePeople = z
    .array(
        z.object({
            mediaId: z.string().min(1).max(64),
            faceIds: z.array(z.string().min(1).max(64)).min(1).max(24),
            shownFaceId: z.string().min(1).max(64),
        })
    )
    .min(1)
    .max(20);

/**
 * What is said of a new person's cards, those ticked: `name` — they are this performer, coined if
 * new: their items tagged and their faces confirmed; `notOnePerson` — out of every gathering for
 * good; `later` — set aside. One decision.
 */
export const newPeopleDecisionSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("name"), name: tagNameSchema, people: newPeoplePeople }),
    z.object({ action: z.literal("notOnePerson"), people: newPeoplePeople }),
    z.object({ action: z.literal("later"), people: newPeoplePeople }),
]);
export type NewPeopleDecision = z.infer<typeof newPeopleDecisionSchema>;

/**
 * Who is this? (§5f "Who is this?"): the faces on the frame on screen, read by the worker, and for
 * each the items across the library whose faces are most like it.
 */
export const faceSearchStateSchema = z.enum(["pending", "running", "done", "failed"]);
export type FaceSearchState = z.infer<typeof faceSearchStateSchema>;

export const faceSearchStartSchema = z.object({
    mediaId: z.string().min(1).max(64),
    atMs: z.number().int().min(0),
});
export type FaceSearchStart = z.infer<typeof faceSearchStartSchema>;

const faceBoxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

/** What the worker stores: each face on the frame, and the stored faces nearest it. */
export const storedFaceSearchSchema = z.array(
    faceBoxSchema.extend({
        /**
         * The stored face in the item asked from that is this one, if any is near enough: whose
         * person naming it confirms there. Absent from searches made before it was kept.
         */
        self: z.object({ vectorIndex: z.number(), score: z.number() }).nullable().optional(),
        matches: z.array(
            z.object({ mediaId: z.string(), vectorIndex: z.number(), score: z.number() })
        ),
    })
);
export type StoredFaceSearch = z.infer<typeof storedFaceSearchSchema>;

export const faceSearchSchema = z.object({
    id: z.string(),
    state: faceSearchStateSchema,
    error: z.string().nullable(),
    /** The faces found, as fractions of the frame, left to right. */
    faces: z.array(faceBoxSchema),
});
export type FaceSearch = z.infer<typeof faceSearchSchema>;

export const faceSearchMatchesSchema = z.object({
    matches: z.array(
        z.object({
            face: faceReviewFaceSchema,
            title: z.string(),
            score: z.number(),
            /** Who the face is confirmed as, if anybody. */
            confirmed: z.object({ tagId: z.string(), name: z.string() }).nullable(),
            /** The item's performers, by name. */
            performers: z.array(z.string()),
            /** The same person's other moments in the item, for the closer look. */
            others: z.array(faceReviewFaceSchema),
            /** Every face of that person in the item: what saying who they are is about. */
            faceIds: z.array(z.string()),
        })
    ),
});
export type FaceSearchMatches = z.infer<typeof faceSearchMatchesSchema>;

/**
 * Who is this?, named (§5f): the person on the frame is this performer — picked, or coined with the
 * typo check — and so is each candidate said to be them; those said not to be them are refused for
 * the performer. The video asked from is always tagged.
 */
export const faceSearchNameSchema = z.object({
    performer: z.discriminatedUnion("by", [
        z.object({ by: z.literal("name"), name: tagNameSchema }),
        z.object({ by: z.literal("id"), tagId: z.string().min(1).max(64) }),
    ]),
    people: z
        .array(
            z.object({
                mediaId: z.string().min(1).max(64),
                faceIds: z.array(z.string().min(1).max(64)).min(1).max(24),
                shownFaceId: z.string().min(1).max(64),
                verdict: z.enum(["is", "isNot"]),
            })
        )
        .max(100),
});
export type FaceSearchName = z.infer<typeof faceSearchNameSchema>;
