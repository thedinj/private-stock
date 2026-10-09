import { z } from "zod";

import { mediaKindCountsSchema, mediaKindSchema } from "../domain.js";
import { bulkActionFailureSchema } from "./bulkActions.js";
import { mediaListItemSchema } from "./media.js";

/**
 * The duplicate review contract (§10).
 *
 * A group is shown side by side with the numbers that decide which copy is worth keeping, so
 * the response carries those numbers rather than making the client fetch each item's detail
 * — a group of four would otherwise be five requests to render one row.
 *
 * It also carries the *argument*: which copy to keep, why, and what each of the others would
 * cost (§10c). Members arrive best-first, because the order a group is read in is itself a
 * recommendation — unordered, the reviewer compares six numbers across four cards before
 * learning what the app would have done.
 */

export const dupeMemberSchema = mediaListItemSchema.extend({
    relPath: z.string(),
    rootLabel: z.string(),
    /** Whether the root is flagged writable, and so whether this copy could be removed. */
    deletable: z.boolean(),
    bitrate: z.number().nullable(),
    codec: z.string().nullable(),
    /**
     * What keeping this copy instead of the recommended one would cost, in words.
     *
     * Null on the recommended copy itself, and on one that is genuinely indistinguishable
     * from it. Phrased by the server so the queue and the delete confirmation cannot come to
     * different conclusions about the same pair (§10c).
     */
    costOfKeeping: z.string().nullable(),
    /**
     * Clips cut from this copy, by anybody.
     *
     * Counted rather than named because the screen only has to know whether trashing the copy
     * costs any: clips are the one thing a merge does not carry (§10c), so a row whose doomed
     * copies hold some starts unticked. Which copies are doomed depends on the keeper, which
     * the reviewer can change, so the count is per copy and the caution is drawn on the client.
     */
    clipCount: z.number(),
});
export type DupeMember = z.infer<typeof dupeMemberSchema>;

export const dupeGroupSchema = z.object({
    id: z.string(),
    /**
     * "exact" is byte-identical, from `contentHash`; "near" is perceptual.
     *
     * The distinction drives the UI, because the decisions are different. With an exact
     * duplicate there is nothing to compare and the only question is which path to keep; with
     * a near duplicate the copies genuinely differ and the comparison is the whole point.
     */
    kind: z.enum(["exact", "near"]),
    reviewed: z.boolean(),
    /**
     * Worst distance between any linked pair, or 0 for an exact group.
     *
     * Surfaced because clustering treats similarity as transitive: a group is built from a
     * chain of pairwise links, so a high value means "these are connected but not
     * necessarily all alike" and is exactly when a person should look closely.
     */
    maxDistance: z.number(),
    members: z.array(dupeMemberSchema),
    /**
     * Which copy the app would keep, as a preselection rather than a decision.
     *
     * Null when nothing can be recommended. Nothing is deleted on the strength of this — it
     * decides which radio button starts checked, which matters because a queue where the
     * right answer is usually preselected gets worked through and one where it is not gets
     * abandoned.
     */
    suggestedKeepId: z.string().nullable(),
    /**
     * Why that copy is the one to keep, measured against the runner-up.
     *
     * A recommendation with no reason is one people override on instinct, and the instinct is
     * "keep the bigger file" — the rule the ordering deliberately puts last because it throws
     * away the better copy most often (§10c).
     */
    keepReason: z.string().nullable(),
    /**
     * Reasons this group deserves a closer look than a glance, in words.
     *
     * A group with any starts unticked on the triage sheet (§10c), so accepting a page of
     * recommendations in one press never includes it by default. Only what does not depend on
     * the keeper is here; clips at risk do, and are drawn from `clipCount` on the client.
     */
    cautions: z.array(z.string()),
});
export type DupeGroup = z.infer<typeof dupeGroupSchema>;

export const dupeKindSchema = z.enum(["exact", "near"]);
export type DupeKind = z.infer<typeof dupeKindSchema>;

export const dupeListResponseSchema = z.object({
    groups: z.array(dupeGroupSchema),
    /** Groups matching the query as asked — kind and reviewed filters both applied. */
    total: z.number(),
    /**
     * Unreviewed groups per kind, independent of the page and of the kind filter.
     *
     * Per kind so the filter can say what each choice holds before it is picked: the whole
     * point of filtering is clearing the identical files first, and a count that only appeared
     * after switching would make that a guess.
     */
    pending: z.object({ exact: z.number(), near: z.number() }),
    /** Groups somebody decided to keep as they are, for the Reviewed tab's label. */
    reviewed: z.number(),
    /**
     * Unreviewed groups of videos and of photos, whatever `media` was asked: the counts on the
     * kind control, and the queue's size in the review nav, which counts videos (§10c).
     */
    pendingByMedia: mediaKindCountsSchema,
});
export type DupeListResponse = z.infer<typeof dupeListResponseSchema>;

/** The most groups one page, one resolve or one review can carry. */
export const DUPE_PAGE_LIMIT = 100;

export const dupeQuerySchema = z.object({
    /**
     * Waiting for a decision, or already decided to be kept as they are.
     *
     * Two tabs rather than a "show reviewed" switch that mixed them: a reviewed group is one
     * somebody chose to leave alone, and the only reason to look at it again is to change that
     * mind — which is a different visit from working through the queue.
     */
    status: z.enum(["pending", "reviewed"]).default("pending"),
    kind: dupeKindSchema.optional(),
    /**
     * Groups of videos or of photos only; both when absent. A group never mixes the two, so this
     * filters whole groups. `pending` and `reviewed` are counted under it too.
     */
    media: mediaKindSchema.optional(),
    limit: z.coerce.number().int().min(1).max(DUPE_PAGE_LIMIT).default(20),
    offset: z.coerce.number().int().min(0).default(0),
});
export type DupeQuery = z.infer<typeof dupeQuerySchema>;

/**
 * One group's decision on the triage sheet (§10c).
 *
 * The keeper is named explicitly rather than implied by `suggestedKeepId`, because the reviewer
 * may disagree with the recommendation — a request saying only "resolve this group" would
 * delete whatever the server ranked first at the moment it arrived.
 *
 * **And the copies to remove are named too, not implied as "everything else".** A group can
 * gain a member between the page loading and the button being pressed — a clustering pass
 * merges overlapping groups (§10b) — and with a page of fifty loaded minutes earlier that window
 * is wide. "Everything but the keeper" would then trash a copy nobody was shown. The list is an
 * allowlist: the server removes only copies that are in it *and* still in the group.
 */
export const dupeResolveItemSchema = z.object({
    groupId: z.string().min(1),
    keepId: z.string().min(1),
    trashIds: z.array(z.string().min(1)).min(1).max(DUPE_PAGE_LIMIT),
});
export type DupeResolveItem = z.infer<typeof dupeResolveItemSchema>;

export const dupeResolveSchema = z.object({
    items: z.array(dupeResolveItemSchema).min(1).max(DUPE_PAGE_LIMIT),
});
export type DupeResolveInput = z.infer<typeof dupeResolveSchema>;

export const dupeGroupOutcomeSchema = z.object({
    groupId: z.string(),
    /** Echoed back, so the client never has to assume which copy the server understood. */
    keptId: z.string(),
    /** Copies that actually left the library. */
    trashed: z.number(),
    /**
     * What could not be removed, and why, per copy.
     *
     * Partial success is the expected outcome, not an error: a copy may have gone already, or
     * the volume may be full, and the copies that *can* go should still go (§14b).
     */
    failed: z.array(bulkActionFailureSchema),
    /**
     * Whether the group left the queue.
     *
     * False while it still holds a copy somebody could remove — a group with two deletable
     * copies is still a decision, and marking it reviewed would hide it from the only screen
     * that could act on it.
     */
    reviewed: z.boolean(),
    /**
     * Why nothing in this group was touched, when the decision itself no longer applies.
     *
     * The group has gone, or the keeper is no longer one of its copies. Reported per group
     * rather than failing the request, because one stale row must not undo forty-nine good ones.
     */
    refused: z.string().nullable(),
});
export type DupeGroupOutcome = z.infer<typeof dupeGroupOutcomeSchema>;

export const dupeResolveResponseSchema = z.object({
    groups: z.array(dupeGroupOutcomeSchema),
});
export type DupeResolveResponse = z.infer<typeof dupeResolveResponseSchema>;

/**
 * Marking groups reviewed, or reopening them.
 *
 * Reversible on purpose: it is a judgement, not a deletion, and someone who clears a group by
 * mistake needs a way back — otherwise the only recovery is a clustering pass that rebuilds
 * the group, which only happens if its membership changed. Several at once, because the rows a
 * reviewer leaves unticked after a resolve are exactly the ones they have decided to keep.
 */
export const dupeReviewSchema = z.object({
    groupIds: z.array(z.string().min(1)).min(1).max(DUPE_PAGE_LIMIT),
    reviewed: z.boolean(),
});
export type DupeReviewInput = z.infer<typeof dupeReviewSchema>;

/**
 * One of an item's other copies, as its delete confirmation shows it (§10d).
 *
 * The review row's fields, because the question is the same -- which copies to remove -- and a
 * second shape for the same comparison is how the two screens end up disagreeing about a copy.
 */
export const mediaCopySchema = dupeMemberSchema.extend({
    /** Byte for byte the same file as the item being deleted, by `contentHash`. */
    identical: z.boolean(),
    /** Whether this is the copy the app would keep, among every copy of the item. */
    best: z.boolean(),
    /**
     * Why this copy deserves a look before it goes with the item, or null.
     *
     * A near-duplicate group links a clip to the film it was cut from, and chains pairs that
     * are each alike into a group whose ends are not (§10b). "Delete this and its copies" is
     * only safe once the copies that are not simply copies have said so.
     */
    caution: z.string().nullable(),
});
export type MediaCopy = z.infer<typeof mediaCopySchema>;

export const mediaCopiesResponseSchema = z.object({
    /** Best first, this item excluded; only copies in libraries the viewer can see. */
    copies: z.array(mediaCopySchema),
});
export type MediaCopiesResponse = z.infer<typeof mediaCopiesResponseSchema>;

/**
 * Trashing an item, and whichever of its copies were ticked with it (§10d).
 *
 * The copies are named rather than implied as "all of them", for the reason `dupeResolveItem`
 * names them: a clustering pass can add a copy to the group while the dialog is open, and
 * nothing should go to the bin that was not on screen.
 */
export const trashMediaRequestSchema = z.object({
    alsoTrash: z.array(z.string().min(1).max(64)).max(DUPE_PAGE_LIMIT).default([]),
});
export type TrashMediaRequest = z.infer<typeof trashMediaRequestSchema>;

export const trashMediaResponseSchema = z.object({
    /** Everything now in the bin, the item itself included when it went. */
    trashed: z.array(z.string()),
    /** Per copy, so the ones that could go still went. */
    failed: z.array(bulkActionFailureSchema),
});
export type TrashMediaResponse = z.infer<typeof trashMediaResponseSchema>;

/**
 * What trashing every identical copy would do, across the whole queue (§10e).
 *
 * Counted over every pending identical group, not a page of them: the point is not having to
 * page through groups nobody needs to look at.
 */
export const identicalSummarySchema = z.object({
    /** Groups the rule decides on its own. */
    groups: z.number(),
    /** Copies those groups would lose. */
    copies: z.number(),
    /** What that frees in the libraries, at once: the copies bypass the bin (§10e). */
    bytes: z.number(),
    /** Groups the rule leaves for a person, shown as the review sheet. */
    attention: z.number(),
});
export type IdenticalSummary = z.infer<typeof identicalSummarySchema>;

export const identicalQuerySchema = z.object({
    /** The groups the rule decides, or the ones it leaves for a person. */
    view: z.enum(["routine", "attention"]).default("routine"),
    /** Groups of videos or of photos only; both when absent. The summary is counted under it. */
    media: mediaKindSchema.optional(),
    limit: z.coerce.number().int().min(1).max(DUPE_PAGE_LIMIT).default(48),
    offset: z.coerce.number().int().min(0).default(0),
});
export type IdenticalQuery = z.infer<typeof identicalQuerySchema>;

export const identicalListResponseSchema = z.object({
    summary: identicalSummarySchema,
    /** Groups in this view, for paging. */
    total: z.number(),
    /**
     * One page of the view. A routine group's `suggestedKeepId` is the copy the rule keeps, so
     * what a card shows staying is what trashing everything leaves.
     */
    groups: z.array(dupeGroupSchema),
});
export type IdenticalListResponse = z.infer<typeof identicalListResponseSchema>;

/**
 * One batch of trashing every identical copy (§10e).
 *
 * Batches, so a queue of thousands neither holds one request open for minutes nor gives the
 * page nothing to show while it runs. `after` is where the last batch stopped: each group is
 * tried once per run, so a group that refused is not retried forever.
 */
export const identicalTrashRequestSchema = z.object({
    after: z.string().min(1).max(64).nullable().default(null),
    limit: z.number().int().min(1).max(DUPE_PAGE_LIMIT).default(DUPE_PAGE_LIMIT),
    /**
     * Only groups of this kind; both when absent. The run trashes what the summary on screen
     * counted, and the summary is counted under the page's kind control.
     */
    media: mediaKindSchema.optional(),
});
export type IdenticalTrashRequest = z.infer<typeof identicalTrashRequestSchema>;

export const identicalTrashResponseSchema = z.object({
    /** Groups this batch decided. */
    groups: z.number(),
    /** Copies it moved to the trash. */
    trashed: z.number(),
    failed: z.array(bulkActionFailureSchema),
    /** Pass as `after` for the next batch; null when this batch reached the end. */
    cursor: z.string().nullable(),
    /** Routine groups after the cursor, for the progress bar. */
    remaining: z.number(),
});
export type IdenticalTrashResponse = z.infer<typeof identicalTrashResponseSchema>;
