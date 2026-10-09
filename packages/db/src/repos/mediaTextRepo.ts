import { randomUUID } from "node:crypto";

import {
    keepReviewed,
    normalizeText,
    type OcrReviewAction,
    type OcrReviewState,
    type OcrStatus,
    type ReconciledText,
    type TextBox,
} from "@private-stock/core";

import { db } from "../db.js";

/**
 * Text read out of the picture (§5d).
 *
 * The reconciler writes an item's *machine* findings wholesale: a run examines frames and
 * elects strings from what they said, so it has no way to merge its answer into an older one.
 * Two runs at different sampling densities would otherwise leave the item holding both, and
 * the occurrence counts — the whole argument for believing a finding — would be comparing
 * against different denominators. Re-running OCR is a correction, not an addition.
 *
 * What a person has reviewed is not the reconciler's to replace (§5d "Reviewing what was
 * read"). A confirmed, corrected or dismissed finding survives every re-run, and the run drops
 * its own readings of the same string rather than adding them back beside it.
 */

/**
 * A stored finding.
 *
 * Deliberately not `ReconciledText & { id }`: a stored finding may have come from a still,
 * which has no moment, so the timestamps are nullable here — flattening a missing one to zero
 * would claim the text appeared at the start of a timeline the item does not have. The box is
 * nullable for the same reason: nothing guarantees one was recorded.
 */
export interface MediaTextRow extends Omit<ReconciledText, "firstAtMs" | "lastAtMs" | "box"> {
    id: string;
    mediaId: string;
    firstAtMs: number | null;
    lastAtMs: number | null;
    box: TextBox | null;
    reviewState: OcrReviewState | null;
    originalText: string | null;
    reviewedByUserId: string | null;
    reviewedAt: string | null;
}

interface StoredRow {
    id: string;
    mediaId: string;
    text: string;
    textNorm: string;
    firstAtMs: number | null;
    lastAtMs: number | null;
    confidence: number;
    occurrences: number;
    stability: number;
    boxX: number | null;
    boxY: number | null;
    boxW: number | null;
    boxH: number | null;
    reviewState: OcrReviewState | null;
    originalText: string | null;
    reviewedByUserId: string | null;
    reviewedAt: string | null;
}

const SELECT_COLUMNS = `"id", "mediaId", "text", "textNorm", "firstAtMs", "lastAtMs",
                        "confidence", "occurrences", "stability",
                        "boxX", "boxY", "boxW", "boxH",
                        "reviewState", "originalText", "reviewedByUserId", "reviewedAt"`;

const toRow = (stored: StoredRow): MediaTextRow => ({
    id: stored.id,
    mediaId: stored.mediaId,
    text: stored.text,
    textNorm: stored.textNorm,
    firstAtMs: stored.firstAtMs,
    lastAtMs: stored.lastAtMs,
    confidence: stored.confidence,
    occurrences: stored.occurrences,
    stability: stored.stability,
    box:
        stored.boxX === null || stored.boxY === null || stored.boxW === null || stored.boxH === null
            ? null
            : { x: stored.boxX, y: stored.boxY, w: stored.boxW, h: stored.boxH },
    reviewState: stored.reviewState,
    originalText: stored.originalText,
    reviewedByUserId: stored.reviewedByUserId,
    reviewedAt: stored.reviewedAt,
});

/**
 * Rows in a status. `all` includes dismissed ones, because a reviewer has to be able to find
 * what they dismissed in order to undo it.
 */
const STATUS_PREDICATE: Record<OcrStatus, string> = {
    unreviewed: `"reviewState" IS NULL`,
    confirmed: `"reviewState" = 'confirmed'`,
    edited: `"reviewState" = 'edited'`,
    dismissed: `"reviewState" = 'dismissed'`,
    all: `1`,
};

/** Ordered by stability: a string on most of the frames is the item's identity. */
const ITEM_ORDER = `ORDER BY "stability" DESC, "confidence" DESC, "text" ASC`;

/**
 * An item's findings, strongest first.
 *
 * Dismissed findings are left out unless asked for. Everything that *uses* the text — the
 * details panel, the search index — must behave as if a dismissed string had never been read;
 * only the review surfaces show them, so they can be restored.
 */
export const listForMedia = (
    mediaId: string,
    options: { includeDismissed?: boolean } = {}
): MediaTextRow[] =>
    (
        db
            .prepare(
                `SELECT ${SELECT_COLUMNS} FROM "MediaText"
                  WHERE "mediaId" = ?
                    ${options.includeDismissed ? "" : `AND "reviewState" IS NOT 'dismissed'`}
                  ${ITEM_ORDER}`
            )
            .all(mediaId) as StoredRow[]
    ).map(toRow);

/**
 * Findings for many items at once: a page of the review list.
 *
 * `status` and `textNorm` narrow it the way the page is narrowed, so an item listed under one
 * string shows that string's findings rather than everything it says.
 */
export const listForMediaIds = (
    mediaIds: string[],
    options: { status?: OcrStatus; textNorm?: string } = {}
): MediaTextRow[] => {
    if (mediaIds.length === 0) {
        return [];
    }

    const textClause = options.textNorm === undefined ? "" : `AND "textNorm" = ?`;

    return (
        db
            .prepare(
                `SELECT ${SELECT_COLUMNS} FROM "MediaText"
                  WHERE "mediaId" IN (${mediaIds.map(() => "?").join(", ")})
                    AND ${STATUS_PREDICATE[options.status ?? "all"]}
                    ${textClause}
                  ${ITEM_ORDER}`
            )
            .all(
                ...mediaIds,
                ...(options.textNorm === undefined ? [] : [options.textNorm])
            ) as StoredRow[]
    ).map(toRow);
};

/** Rows by id, for actions that need to know what they are about to change. */
export const findByIds = (ids: string[]): MediaTextRow[] => {
    if (ids.length === 0) {
        return [];
    }

    return (
        db
            .prepare(
                `SELECT ${SELECT_COLUMNS} FROM "MediaText"
                  WHERE "id" IN (${ids.map(() => "?").join(", ")})`
            )
            .all(...ids) as StoredRow[]
    ).map(toRow);
};

const insertStatement = () =>
    db.prepare(
        `INSERT INTO "MediaText" (
             "id", "mediaId", "text", "textNorm", "firstAtMs", "lastAtMs",
             "confidence", "occurrences", "stability", "boxX", "boxY", "boxW", "boxH",
             "reviewState", "originalText", "reviewedByUserId", "reviewedAt"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

/** The reviewed rows an item already has, which a re-run must leave alone and not repeat. */
const reviewedFor = (mediaId: string): MediaTextRow[] =>
    (
        db
            .prepare(
                `SELECT ${SELECT_COLUMNS} FROM "MediaText"
                  WHERE "mediaId" = ? AND "reviewState" IS NOT NULL`
            )
            .all(mediaId) as StoredRow[]
    ).map(toRow);

/**
 * Replace an item's machine findings with a new run's.
 *
 * Only the unreviewed rows go. Reviewed ones stay, and any new finding a reviewed row already
 * accounts for is dropped (`keepReviewed`), so a dismissed watermark does not come back and a
 * corrected one is not shown twice.
 *
 * `hasTimeline` is false for a still, which has no `atMs` to record — the same rule
 * `Artifact.atMs` follows.
 */
export const replaceMachineFindings = (
    mediaId: string,
    findings: ReconciledText[],
    hasTimeline = true
): void => {
    const remove = db.prepare(
        `DELETE FROM "MediaText" WHERE "mediaId" = ? AND "reviewState" IS NULL`
    );
    const insert = insertStatement();

    db.transaction(() => {
        remove.run(mediaId);

        for (const finding of keepReviewed(findings, reviewedFor(mediaId))) {
            insert.run(
                randomUUID(),
                mediaId,
                finding.text,
                finding.textNorm,
                hasTimeline ? finding.firstAtMs : null,
                hasTimeline ? finding.lastAtMs : null,
                finding.confidence,
                finding.occurrences,
                finding.stability,
                finding.box.x,
                finding.box.y,
                finding.box.w,
                finding.box.h,
                null,
                null,
                null,
                null
            );
        }
    })();
};

/**
 * Take a byte-identical twin's findings, review decisions included (§10f).
 *
 * The same bytes say the same thing, so a string somebody dismissed or corrected on one copy
 * is dismissed or corrected on the other. This item's own reviewed rows still win: they are
 * kept, and the twin's readings of the same strings are not added beside them.
 */
export const adoptFindings = (
    mediaId: string,
    twinRows: MediaTextRow[],
    hasTimeline = true
): void => {
    const remove = db.prepare(
        `DELETE FROM "MediaText" WHERE "mediaId" = ? AND "reviewState" IS NULL`
    );
    const insert = insertStatement();

    db.transaction(() => {
        remove.run(mediaId);

        for (const row of keepReviewed(twinRows, reviewedFor(mediaId))) {
            insert.run(
                randomUUID(),
                mediaId,
                row.text,
                row.textNorm,
                hasTimeline ? row.firstAtMs : null,
                hasTimeline ? row.lastAtMs : null,
                row.confidence,
                row.occurrences,
                row.stability,
                row.box?.x ?? null,
                row.box?.y ?? null,
                row.box?.w ?? null,
                row.box?.h ?? null,
                row.reviewState,
                row.originalText,
                row.reviewedByUserId,
                row.reviewedAt
            );
        }
    })();
};

/** Does this item have any findings? Used to decide whether a stage is `done` or `empty`. */
export const countForMedia = (mediaId: string): number =>
    (
        db.prepare(`SELECT COUNT(*) AS n FROM "MediaText" WHERE "mediaId" = ?`).get(mediaId) as {
            n: number;
        }
    ).n;

// ─────────────────────────────────────────────────────────────────────────────
// Review (§5d "Reviewing what was read")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which rows an action reaches.
 *
 * Confirming applies to what nobody has looked at, so it cannot quietly overwrite a correction.
 * Editing and dismissing apply to everything still shown. Restoring applies to what has been
 * reviewed. The client counts the same way from the summary row (`ocrActionCount`), and the
 * two have to agree for the stale-page guard to mean anything.
 */
const ACTION_SCOPE: Record<OcrReviewAction | "edit", string> = {
    confirm: `"reviewState" IS NULL`,
    dismiss: `"reviewState" IS NOT 'dismissed'`,
    edit: `"reviewState" IS NOT 'dismissed'`,
    restore: `"reviewState" IS NOT NULL`,
};

export interface TargetRow {
    id: string;
    mediaId: string;
}

/** The rows an action on these findings would change. */
export const scopeRowIds = (ids: string[], action: OcrReviewAction | "edit"): TargetRow[] => {
    if (ids.length === 0) {
        return [];
    }

    return db
        .prepare(
            `SELECT "id", "mediaId" FROM "MediaText"
              WHERE "id" IN (${ids.map(() => "?").join(", ")}) AND ${ACTION_SCOPE[action]}`
        )
        .all(...ids) as TargetRow[];
};

/** The rows an action on these whole strings would change. */
export const scopeStrings = (
    textNorms: string[],
    action: OcrReviewAction | "edit"
): TargetRow[] => {
    if (textNorms.length === 0) {
        return [];
    }

    return db
        .prepare(
            `SELECT "id", "mediaId" FROM "MediaText"
              WHERE "textNorm" IN (${textNorms.map(() => "?").join(", ")})
                AND ${ACTION_SCOPE[action]}`
        )
        .all(...textNorms) as TargetRow[];
};

/** Many ids per statement, under SQLite's bound-parameter ceiling. */
const CHUNK = 500;

const inChunks = (ids: string[], run: (chunk: string[]) => void): void => {
    for (let at = 0; at < ids.length; at += CHUNK) {
        run(ids.slice(at, at + CHUNK));
    }
};

/** Mark rows confirmed or dismissed. */
export const setReviewState = (
    ids: string[],
    state: "confirmed" | "dismissed",
    userId: string
): void => {
    db.transaction(() =>
        inChunks(ids, (chunk) =>
            db
                .prepare(
                    `UPDATE "MediaText"
                        SET "reviewState" = ?, "reviewedByUserId" = ?,
                            "reviewedAt" = CURRENT_TIMESTAMP
                      WHERE "id" IN (${chunk.map(() => "?").join(", ")})`
                )
                .run(state, userId, ...chunk)
        )
    )();
};

/**
 * Correct the text of these rows.
 *
 * The engine's reading is kept the first time a row is corrected and never overwritten after,
 * so a second correction can still be undone to what was actually read. Correcting a row back
 * to exactly what was read is the same as confirming it, and is recorded that way: an "edit"
 * that changes nothing would show an edited badge over the original text.
 */
export const editText = (ids: string[], text: string, userId: string): void => {
    const textNorm = normalizeText(text);

    db.transaction(() =>
        inChunks(ids, (chunk) =>
            db
                .prepare(
                    `UPDATE "MediaText"
                        SET "reviewState" = CASE WHEN COALESCE("originalText", "text") = :text
                                                 THEN 'confirmed' ELSE 'edited' END,
                            "originalText" = CASE WHEN COALESCE("originalText", "text") = :text
                                                  THEN NULL
                                                  ELSE COALESCE("originalText", "text") END,
                            "text" = :text,
                            "textNorm" = :textNorm,
                            "reviewedByUserId" = :userId,
                            "reviewedAt" = CURRENT_TIMESTAMP
                      WHERE "id" IN (${chunk.map((_, index) => `:id${index}`).join(", ")})`
                )
                .run({
                    text,
                    textNorm,
                    userId,
                    ...Object.fromEntries(chunk.map((id, index) => [`id${index}`, id])),
                })
        )
    )();
};

/**
 * Undo a review: the row goes back to being an unreviewed machine finding, and a corrected one
 * gets the engine's reading back.
 *
 * One row at a time because the restored reading's normalised form is computed here, where the
 * rule for it lives, rather than approximated in SQL.
 */
export const restore = (ids: string[]): void => {
    const update = db.prepare(
        `UPDATE "MediaText"
            SET "text" = ?, "textNorm" = ?, "originalText" = NULL, "reviewState" = NULL,
                "reviewedByUserId" = NULL, "reviewedAt" = NULL
          WHERE "id" = ?`
    );

    db.transaction(() => {
        for (const row of findByIds(ids)) {
            const text = row.originalText ?? row.text;

            update.run(text, normalizeText(text), row.id);
        }
    })();
};

/**
 * Where a page of strings continues from: the last row's sort value and its `textNorm`.
 *
 * The value keeps its type through the cursor (§4 "Keyset cursors must preserve the sort
 * value's type"). The Rules list (`ocrTagMatchRepo.listQueue`) pages with it.
 */
export interface StringCursor {
    value: number | null;
    textNorm: string;
}

/**
 * A page of the items showing one string, by id: what the queue's "all items" list behind an
 * accept loads.
 *
 * Ordered by id rather than by when an item was added: the index on the findings already
 * holds them in that order, so a page is a range read whatever the library's size. Stable is
 * what matters to a cursor.
 *
 * Only items still in the library. A trashed item's findings stay until it is purged, and
 * tagging an item nobody can open again is work for nothing.
 */
export const listItemIds = (query: {
    /** The libraries the caller may see (§6). Every item query is scoped by these. */
    rootIds: string[];
    textNorm: string;
    after: string | null;
    limit: number;
}): { ids: string[]; next: string | null } => {
    if (query.rootIds.length === 0) {
        return { ids: [], next: null };
    }

    const ids = db
        .prepare(
            `SELECT DISTINCT t."mediaId"
               FROM "MediaText" t
               JOIN "Media" m ON m."id" = t."mediaId"
              WHERE t."textNorm" = ? AND m."listable" = 1
                AND m."listRootId" IN (${query.rootIds.map(() => "?").join(", ")})
                AND (? IS NULL OR t."mediaId" > ?)
              ORDER BY t."mediaId"
              LIMIT ?`
        )
        .pluck()
        .all(
            query.textNorm,
            ...query.rootIds,
            query.after,
            query.after,
            query.limit + 1
        ) as string[];

    const page = ids.slice(0, query.limit);

    return {
        ids: page,
        next: ids.length > query.limit ? (page[page.length - 1] ?? null) : null,
    };
};

/** What a review row needs to say which item it is. */
export interface ItemHead {
    id: string;
    kind: "image" | "video";
    title: string | null;
    listRelPath: string | null;
    durationMs: number | null;
}

export const listItemHeads = (mediaIds: string[]): ItemHead[] => {
    if (mediaIds.length === 0) {
        return [];
    }

    return db
        .prepare(
            `SELECT "id", "kind", "title", "listRelPath", "durationMs" FROM "Media"
              WHERE "id" IN (${mediaIds.map(() => "?").join(", ")})`
        )
        .all(...mediaIds) as ItemHead[];
};
