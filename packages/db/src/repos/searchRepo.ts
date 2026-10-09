import { randomUUID } from "node:crypto";

import { SEARCH_COLUMN_WEIGHTS, buildMatchExpression } from "@private-stock/core";

import { db } from "../db.js";
import { tagNameMatchSql } from "../tagNameMatch.js";

/**
 * The only place FTS5 is spoken (§5c).
 *
 * The containment is the point. Route handlers and services never write `MATCH` syntax, so
 * the decision to use SQLite FTS5 rather than a dedicated engine lives behind one file — the
 * revisit triggers in §5c name Meilisearch and Typesense as the successors, and both slot in
 * here without anything upstream noticing.
 *
 * The document is *written* by the worker's index stage; this module reads it, plus the one
 * write that marks a document stale.
 */

export interface SearchDocument {
    mediaId: string;
    filename: string;
    title: string;
    performers: string;
    tags: string;
    attributes: string;
    notes: string;
    /** Text read out of the picture, joined into one field (§5d). */
    ocr: string;
    /** Other spellings of the curated text: glued pairs, names found in glued words (§5c). */
    variants: string;
}

const DOC_COLUMNS = [
    "filename",
    "title",
    "performers",
    "tags",
    "attributes",
    "notes",
    "ocr",
    "variants",
] as const;

/**
 * Writes one item's document.
 *
 * An upsert on `mediaId`, so re-indexing an item that is already indexed updates in place
 * and the triggers replace its index entries rather than adding a second set. Re-running the
 * index stage over the whole library is therefore safe and idempotent, which is the property
 * that makes "the recipe changed, reindex everything" an ordinary operation.
 */
export const upsertDocument = (document: SearchDocument): void => {
    const assignments = DOC_COLUMNS.map((column) => `"${column}" = excluded."${column}"`).join(
        ", "
    );

    db.prepare(
        `INSERT INTO "MediaSearchDoc"
             ("mediaId", ${DOC_COLUMNS.map((column) => `"${column}"`).join(", ")}, "indexedAt")
         VALUES (?, ${DOC_COLUMNS.map(() => "?").join(", ")}, CURRENT_TIMESTAMP)
         ON CONFLICT("mediaId")
         DO UPDATE SET ${assignments}, "indexedAt" = CURRENT_TIMESTAMP`
    ).run(document.mediaId, ...DOC_COLUMNS.map((column) => document[column] ?? ""));
};

/**
 * Marks a document stale and queues the work, atomically.
 *
 * Called when something the document is assembled *from* changes -- a tag assignment, a title
 * edit. Clearing the stage row rather than rewriting the document keeps the expensive
 * six-table assembly in the worker, off the request path: tagging fifty items in a bulk
 * action must not rebuild fifty documents inside an HTTP handler.
 *
 * Both halves are needed and neither is sufficient. Clearing the row is what makes the item
 * eligible for the sweep and survives the worker being down; the job is what makes it happen
 * within seconds. With only the job, a worker restart at the wrong moment drops the edit out
 * of search permanently -- and nothing would detect it, because the document looks present
 * and merely says the wrong thing.
 *
 * The `NOT EXISTS` guard keeps a bulk edit from queuing one job per affected item per edit:
 * re-tagging the same item five times is still one pending index job.
 */
export const requestReindex = (mediaIds: string[]): void => {
    if (mediaIds.length === 0) {
        return;
    }

    const clearStage = db.prepare(
        `DELETE FROM "MediaStage" WHERE "mediaId" = ? AND "stage" = 'index'`
    );

    const enqueue = db.prepare(
        `INSERT INTO "Job" ("id", "kind", "mediaId", "priority", "mediaAddedAt", "updatedAt")
         -- Carries the library's ordering key like every other per-item job (§7d), so a bulk
         -- reindex reaches the items somebody is looking at first.
         SELECT ?, 'index', ?, 90, (SELECT "addedAt" FROM "Media" WHERE "id" = ?),
                CURRENT_TIMESTAMP
          WHERE NOT EXISTS (
              SELECT 1 FROM "Job"
               WHERE "kind" = 'index' AND "mediaId" = ?
                 AND "state" IN ('pending', 'claimed')
          )`
    );

    db.transaction(() => {
        for (const mediaId of mediaIds) {
            clearStage.run(mediaId);
            enqueue.run(randomUUID(), mediaId, mediaId, mediaId);
        }
    })();
};

/**
 * The FTS5 expression for a user's text, or null when there is nothing to match.
 *
 * Re-exported from `@private-stock/core` rather than reimplemented so that the syntax rules
 * stay testable without a database, and so there is exactly one answer to "what does this
 * search box mean".
 */
export const matchExpression = (rawQuery: string): string | null => buildMatchExpression(rawQuery);

/**
 * The ids of the items whose document matches `:param`, as a subquery (§5c, §20).
 *
 * **Never `SELECT "mediaId" FROM "MediaSearch"`.** `mediaId` is an UNINDEXED column of an
 * external-content table, so FTS5 answers it by fetching each match's whole `MediaSearchDoc`
 * row -- filename, OCR text, variants -- to return one UUID. A one-letter search matches most of
 * the library: 1,160 pages of documents on the production replica, for a list of ids that the
 * count, the page and every facet statement each built again. Matching yields rowids for
 * nothing, and `idx_MediaSearchDoc_rowid_mediaId` maps them (~160 pages for the whole library).
 * `INDEXED BY` because the planner prefers the table's own rowid lookup, which is the document
 * read again -- and so a dropped index is an error rather than a quiet return of the cost.
 *
 * One row per item: `MediaSearchDoc."mediaId"` is unique. That is what lets a caller join from
 * this as well as test membership in it (`mediaRepo`, a mentions filter driving the query).
 */
export const matchedIdsSql = (param: string): string =>
    `SELECT d."mediaId" FROM "MediaSearch" s
       CROSS JOIN "MediaSearchDoc" d INDEXED BY "idx_MediaSearchDoc_rowid_mediaId"
               ON d."rowid" = s."rowid"
      WHERE s."MediaSearch" MATCH :${param}`;

/**
 * SQL fragments the library query embeds, rather than a list of ids.
 *
 * The obvious interface — `search(text) -> mediaIds`, handed to the caller as an `IN (...)`
 * clause — does not survive contact with the library size this app is for. A broad search on
 * 200k items either builds a statement with 200k bound parameters, past SQLite's limit, or
 * caps the list and silently truncates the library to the first N matches, with paging and
 * totals both quietly wrong beyond it.
 *
 * Passing SQLite a subquery instead lets it intersect the FTS index with the access filter
 * itself, which is the one thing a separate search service could never do (§5c). What stays
 * contained is the part that matters: these two strings and `matchExpression` are the whole
 * FTS5 surface, and swapping the engine still touches only this file.
 *
 * Both expect a `:match` parameter bound to `matchExpression()`.
 */
/**
 * One word among the viewer's own tags on the item: a tag's name or one of its aliases, by
 * `tagNameMatchSql` (§5b), bound as `:${words}` and `:${squashed}`.
 *
 * **The `userId` predicate is the whole of the privacy guarantee here**, and it is bound from the
 * session rather than from anything a caller can name — the same rule `overlayUserId` follows.
 * Without it this would match on everybody's private vocabulary at once.
 */
const privateWordSql = (alias: string, words: string, squashed: string): string => `EXISTS (
    SELECT 1 FROM "MediaTag" mt${alias}
      JOIN "Tag" t${alias} ON t${alias}."id" = mt${alias}."tagId"
     WHERE mt${alias}."mediaId" = m."id"
       AND mt${alias}."userId" = :userId
       AND (${tagNameMatchSql(`t${alias}`, words, squashed)}
            OR EXISTS (SELECT 1 FROM "TagAlias" a${alias}
                        WHERE a${alias}."tagId" = t${alias}."id"
                          AND ${tagNameMatchSql(`a${alias}`, words, squashed)}))
)`;

/**
 * What the search box matches: the shared document, and the viewer's own tags, word by word
 * (§5c "One search across what you can see").
 *
 * - **The whole query in the document**, as before: `:match`, the full expression with its glued
 *   alternatives and its exclusions.
 * - **Or every word found one way or the other** — word `i` in the document (`:mw<i>`) or among
 *   the viewer's tags (`:pt<i>`/`:ps<i>`). "beach funny" finds an item whose document says beach
 *   and which you tagged funny; it used to need both in one place, so a mixed search found
 *   nothing. A word typed alone is the same as before: in the document or in your tags.
 * - **Minus every excluded word, on either side** (`:mx<j>`, `:px<j>`/`:pxs<j>`). The document
 *   side's exclusions were already in `:match`; the per-word path and the viewer's own tags need
 *   them stated, or `beach -funny` would show the item you tagged funny.
 *
 * Counts come from `searchTerms`, which built every bound value from one tokenisation. Zero
 * included words is the plain document match — a query of nothing but punctuation or exclusions.
 */
export const matchFilterSql = (included: number, excluded: number): string => {
    const shared = `m."id" IN (${matchedIdsSql("match")})`;

    if (included === 0) {
        return shared;
    }

    const eachWord = Array.from(
        { length: included },
        (_, i) =>
            `(m."id" IN (${matchedIdsSql(`mw${i}`)}) OR ${privateWordSql(`w${i}`, `pt${i}`, `ps${i}`)})`
    ).join(" AND ");
    const found = `(${shared} OR (${eachWord}))`;

    if (excluded === 0) {
        return found;
    }

    const anyExcluded = Array.from(
        { length: excluded },
        (_, j) =>
            `m."id" IN (${matchedIdsSql(`mx${j}`)}) OR ${privateWordSql(`x${j}`, `px${j}`, `pxs${j}`)}`
    ).join(" OR ");

    return `(${found} AND NOT (${anyExcluded}))`;
};

/**
 * Scores the shared document when results are ordered by relevance, because the score has to
 * come back with the row.
 *
 * bm25() returns a *negative* number, and more negative means a better match — so ascending
 * order is best-first. Sorting this descending is the classic way to produce an FTS5 result
 * set that looks plausible and is exactly backwards.
 *
 * **A LEFT JOIN, and the filter stays in the WHERE.** It used to be an inner join doing both
 * jobs at once, which cannot survive a second source of matches: an item found only by one of
 * the viewer's private tags has no document score, and an inner join would drop it from
 * relevance-sorted results while showing it in every other order. Left-joined, it survives with
 * a null score, and `SORT_COLUMNS` coalesces that to 0 — worse than any real bm25 value, so
 * private-only hits land after the text matches rather than in front of them.
 *
 * Keeping the filter in the WHERE also means one row per item however many ways it matched,
 * which is what stops a page duplicating rows and `hasMore` lying about the end of the library.
 *
 * Resolved to items through the rowid index for `matchedIdsSql`'s reason; `bm25()` reads the
 * index's column sizes, not the documents, so the score costs no document either.
 */
export const MATCH_JOIN_SQL = `LEFT JOIN (
    SELECT d."mediaId", bm25("MediaSearch", ${SEARCH_COLUMN_WEIGHTS.join(", ")}) AS "score"
      FROM "MediaSearch" s
     CROSS JOIN "MediaSearchDoc" d INDEXED BY "idx_MediaSearchDoc_rowid_mediaId"
             ON d."rowid" = s."rowid"
     WHERE s."MediaSearch" MATCH :match
) search ON search."mediaId" = m."id"`;
