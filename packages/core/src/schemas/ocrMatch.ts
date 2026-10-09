import { z } from "zod";

import { mediaKindCountsSchema, mediaKindSchema } from "../domain.js";
import { tagMatchKinds } from "../ocrTagMatch.js";
import { ocrBoxSchema, ocrFrameSchema, OCR_ITEM_PAGE_LIMIT, OCR_STRING_PAGE_LIMIT } from "./ocr.js";

/**
 * Tagging performers and sources from what OCR read (§5d "Tagging performers and sources from
 * what was read").
 *
 * The queue lists items, newest first, each with the performers and sources its text appears to
 * name. A decision is still about a pair — this string, that tag — and accepting one makes it a
 * rule: it tags every item the string was read on, and every item it is read on afterwards.
 */

/** How the pair was found. `manual` is one an administrator chose instead of the proposal. */
export const ocrMatchKindSchema = z.enum([...tagMatchKinds, "manual"]);
export type OcrMatchKind = z.infer<typeof ocrMatchKindSchema>;

/** What was decided about a pair. Absent means nobody has. */
export const ocrMatchStateSchema = z.enum(["accepted", "rejected"]);
export type OcrMatchState = z.infer<typeof ocrMatchStateSchema>;

/** Which decided pairs the Rules list shows, by string. */
export const ocrMatchStatusSchema = z.enum(["accepted", "rejected"]);
export type OcrMatchStatus = z.infer<typeof ocrMatchStatusSchema>;

/** The facets matched, and the two a string can be filed under by hand. */
export const ocrMatchTagKindSchema = z.enum(["performer", "source"]);
export type OcrMatchTagKind = z.infer<typeof ocrMatchTagKindSchema>;

export const ocrMatchQuerySchema = z.object({
    status: ocrMatchStatusSchema.default("accepted"),
    search: z.string().trim().max(200).optional(),
    after: z.string().min(1).max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(OCR_STRING_PAGE_LIMIT).default(50),
});
export type OcrMatchQuery = z.infer<typeof ocrMatchQuerySchema>;

export const ocrMatchCandidateSchema = z.object({
    matchId: z.string(),
    tagId: z.string(),
    tagName: z.string(),
    tagKind: z.string(),
    kind: ocrMatchKindSchema,
    /** The part of the string that named the tag, as it was read. */
    matchedText: z.string(),
    state: ocrMatchStateSchema.nullable(),
    /** Items carrying the string and not the tag, counted when the page was read. */
    untagged: z.number(),
    /** For a misreading: what accepting corrects the string to. */
    correctedText: z.string().nullable(),
});
export type OcrMatchCandidate = z.infer<typeof ocrMatchCandidateSchema>;

export const ocrMatchRowSchema = z.object({
    textNorm: z.string(),
    text: z.string(),
    /** Findings of the string, across the library. */
    rowCount: z.number(),
    /** One place it was read, for the thumbnail. */
    sample: z
        .object({
            mediaId: z.string(),
            coverUrl: z.string().nullable(),
            frame: ocrFrameSchema.nullable(),
            box: ocrBoxSchema.nullable(),
            atMs: z.number().nullable(),
        })
        .nullable(),
    candidates: z.array(ocrMatchCandidateSchema),
});
export type OcrMatchRow = z.infer<typeof ocrMatchRowSchema>;

export const ocrMatchPageSchema = z.object({
    rows: z.array(ocrMatchRowSchema),
    next: z.string().nullable(),
});
export type OcrMatchPage = z.infer<typeof ocrMatchPageSchema>;

/** The items one string was read on, each saying which of the string's tags it already has. */
export const ocrMatchItemsQuerySchema = z.object({
    textNorm: z.string().min(1).max(500),
    after: z.string().min(1).max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(OCR_ITEM_PAGE_LIMIT).default(24),
});
export type OcrMatchItemsQuery = z.infer<typeof ocrMatchItemsQuerySchema>;

export const ocrMatchItemSchema = z.object({
    mediaId: z.string(),
    kind: z.enum(["image", "video"]),
    title: z.string(),
    fileName: z.string(),
    coverUrl: z.string().nullable(),
    frame: ocrFrameSchema.nullable(),
    box: ocrBoxSchema.nullable(),
    atMs: z.number().nullable(),
    /** The string's candidate tags this item already carries. */
    taggedWith: z.array(z.string()),
    /** The string's pairs this item was left out of when they were accepted. */
    skippedFrom: z.array(z.string()),
});
export type OcrMatchItem = z.infer<typeof ocrMatchItemSchema>;

export const ocrMatchItemPageSchema = z.object({
    items: z.array(ocrMatchItemSchema),
    next: z.string().nullable(),
});
export type OcrMatchItemPage = z.infer<typeof ocrMatchItemPageSchema>;

/** Most items one accept may leave out by hand. Past this, rejecting is the answer. */
export const OCR_MATCH_EXCLUDE_LIMIT = 1000;

export const ocrMatchDecideSchema = z.object({
    matchIds: z.array(z.string().min(1).max(64)).min(1).max(20),
});
export type OcrMatchDecideInput = z.infer<typeof ocrMatchDecideSchema>;

/** File the string under a tag the matcher did not propose, in place of one it did. */
export const ocrMatchManualSchema = z.object({
    textNorm: z.string().min(1).max(500),
    kind: ocrMatchTagKindSchema,
    name: z.string().trim().min(1).max(200),
    /** The proposal this replaces, which is rejected. */
    replaceMatchId: z.string().min(1).max(64).optional(),
});
export type OcrMatchManualInput = z.infer<typeof ocrMatchManualSchema>;

export const ocrMatchResultSchema = z.object({
    /** Tags written. */
    tagged: z.number(),
    /** Items whose tags changed, so the client can refresh whichever of them it has open. */
    mediaIds: z.array(z.string()),
    /** The string the pairs now belong to, which a correction changes. */
    textNorm: z.string(),
});
export type OcrMatchResult = z.infer<typeof ocrMatchResultSchema>;

/**
 * Items with something to decide, videos and photos apart: the counts on the queue's kind control,
 * and the review nav's, which counts videos because the queue opens on them.
 */
export const ocrCountsSchema = z.object({
    waiting: mediaKindCountsSchema,
});
export type OcrCounts = z.infer<typeof ocrCountsSchema>;

export const OCR_QUEUE_PAGE_LIMIT = 50;

export const ocrQueueQuerySchema = z.object({
    after: z.string().min(1).max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(OCR_QUEUE_PAGE_LIMIT).default(20),
    /** Videos or photos only; both when absent. */
    media: mediaKindSchema.optional(),
});
export type OcrQueueQuery = z.infer<typeof ocrQueueQuerySchema>;

/** One string an item shows, where it was read, and the open pairs it names. */
export const ocrQueueStringSchema = z.object({
    textNorm: z.string(),
    text: z.string(),
    frame: ocrFrameSchema.nullable(),
    box: ocrBoxSchema.nullable(),
    atMs: z.number().nullable(),
    candidates: z.array(ocrMatchCandidateSchema),
});
export type OcrQueueString = z.infer<typeof ocrQueueStringSchema>;

export const ocrQueueItemSchema = z.object({
    mediaId: z.string(),
    kind: z.enum(["image", "video"]),
    title: z.string(),
    fileName: z.string(),
    coverUrl: z.string().nullable(),
    /** When the item was read or the pair appeared, whichever is later. */
    matchedAt: z.string(),
    /**
     * Every name it matches was added after it was read: an old item a new performer brought
     * back, rather than a new item.
     */
    newName: z.boolean(),
    strings: z.array(ocrQueueStringSchema),
});
export type OcrQueueItem = z.infer<typeof ocrQueueItemSchema>;

export const ocrQueuePageSchema = z.object({
    items: z.array(ocrQueueItemSchema),
    next: z.string().nullable(),
});
export type OcrQueuePage = z.infer<typeof ocrQueuePageSchema>;

/**
 * Accept pairs from one item's row. Each tags every item showing its string, less the items left
 * out, and goes on tagging the items the string is read on afterwards.
 *
 * `expectedCount` is the sum of the accepted candidates' `untagged` as shown. OCR may have read
 * a string on more items since, and those are items nobody looked at, so the server refuses
 * rather than tag them.
 */
export const ocrQueueAcceptSchema = z.object({
    mediaId: z.string().min(1).max(64),
    matchIds: z.array(z.string().min(1).max(64)).min(1).max(20),
    expectedCount: z.number().int().min(0),
    excludeMediaIds: z.array(z.string().min(1).max(64)).max(OCR_MATCH_EXCLUDE_LIMIT).default([]),
});
export type OcrQueueAcceptInput = z.infer<typeof ocrQueueAcceptSchema>;

/** Not on this item: the pairs stay open for every other item showing their strings. */
export const ocrQueueSkipSchema = z.object({
    mediaId: z.string().min(1).max(64),
    matchIds: z.array(z.string().min(1).max(64)).min(1).max(20),
});
export type OcrQueueSkipInput = z.infer<typeof ocrQueueSkipSchema>;

export const ocrRuleTagQuerySchema = z.object({
    after: z.string().min(1).max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(OCR_QUEUE_PAGE_LIMIT).default(30),
});
export type OcrRuleTagQuery = z.infer<typeof ocrRuleTagQuerySchema>;

/** A tag a rule applied, with the item and the text it was applied from. */
export const ocrRuleTagSchema = z.object({
    id: z.string(),
    mediaId: z.string(),
    kind: z.enum(["image", "video"]),
    title: z.string(),
    fileName: z.string(),
    coverUrl: z.string().nullable(),
    frame: ocrFrameSchema.nullable(),
    box: ocrBoxSchema.nullable(),
    atMs: z.number().nullable(),
    /** The text the rule matched, or null once nothing on the item reads it. */
    text: z.string().nullable(),
    tagId: z.string(),
    tagName: z.string(),
    tagKind: z.string(),
    createdAt: z.string(),
});
export type OcrRuleTag = z.infer<typeof ocrRuleTagSchema>;

export const ocrRuleTagPageSchema = z.object({
    rows: z.array(ocrRuleTagSchema),
    next: z.string().nullable(),
});
export type OcrRuleTagPage = z.infer<typeof ocrRuleTagPageSchema>;

/** Take a rule's tag off its item, and keep the rule from putting it back. */
export const ocrRuleTagUndoSchema = z.object({
    id: z.string().min(1).max(64),
});
export type OcrRuleTagUndoInput = z.infer<typeof ocrRuleTagUndoSchema>;
