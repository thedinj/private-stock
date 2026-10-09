import { z } from "zod";

/**
 * Reviewing text read out of the picture (§5d "Reviewing what was read"): confirming,
 * correcting and dismissing findings, which an administrator does from an item's details.
 */

/** What a person decided about a finding. Absent means nobody has. */
export const ocrReviewStateSchema = z.enum(["confirmed", "edited", "dismissed"]);
export type OcrReviewState = z.infer<typeof ocrReviewStateSchema>;

/** Which findings a read returns, by what was decided about them. */
export const ocrStatusSchema = z.enum(["unreviewed", "confirmed", "edited", "dismissed", "all"]);
export type OcrStatus = z.infer<typeof ocrStatusSchema>;

/** Most rows one page of an OCR list may hold. */
export const OCR_STRING_PAGE_LIMIT = 100;
export const OCR_ITEM_PAGE_LIMIT = 40;

/** Most findings one request may act on. */
export const OCR_ROW_ACTION_LIMIT = 1000;

export const ocrBoxSchema = z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
});
export type OcrBox = z.infer<typeof ocrBoxSchema>;

/**
 * The thumbnail tile for the moment a string was read: a rectangle of a sprite sheet the item
 * already has, so showing the frame the engine looked at costs nothing to produce.
 */
export const ocrFrameSchema = z.object({
    url: z.string(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    sheetWidth: z.number(),
    sheetHeight: z.number(),
});
export type OcrFrame = z.infer<typeof ocrFrameSchema>;

/** What an action reaches: findings by id. */
export const ocrTargetSchema = z.object({
    rowIds: z.array(z.string().min(1).max(64)).min(1).max(OCR_ROW_ACTION_LIMIT),
});
export type OcrTarget = z.infer<typeof ocrTargetSchema>;

export const ocrReviewActionSchema = z.enum(["confirm", "dismiss", "restore"]);
export type OcrReviewAction = z.infer<typeof ocrReviewActionSchema>;

export const ocrReviewSchema = z.object({
    action: ocrReviewActionSchema,
    target: ocrTargetSchema,
});
export type OcrReviewInput = z.infer<typeof ocrReviewSchema>;

export const ocrEditSchema = z.object({
    text: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .refine((value) => value.replace(/\s+/g, " ").length > 0, "Text cannot be blank"),
    target: ocrTargetSchema,
});
export type OcrEditInput = z.infer<typeof ocrEditSchema>;

export const ocrChangeResultSchema = z.object({
    updated: z.number(),
    /** The items whose text changed, so their open details can be refreshed. */
    mediaIds: z.array(z.string()),
});
export type OcrChangeResult = z.infer<typeof ocrChangeResultSchema>;
