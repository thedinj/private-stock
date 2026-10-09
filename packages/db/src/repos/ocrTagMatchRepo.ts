import { randomUUID } from "node:crypto";

import {
    buildTagMatcher,
    matchTagNames,
    type MediaKind,
    type MediaKindCounts,
    type OcrMatchState,
    type OcrMatchStatus,
    type TagMatcher,
    type TagNameEntry,
    type TagNameMatch,
} from "@private-stock/core";

import { db } from "../db.js";
import { recordMany } from "./changeLogRepo.js";
import type { StringCursor } from "./mediaTextRepo.js";
import { requestReindex } from "./searchRepo.js";
import { nextPosition } from "./tagRepo.js";

/**
 * Which performers and sources an OCR string names, and what was decided about each pair
 * (§5d "Tagging performers and sources from what was read").
 *
 * Matching itself is `matchTagNames` in core. `rematchStrings` is here, beside the statements it
 * drives, for the reason `replaceMachineFindings` calls `keepReviewed`: the worker after a read
 * and the web after a correction both need exactly this, and neither may skip a step of it.
 */

/** The facets matched. Keywords are ordinary words, and against bulk text they find noise. */
const MATCHED_KINDS = ["performer", "source"] as const;

const KIND_LIST = MATCHED_KINDS.map((kind) => `'${kind}'`).join(", ");

/** Every public performer and source name and alias, each pointing at its tag. */
export const matchVocabulary = (): TagNameEntry[] =>
    db
        .prepare(
            `SELECT "id" AS "tagId", "name" FROM "Tag"
              WHERE "ownerId" IS NULL AND "kind" IN (${KIND_LIST})
             UNION ALL
             SELECT t."id" AS "tagId", a."name" FROM "TagAlias" a
               JOIN "Tag" t ON t."id" = a."tagId"
              WHERE t."ownerId" IS NULL AND t."kind" IN (${KIND_LIST})
              ORDER BY "tagId", "name"`
        )
        .all() as TagNameEntry[];

export const loadMatcher = (): TagMatcher => buildTagMatcher(matchVocabulary());

/**
 * How many items carry the pair's string and not its tag, for an `OcrTagMatch` aliased `o`.
 *
 * Only findings nobody dismissed, only items the library shows, and not the items somebody left
 * out when the pair was accepted. `MediaTag."userId" IS NULL` both says "the library's tag" and
 * lets the probe use the public partial unique.
 */
const PENDING_COUNT = `(
    SELECT COUNT(DISTINCT t."mediaId")
      FROM "MediaText" t
      JOIN "Media" m ON m."id" = t."mediaId"
     WHERE t."textNorm" = o."textNorm"
       AND t."reviewState" IS NOT 'dismissed'
       AND m."listable" = 1
       AND NOT EXISTS (SELECT 1 FROM "MediaTag" mt
                        WHERE mt."mediaId" = t."mediaId" AND mt."tagId" = o."tagId"
                          AND mt."userId" IS NULL)
       AND NOT EXISTS (SELECT 1 FROM "OcrTagMatchSkip" s
                        WHERE s."matchId" = o."id" AND s."mediaId" = t."mediaId")
)`;

const chunks = <T>(items: T[], size = 500): T[][] => {
    const out: T[][] = [];

    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }

    return out;
};

const marks = (items: unknown[]): string => items.map(() => "?").join(", ");

// ─────────────────────────────────────────────────────────────────────────────
// Pending counts

/**
 * Bring the stored pending counts of these pairs up to date. Returns how many moved.
 *
 * Two steps, and the split is the point (§5d "Counts", §20). The live counts are **read first,
 * outside any transaction**: on the NAS that read is where the time goes, a few cold pages per
 * pair, and inside the web's `BEGIN IMMEDIATE` it held the write lock for seconds at a time —
 * the worker gave up after fifteen, a sign-in refresh after three. Then one short transaction
 * stores only the pairs whose count moved, which after a typical accept is a handful.
 *
 * Those few are **recomputed under the lock**, not written from the read. Something can commit
 * between the two steps — another accept, the worker's pass — and a number read before it would
 * overwrite the truth with what was true a moment ago. Recomputed, whoever writes last writes
 * what is true when they write; a pair the read found unchanged and a later commit changed is
 * that commit's own recount to store. The pages are the ones the read just touched.
 *
 * **Call it outside a transaction.** Inside one the read step holds whatever lock the
 * transaction holds, which is the freeze this replaced. Decisions commit first and recount
 * after, so a recount that fails (a busy database) leaves a decision without its count: the
 * next recount of that pair, or the worker's `ocrMatch` pass, which recounts every pair, puts
 * it right — and the review page never draws a row from a stored count alone.
 */
export const recountPending = (matchIds: string[]): number => {
    const moved: string[] = [];

    for (const chunk of chunks([...new Set(matchIds)])) {
        const rows = db
            .prepare(
                `SELECT o."id", o."pendingCount" AS "stored", ${PENDING_COUNT} AS "live"
                   FROM "OcrTagMatch" o
                  WHERE o."id" IN (${marks(chunk)})`
            )
            .all(...chunk) as { id: string; stored: number; live: number }[];

        moved.push(...rows.filter((row) => row.stored !== row.live).map((row) => row.id));
    }

    if (moved.length === 0) {
        return 0;
    }

    db.transaction(() => {
        for (const chunk of chunks(moved)) {
            db.prepare(
                `UPDATE "OcrTagMatch" AS o SET "pendingCount" = ${PENDING_COUNT}
                  WHERE o."id" IN (${marks(chunk)})`
            ).run(...chunk);
        }
    })();

    return moved.length;
};

/** Every pair of these strings, decided or not: what a change to their findings moves. */
export const pairsOfStrings = (textNorms: string[]): string[] =>
    chunks([...new Set(textNorms)]).flatMap(
        (chunk) =>
            db
                .prepare(`SELECT "id" FROM "OcrTagMatch" WHERE "textNorm" IN (${marks(chunk)})`)
                .pluck()
                .all(...chunk) as string[]
    );

/**
 * The pairs whose count a tag change on these items can move: a pair of one of these tags, for
 * a string one of these items was read showing. Nothing else can have moved — a pair's count is
 * its string's items less those carrying its own tag.
 *
 * Starts from the tags' pairs, a few each, and asks the findings' `(textNorm, mediaId, …)` index
 * whether each pair's string is on one of the items, which never reads a finding's row. With no
 * tags named (a facet replaced on one item, whose removed tags nobody listed) it is every pair of
 * every string the items show.
 */
export const pairsTouching = (mediaIds: string[], tagIds: string[] | null): string[] => {
    const media = [...new Set(mediaIds)];
    const tags = tagIds === null ? null : [...new Set(tagIds)];

    if (media.length === 0 || tags?.length === 0) {
        return [];
    }

    const found = new Set<string>();

    for (const chunk of chunks(media)) {
        const ids =
            tags === null
                ? (db
                      .prepare(
                          `SELECT DISTINCT o."id"
                             FROM "MediaText" t
                             JOIN "OcrTagMatch" o ON o."textNorm" = t."textNorm"
                            WHERE t."mediaId" IN (${marks(chunk)})`
                      )
                      .pluck()
                      .all(...chunk) as string[])
                : chunks(tags).flatMap(
                      (tagChunk) =>
                          db
                              .prepare(
                                  `SELECT o."id" FROM "OcrTagMatch" o
                                    WHERE o."tagId" IN (${marks(tagChunk)})
                                      AND EXISTS (SELECT 1 FROM "MediaText" t
                                                   WHERE t."textNorm" = o."textNorm"
                                                     AND t."mediaId" IN (${marks(chunk)}))`
                              )
                              .pluck()
                              .all(...tagChunk, ...chunk) as string[]
                  );

        ids.forEach((id) => found.add(id));
    }

    return [...found];
};

/** Every pair, a page at a time by id: what the worker's full recount walks. */
export const pairIdsPage = (after: string | null, limit: number): string[] =>
    db
        .prepare(
            `SELECT "id" FROM "OcrTagMatch"
              WHERE (? IS NULL OR "id" > ?)
              ORDER BY "id"
              LIMIT ?`
        )
        .pluck()
        .all(after, after, limit) as string[];

// ─────────────────────────────────────────────────────────────────────────────
// Matching

/** A string to match, with its display text, or no text when nothing undismissed reads it. */
export interface MatchableString {
    textNorm: string;
    text: string | undefined;
}

interface StoredPair {
    id: string;
    textNorm: string;
    tagId: string;
    kind: string;
    matchedText: string;
    score: number;
    state: OcrMatchState | null;
}

/**
 * Whether a string's stored pairs already say what the matcher says, so writing would change
 * nothing. A decided pair is never rewritten and a pending `manual` one is a person's proposal,
 * not the matcher's, so neither is anything the matcher can disagree with.
 */
const settled = (matches: TagNameMatch[], stored: StoredPair[]): boolean => {
    const byTag = new Map(stored.map((pair) => [pair.tagId, pair]));
    const proposed = new Set(matches.map((match) => match.tagId));

    return (
        stored.every(
            (pair) => pair.state !== null || pair.kind === "manual" || proposed.has(pair.tagId)
        ) &&
        matches.every((match) => {
            const pair = byTag.get(match.tagId);

            return (
                pair !== undefined &&
                (pair.state !== null ||
                    (pair.kind === match.kind &&
                        pair.matchedText === match.matchedText &&
                        pair.score === match.score))
            );
        })
    );
};

/**
 * Match strings whose text is already in hand, and write only the strings whose pairs change.
 *
 * Everything is read and matched before the transaction opens, so the transaction is the writes
 * and nothing else. Most strings match exactly as they did — a full rematch after one name was
 * coined changes a handful of the thousands it walks — and those cost no write at all.
 *
 * The statements are the absolute ones (delete what is not proposed, upsert what is), so a
 * string another process rematched in between ends up the same either way.
 */
export const matchKnownStrings = (strings: MatchableString[], matcher: TagMatcher): void => {
    const stored = new Map<string, StoredPair[]>();

    for (const chunk of chunks(strings.map((entry) => entry.textNorm))) {
        for (const pair of db
            .prepare(
                `SELECT "id", "textNorm", "tagId", "kind", "matchedText", "score", "state"
                   FROM "OcrTagMatch" WHERE "textNorm" IN (${marks(chunk)})`
            )
            .all(...chunk) as StoredPair[]) {
            stored.set(pair.textNorm, [...(stored.get(pair.textNorm) ?? []), pair]);
        }
    }

    const changed = strings
        .map((entry) => ({
            textNorm: entry.textNorm,
            matches: entry.text === undefined ? [] : matchTagNames(entry.text, matcher),
        }))
        .filter((entry) => !settled(entry.matches, stored.get(entry.textNorm) ?? []));

    if (changed.length === 0) {
        return;
    }

    const upsert = db.prepare(
        `INSERT INTO "OcrTagMatch" ("id", "textNorm", "tagId", "kind", "matchedText", "score")
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT ("textNorm", "tagId") DO UPDATE SET
             "kind" = excluded."kind",
             "matchedText" = excluded."matchedText",
             "score" = excluded."score"
          WHERE "OcrTagMatch"."state" IS NULL`
    );

    db.transaction(() => {
        for (const { textNorm, matches } of changed) {
            const keep = matches.map((match) => match.tagId);
            const others = keep.length === 0 ? "" : `AND "tagId" NOT IN (${marks(keep)})`;

            db.prepare(
                `DELETE FROM "OcrTagMatch"
                  WHERE "textNorm" = ? AND "state" IS NULL AND "kind" IS NOT 'manual' ${others}`
            ).run(textNorm, ...keep);

            for (const match of matches) {
                upsert.run(
                    randomUUID(),
                    textNorm,
                    match.tagId,
                    match.kind,
                    match.matchedText,
                    match.score
                );
            }
        }
    })();
};

/**
 * Match these strings against the vocabulary and store what was found, without recounting.
 * Returns every pair the strings now have: their counts are owed a `recountPending`, after the
 * caller's transaction commits. Inside one, this is what a correction runs; everywhere else it
 * is `rematchStrings`.
 *
 * A pending pair the string no longer names is dropped; a decided one is kept whatever the
 * matcher now says, because the decision is what stops a rejected pair coming back, and so is a
 * pending `manual` one, which somebody proposed by hand. A string that is gone, or that every
 * finding of was dismissed, keeps no pending pairs from the matcher at all.
 */
export const matchStrings = (
    textNorms: string[],
    matcher: TagMatcher = loadMatcher()
): string[] => {
    const unique = [...new Set(textNorms)];

    if (unique.length === 0) {
        return [];
    }

    const texts = new Map<string, string>();

    for (const chunk of chunks(unique)) {
        for (const row of db
            .prepare(
                `SELECT "textNorm", "text" FROM "MediaTextString"
                  WHERE "textNorm" IN (${marks(chunk)}) AND "rowCount" > "dismissedCount"`
            )
            .all(...chunk) as { textNorm: string; text: string }[]) {
            texts.set(row.textNorm, row.text);
        }
    }

    matchKnownStrings(
        unique.map((textNorm) => ({ textNorm, text: texts.get(textNorm) })),
        matcher
    );

    return pairsOfStrings(unique);
};

/**
 * Match these strings, apply what an accepted pair already decided, and recount: what the worker
 * after a read and the web after a review both owe a string whose findings changed. Outside a
 * transaction, like `recountPending`.
 */
export const rematchStrings = (textNorms: string[], matcher?: TagMatcher): void => {
    const ids = matchStrings(textNorms, matcher);
    const applied = applyRules(ids);

    recountPending([...ids, ...pairsTouching(applied.mediaIds, applied.tagIds)]);
};

// ─────────────────────────────────────────────────────────────────────────────
// Rules (§5d "An accepted pair is a rule")

/**
 * What an accepted pair still owes, for an `OcrTagMatch` aliased `o` joined to its findings `t`
 * and their items `m`: text read since the pair was decided, on an item the library shows, not
 * dismissed, without the tag, and not left out of it.
 *
 * Read **since the decision**, because every item that showed the string then was in front of
 * the person deciding: they tagged it or left it out. One that has lost the tag since is somebody
 * having taken it off, and a rule must not put it back.
 */
const RULE_OWED = `o."state" = 'accepted'
    AND t."createdAt" >= o."decidedAt"
    AND t."reviewState" IS NOT 'dismissed'
    AND m."listable" = 1
    AND NOT EXISTS (SELECT 1 FROM "MediaTag" mt
                     WHERE mt."mediaId" = t."mediaId" AND mt."tagId" = o."tagId"
                       AND mt."userId" IS NULL)
    AND NOT EXISTS (SELECT 1 FROM "OcrTagMatchSkip" s
                     WHERE s."matchId" = o."id" AND s."mediaId" = t."mediaId")`;

interface RuleOwed {
    mediaId: string;
    tagId: string;
    kind: string;
    decidedByUserId: string | null;
    /** The accept's batch, while it stands; what links a rule's tags to the rule. */
    batchId: string | null;
}

/** What tagging changed, for the caller's recount. */
export interface RulesApplied {
    mediaIds: string[];
    tagIds: string[];
}

/**
 * Tag what these pairs' rules are owed. Pairs that are not accepted are passed over, so a caller
 * hands in every pair it touched.
 *
 * Written as `source = 'ocr'`, which is what tells a tag a rule applied from one a person
 * clicked, attributed to whoever accepted the pair, **and in the accept's batch**. The batch is
 * the rule's link to everything it applied: when a duplicate is trashed its tags are copied to the
 * copy kept, batch and all (§10c), and that copy may not show the string — so withdrawing the rule
 * by undoing its batch reaches it where a search by string would not. Not an undone batch: a rule
 * whose accept was withdrawn from the bulk history writes unlinked rows rather than reviving it. Read first and written in one short
 * transaction, as everything here is (§5d "Counts"); the caller recounts afterwards.
 */
export const applyRules = (matchIds: string[]): RulesApplied => {
    const owed: RuleOwed[] = [];

    for (const chunk of chunks([...new Set(matchIds)])) {
        owed.push(
            ...(db
                .prepare(
                    `SELECT DISTINCT t."mediaId", o."tagId", g."kind", o."decidedByUserId",
                            b."id" AS "batchId"
                       FROM "OcrTagMatch" o
                       JOIN "Tag" g ON g."id" = o."tagId"
                       LEFT JOIN "TagBatch" b ON b."id" = o."batchId" AND b."undoneAt" IS NULL
                       JOIN "MediaText" t ON t."textNorm" = o."textNorm"
                       JOIN "Media" m ON m."id" = t."mediaId"
                      WHERE o."id" IN (${marks(chunk)}) AND ${RULE_OWED}`
                )
                .all(...chunk) as RuleOwed[])
        );
    }

    if (owed.length === 0) {
        return { mediaIds: [], tagIds: [] };
    }

    const insert = db.prepare(
        `INSERT OR IGNORE INTO "MediaTag"
             ("id", "mediaId", "tagId", "userId", "createdById", "source", "position", "batchId")
         VALUES (?, ?, ?, NULL, ?, 'ocr', ?, ?)`
    );
    const mediaIds = new Set<string>();
    const tagIds = new Set<string>();

    db.transaction(() => {
        for (const row of owed) {
            const position = nextPosition(row.mediaId, row.kind, null);

            if (
                insert.run(
                    randomUUID(),
                    row.mediaId,
                    row.tagId,
                    row.decidedByUserId,
                    position,
                    row.batchId
                ).changes > 0
            ) {
                mediaIds.add(row.mediaId);
                tagIds.add(row.tagId);
            }
        }

        // Tags are in the search document, and an open grid is told the way an edit tells it.
        requestReindex([...mediaIds]);
        recordMany(
            [...mediaIds].map((mediaId) => ({
                entity: "media",
                entityId: mediaId,
                op: "update",
                detail: "tags:ocr",
            }))
        );
    })();

    return { mediaIds: [...mediaIds], tagIds: [...tagIds] };
};

/** Every accepted pair, for the worker's pass that applies whatever a rule is still owed. */
export const acceptedPairIds = (): string[] =>
    db
        .prepare(`SELECT "id" FROM "OcrTagMatch" WHERE "state" = 'accepted' ORDER BY "id"`)
        .pluck()
        .all() as string[];

/**
 * Somebody took a performer or source off these items: no rule may put it back. Every accepted
 * pair of a missing tag, for a string the item shows, records the item as left out of it — the
 * same record an accept writes for an item unticked there.
 *
 * `tagIds` null when the caller cannot say which tags went (a facet replaced), which considers
 * every tag of `kind`. Adding tags declines nothing: a pair whose tag the item carries is not
 * missing.
 */
export const declineRules = (mediaIds: string[], tagIds: string[] | null, kind: string): void => {
    const media = [...new Set(mediaIds)];

    if (media.length === 0 || tagIds?.length === 0) {
        return;
    }

    const byTag = tagIds === null ? `g."kind" = ?` : `o."tagId" IN (${marks(tagIds)})`;
    const tagParams = tagIds === null ? [kind] : tagIds;

    for (const chunk of chunks(media)) {
        db.prepare(
            `INSERT OR IGNORE INTO "OcrTagMatchSkip" ("matchId", "mediaId")
             SELECT DISTINCT o."id", t."mediaId"
               FROM "MediaText" t
               JOIN "OcrTagMatch" o ON o."textNorm" = t."textNorm"
               JOIN "Tag" g ON g."id" = o."tagId"
              WHERE t."mediaId" IN (${marks(chunk)})
                AND o."state" = 'accepted'
                AND ${byTag}
                AND NOT EXISTS (SELECT 1 FROM "MediaTag" mt
                                 WHERE mt."mediaId" = t."mediaId" AND mt."tagId" = o."tagId"
                                   AND mt."userId" IS NULL)`
        ).run(...chunk, ...tagParams);
    }
};

/**
 * Take off the tags a pair's rule applied, when the pair is withdrawn. Only `ocr` rows: what a
 * person accepted goes with its batch, and what somebody typed stays. Returns the items, which
 * other accepted pairs of the same tag may still be owed.
 */
export const withdrawRuleTags = (matchId: string): string[] =>
    db
        .prepare(
            `DELETE FROM "MediaTag"
              WHERE "source" = 'ocr' AND "userId" IS NULL
                AND "tagId" = (SELECT "tagId" FROM "OcrTagMatch" WHERE "id" = ?)
                AND "mediaId" IN (SELECT t."mediaId" FROM "MediaText" t
                                    JOIN "OcrTagMatch" o ON o."textNorm" = t."textNorm"
                                   WHERE o."id" = ?)
          RETURNING "mediaId"`
        )
        .pluck()
        .all(matchId, matchId) as string[];

export interface RuleTagRow {
    id: string;
    mediaId: string;
    tagId: string;
    tagName: string;
    tagKind: string;
    createdAt: string;
}

/** Where a page of rule-applied tags continues from. */
export interface RuleTagCursor {
    at: string;
    id: string;
}

/**
 * Tags rules applied, newest first: the log an administrator checks the automation against.
 * Walks the partial index that holds exactly these rows.
 */
export const listRuleTags = (query: {
    rootIds: string[];
    after: RuleTagCursor | null;
    limit: number;
}): { rows: RuleTagRow[]; next: RuleTagCursor | null } => {
    if (query.rootIds.length === 0) {
        return { rows: [], next: null };
    }

    const rows = db
        .prepare(
            `SELECT mt."id", mt."mediaId", mt."tagId", g."name" AS "tagName",
                    g."kind" AS "tagKind", mt."createdAt"
               FROM "MediaTag" mt INDEXED BY "idx_MediaTag_ocr"
               JOIN "Tag" g ON g."id" = mt."tagId"
               JOIN "Media" m ON m."id" = mt."mediaId"
              WHERE mt."source" = 'ocr' AND mt."userId" IS NULL
                AND m."listable" = 1
                AND m."listRootId" IN (${marks(query.rootIds)})
                AND (? IS NULL OR (mt."createdAt", mt."id") < (?, ?))
              ORDER BY mt."createdAt" DESC, mt."id" DESC
              LIMIT ?`
        )
        .all(
            ...query.rootIds,
            query.after?.at ?? null,
            query.after?.at ?? null,
            query.after?.id ?? null,
            query.limit + 1
        ) as RuleTagRow[];

    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];

    return {
        rows: page,
        next: rows.length > query.limit && last ? { at: last.createdAt, id: last.id } : null,
    };
};

export const findRuleTag = (id: string): RuleTagRow | undefined =>
    db
        .prepare(
            `SELECT mt."id", mt."mediaId", mt."tagId", g."name" AS "tagName",
                    g."kind" AS "tagKind", mt."createdAt"
               FROM "MediaTag" mt JOIN "Tag" g ON g."id" = mt."tagId"
              WHERE mt."id" = ? AND mt."source" = 'ocr' AND mt."userId" IS NULL`
        )
        .get(id) as RuleTagRow | undefined;

/** One finding on the item that a rule for this tag was applied from, for the log's frame. */
export const ruleFinding = (mediaId: string, tagId: string): SampleFinding | undefined =>
    db
        .prepare(
            `SELECT t."mediaId", m."kind", t."text", t."firstAtMs",
                    t."boxX", t."boxY", t."boxW", t."boxH"
               FROM "MediaText" t
               JOIN "Media" m ON m."id" = t."mediaId"
               JOIN "OcrTagMatch" o ON o."textNorm" = t."textNorm"
              WHERE t."mediaId" = ? AND o."tagId" = ? AND o."state" = 'accepted'
              ORDER BY t."firstAtMs"
              LIMIT 1`
        )
        .get(mediaId, tagId) as SampleFinding | undefined;

/**
 * Every string still worth matching, with its text, a page at a time by `textNorm`: what a full
 * rematch walks when the vocabulary changes.
 */
export const matchableStrings = (after: string | null, limit: number): MatchableString[] =>
    db
        .prepare(
            `SELECT "textNorm", "text" FROM "MediaTextString"
              WHERE "rowCount" > "dismissedCount" AND (? IS NULL OR "textNorm" > ?)
              ORDER BY "textNorm"
              LIMIT ?`
        )
        .all(after, after, limit) as MatchableString[];

/**
 * Pending pairs for strings that no longer exist at all. Their counts are already zero, so they
 * are not queued; this only stops them accumulating. Found by a read, deleted by id.
 */
export const pruneOrphans = (): number => {
    const orphan = `o."state" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "MediaTextString" s WHERE s."textNorm" = o."textNorm")`;
    const ids = db
        .prepare(`SELECT o."id" FROM "OcrTagMatch" o WHERE ${orphan}`)
        .pluck()
        .all() as string[];

    if (ids.length === 0) {
        return 0;
    }

    return db.transaction(() =>
        chunks(ids).reduce(
            (sum, chunk) =>
                sum +
                db
                    .prepare(
                        `DELETE FROM "OcrTagMatch" AS o
                          WHERE o."id" IN (${marks(chunk)}) AND ${orphan}`
                    )
                    .run(...chunk).changes,
            0
        )
    )();
};

// ─────────────────────────────────────────────────────────────────────────────
// The queue: items whose text names somebody, newest first (§5d "The queue is items")

/**
 * An open pair on one of its items, for an `OcrTagMatch` aliased `o`, its findings `t` and their
 * items `m`: undecided, not dismissed, shown by the library, untagged and not left out.
 *
 * Both halves of the partial index's condition are spelled out, which is what lets SQLite use
 * `idx_OcrTagMatch_queued` to find the few pairs worth joining at all.
 */
const ITEM_OPEN = `o."state" IS NOT 'rejected' AND o."pendingCount" > 0 AND o."state" IS NULL
    AND t."reviewState" IS NOT 'dismissed'
    AND m."listable" = 1
    AND NOT EXISTS (SELECT 1 FROM "MediaTag" mt
                     WHERE mt."mediaId" = t."mediaId" AND mt."tagId" = o."tagId"
                       AND mt."userId" IS NULL)
    AND NOT EXISTS (SELECT 1 FROM "OcrTagMatchSkip" s
                     WHERE s."matchId" = o."id" AND s."mediaId" = t."mediaId")`;

const OPEN_FROM = `"OcrTagMatch" o
    JOIN "MediaText" t ON t."textNorm" = o."textNorm"
    JOIN "Media" m ON m."id" = t."mediaId"`;

/** Where a page of the queue continues from: the last item's match time and its id. */
export interface QueueCursor {
    at: string;
    mediaId: string;
}

/**
 * A page of items with something to decide, most recently matched first.
 *
 * An item is matched when it was read or when the pair appeared, whichever is later, so a video
 * read today and an old one a performer added today both come to the top. The set is the open
 * pairs' items — tens, or a few hundred after a name is coined — so it is grouped whole and
 * paged from a keyset over the grouping.
 */
export const listItemQueue = (query: {
    rootIds: string[];
    after: QueueCursor | null;
    limit: number;
    /** Videos or photos only; both when absent. */
    media?: MediaKind;
}): { rows: Array<{ mediaId: string; matchedAt: string }>; next: QueueCursor | null } => {
    if (query.rootIds.length === 0) {
        return { rows: [], next: null };
    }

    const rows = db
        .prepare(
            `SELECT "mediaId", "matchedAt" FROM (
                 SELECT t."mediaId", MAX(MAX(t."createdAt", o."createdAt")) AS "matchedAt"
                   FROM ${OPEN_FROM}
                  WHERE ${ITEM_OPEN} AND m."listRootId" IN (${marks(query.rootIds)})
                    AND (? IS NULL OR m."kind" = ?)
                  GROUP BY t."mediaId"
             )
             WHERE (? IS NULL OR ("matchedAt", "mediaId") < (?, ?))
             ORDER BY "matchedAt" DESC, "mediaId" DESC
             LIMIT ?`
        )
        .all(
            ...query.rootIds,
            query.media ?? null,
            query.media ?? null,
            query.after?.at ?? null,
            query.after?.at ?? null,
            query.after?.mediaId ?? null,
            query.limit + 1
        ) as Array<{ mediaId: string; matchedAt: string }>;

    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];

    return {
        rows: page,
        next:
            rows.length > query.limit && last
                ? { at: last.matchedAt, mediaId: last.mediaId }
                : null,
    };
};

/** Items with something to decide, videos and photos apart: what the page and the nav lead with. */
export const countItemQueue = (rootIds: string[]): MediaKindCounts => {
    const counts: MediaKindCounts = { video: 0, image: 0 };

    if (rootIds.length === 0) {
        return counts;
    }

    const rows = db
        .prepare(
            `SELECT m."kind", COUNT(DISTINCT t."mediaId") AS n FROM ${OPEN_FROM}
              WHERE ${ITEM_OPEN} AND m."listRootId" IN (${marks(rootIds)})
              GROUP BY m."kind"`
        )
        .all(...rootIds) as { kind: MediaKind; n: number }[];

    for (const row of rows) {
        counts[row.kind] = row.n;
    }

    return counts;
};

/** One open pair as one item shows it: the finding it was read from and the tag it names. */
export interface ItemCandidateRow {
    mediaId: string;
    mediaKind: "image" | "video";
    text: string;
    textNorm: string;
    firstAtMs: number | null;
    boxX: number | null;
    boxY: number | null;
    boxW: number | null;
    boxH: number | null;
    id: string;
    tagId: string;
    tagName: string;
    tagKind: string;
    kind: "exact" | "contains" | "near" | "manual";
    matchedText: string;
    /** The name was added after the item was read: what brought an old item back. */
    newName: number;
    /** Live, across every item showing the string: what accepting tags. */
    untagged: number;
}

/**
 * The open pairs of these items, each with the finding it came from. An item showing a string in
 * two places gets the earlier, which is the one to jump to.
 */
export const itemCandidates = (mediaIds: string[]): ItemCandidateRow[] => {
    const rows = chunks([...new Set(mediaIds)]).flatMap(
        (chunk) =>
            db
                .prepare(
                    `SELECT t."mediaId", m."kind" AS "mediaKind", t."text", t."textNorm",
                            t."firstAtMs", t."boxX", t."boxY", t."boxW", t."boxH",
                            o."id", o."tagId", g."name" AS "tagName", g."kind" AS "tagKind",
                            o."kind", o."matchedText",
                            (g."createdAt" > t."createdAt") AS "newName",
                            ${PENDING_COUNT} AS "untagged"
                       FROM ${OPEN_FROM}
                       JOIN "Tag" g ON g."id" = o."tagId"
                      WHERE t."mediaId" IN (${marks(chunk)}) AND ${ITEM_OPEN}
                      ORDER BY t."mediaId", t."firstAtMs", o."score" DESC, g."name"`
                )
                .all(...chunk) as ItemCandidateRow[]
    );
    const seen = new Set<string>();

    return rows.filter((row) => {
        const key = `${row.mediaId}:${row.id}`;

        if (seen.has(key)) {
            return false;
        }

        seen.add(key);

        return true;
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// Decided pairs, by string: the Rules list

/** Which strings each status lists: any pair in that condition. */
const STATUS_PAIR: Record<OcrMatchStatus, string> = {
    accepted: `o."state" = 'accepted'`,
    rejected: `o."state" = 'rejected'`,
};

const likeContains = (search: string): string =>
    `%${search.toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

export interface QueueString {
    textNorm: string;
    text: string;
    rowCount: number;
}

/**
 * A page of strings with a pair in the given condition, most-read first.
 *
 * Walks `MediaTextString` in the order of its own count index and probes the pairs for each, so
 * a page costs the strings it skips over, not a sort of the pairs. With a few thousand matched
 * strings among tens of thousands that is a short walk; a stored per-string flag is the answer if
 * it stops being one.
 */
export const listQueue = (query: {
    status: OcrMatchStatus;
    search?: string;
    after: StringCursor | null;
    limit: number;
}): { rows: QueueString[]; next: StringCursor | null } => {
    const where = [
        `EXISTS (SELECT 1 FROM "OcrTagMatch" o
                  WHERE o."textNorm" = s."textNorm" AND ${STATUS_PAIR[query.status]})`,
    ];
    const params: unknown[] = [];

    if (query.search) {
        where.push(`s."textNorm" LIKE ? ESCAPE '\\'`);
        params.push(likeContains(query.search));
    }

    if (query.after) {
        where.push(`(-s."rowCount", s."textNorm") > (?, ?)`);
        params.push(query.after.value, query.after.textNorm);
    }

    const rows = db
        .prepare(
            `SELECT s."textNorm", s."text", s."rowCount"
               FROM "MediaTextString" s INDEXED BY "idx_MediaTextString_count"
              WHERE ${where.join(" AND ")}
              ORDER BY -s."rowCount", s."textNorm"
              LIMIT ?`
        )
        .all(...params, query.limit + 1) as QueueString[];

    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];

    return {
        rows: page,
        next:
            rows.length > query.limit && last
                ? { value: -last.rowCount, textNorm: last.textNorm }
                : null,
    };
};

export interface CandidateRow {
    id: string;
    textNorm: string;
    tagId: string;
    tagName: string;
    tagKind: string;
    kind: "exact" | "contains" | "near" | "manual";
    matchedText: string;
    score: number;
    state: OcrMatchState | null;
    batchId: string | null;
    /** Live, not the stored count: this is the number somebody is about to act on. */
    untagged: number;
}

const CANDIDATE_COLUMNS = `o."id", o."textNorm", o."tagId", t."name" AS "tagName", t."kind" AS "tagKind",
       o."kind", o."matchedText", o."score", o."state", o."batchId",
       ${PENDING_COUNT} AS "untagged"`;

/** Every pair of these strings, strongest first within each. */
export const candidatesFor = (textNorms: string[]): CandidateRow[] =>
    chunks(textNorms).flatMap(
        (chunk) =>
            db
                .prepare(
                    `SELECT ${CANDIDATE_COLUMNS}
                       FROM "OcrTagMatch" o JOIN "Tag" t ON t."id" = o."tagId"
                      WHERE o."textNorm" IN (${chunk.map(() => "?").join(", ")})
                      ORDER BY o."textNorm", o."score" DESC, t."name"`
                )
                .all(...chunk) as CandidateRow[]
    );

/** These strings' pairs for these tags, as they stand now. */
export const findPairs = (textNorm: string, tagIds: string[]): CandidateRow[] =>
    tagIds.length === 0
        ? []
        : (db
              .prepare(
                  `SELECT ${CANDIDATE_COLUMNS}
                     FROM "OcrTagMatch" o JOIN "Tag" t ON t."id" = o."tagId"
                    WHERE o."textNorm" = ? AND o."tagId" IN (${tagIds.map(() => "?").join(", ")})`
              )
              .all(textNorm, ...tagIds) as CandidateRow[]);

/**
 * The same pairs without their live counts: for inside a transaction, where a count is pages
 * read while holding the write lock and the caller only needs to know which pairs exist.
 */
export const findPairIds = (
    textNorm: string,
    tagIds: string[]
): Array<{ id: string; tagId: string }> =>
    tagIds.length === 0
        ? []
        : (db
              .prepare(
                  `SELECT "id", "tagId" FROM "OcrTagMatch"
                    WHERE "textNorm" = ? AND "tagId" IN (${marks(tagIds)})`
              )
              .all(textNorm, ...tagIds) as Array<{ id: string; tagId: string }>);

/** The items a pair would tag now. */
export const pendingMediaIds = (matchId: string): string[] =>
    db
        .prepare(
            `SELECT DISTINCT t."mediaId"
               FROM "OcrTagMatch" o
               JOIN "MediaText" t ON t."textNorm" = o."textNorm"
               JOIN "Media" m ON m."id" = t."mediaId"
              WHERE o."id" = ?
                AND t."reviewState" IS NOT 'dismissed'
                AND m."listable" = 1
                AND NOT EXISTS (SELECT 1 FROM "MediaTag" mt
                                 WHERE mt."mediaId" = t."mediaId" AND mt."tagId" = o."tagId"
                                   AND mt."userId" IS NULL)
                AND NOT EXISTS (SELECT 1 FROM "OcrTagMatchSkip" s
                                 WHERE s."matchId" = o."id" AND s."mediaId" = t."mediaId")`
        )
        .pluck()
        .all(matchId) as string[];

/** Which of these items already carry which of these tags, as `mediaId:tagId`. */
export const taggedPairs = (mediaIds: string[], tagIds: string[]): Set<string> => {
    if (mediaIds.length === 0 || tagIds.length === 0) {
        return new Set();
    }

    return new Set(
        db
            .prepare(
                `SELECT "mediaId" || ':' || "tagId" FROM "MediaTag"
                  WHERE "userId" IS NULL
                    AND "mediaId" IN (${mediaIds.map(() => "?").join(", ")})
                    AND "tagId" IN (${tagIds.map(() => "?").join(", ")})`
            )
            .pluck()
            .all(...mediaIds, ...tagIds) as string[]
    );
};

/** Which of these items were left out of which of these pairs, as `mediaId:matchId`. */
export const skippedPairs = (mediaIds: string[], matchIds: string[]): Set<string> => {
    if (mediaIds.length === 0 || matchIds.length === 0) {
        return new Set();
    }

    return new Set(
        db
            .prepare(
                `SELECT "mediaId" || ':' || "matchId" FROM "OcrTagMatchSkip"
                  WHERE "mediaId" IN (${mediaIds.map(() => "?").join(", ")})
                    AND "matchId" IN (${matchIds.map(() => "?").join(", ")})`
            )
            .pluck()
            .all(...mediaIds, ...matchIds) as string[]
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// Decisions

/** A pair somebody chose by hand, for a string the matcher did not connect to that tag. */
export const ensureManual = (textNorm: string, tagId: string, matchedText: string): void => {
    db.prepare(
        `INSERT INTO "OcrTagMatch" ("id", "textNorm", "tagId", "kind", "matchedText", "score")
         VALUES (?, ?, ?, 'manual', ?, 1)
         ON CONFLICT ("textNorm", "tagId") DO UPDATE SET "state" = NULL,
             "batchId" = NULL, "decidedByUserId" = NULL, "decidedAt" = NULL`
    ).run(randomUUID(), textNorm, tagId, matchedText.slice(0, 500));
};

export const decide = (
    matchIds: string[],
    state: OcrMatchState,
    userId: string,
    batchId: string | null = null
): void => {
    for (const chunk of chunks(matchIds)) {
        db.prepare(
            `UPDATE "OcrTagMatch"
                SET "state" = ?, "batchId" = ?, "decidedByUserId" = ?,
                    "decidedAt" = CURRENT_TIMESTAMP
              WHERE "id" IN (${chunk.map(() => "?").join(", ")})`
        ).run(state, batchId, userId, ...chunk);
    }
};

export const addSkips = (matchId: string, mediaIds: string[]): void => {
    const insert = db.prepare(
        `INSERT OR IGNORE INTO "OcrTagMatchSkip" ("matchId", "mediaId") VALUES (?, ?)`
    );

    for (const mediaId of mediaIds) {
        insert.run(matchId, mediaId);
    }
};

/** Back to undecided. Returns the pairs reopened, whose counts the caller recounts. */
export const reopen = (matchIds: string[]): string[] =>
    chunks([...new Set(matchIds)]).flatMap(
        (chunk) =>
            db
                .prepare(
                    `UPDATE "OcrTagMatch"
                        SET "state" = NULL, "batchId" = NULL, "decidedByUserId" = NULL,
                            "decidedAt" = NULL
                      WHERE "id" IN (${marks(chunk)})
                  RETURNING "id"`
                )
                .pluck()
                .all(...chunk) as string[]
    );

/** Reopen whatever an undone bulk-tag batch had accepted. Returns the pairs reopened. */
export const reopenForBatch = (batchId: string): string[] => {
    const ids = db
        .prepare(`SELECT "id" FROM "OcrTagMatch" WHERE "batchId" = ?`)
        .pluck()
        .all(batchId) as string[];

    return reopen(ids);
};

export const findById = (matchId: string): CandidateRow | undefined =>
    db
        .prepare(
            `SELECT ${CANDIDATE_COLUMNS}
               FROM "OcrTagMatch" o JOIN "Tag" t ON t."id" = o."tagId"
              WHERE o."id" = ?`
        )
        .get(matchId) as CandidateRow | undefined;

/** A string's display text, or undefined when nothing reads it any more. */
export const stringText = (textNorm: string): string | undefined =>
    db
        .prepare(`SELECT "text" FROM "MediaTextString" WHERE "textNorm" = ?`)
        .pluck()
        .get(textNorm) as string | undefined;

export interface SampleFinding {
    mediaId: string;
    kind: "image" | "video";
    text: string;
    firstAtMs: number | null;
    boxX: number | null;
    boxY: number | null;
    boxW: number | null;
    boxH: number | null;
}

/**
 * One place the string was read, for the row's thumbnail: the first by id, which is one probe of
 * the findings' `textNorm` index however many items show the string.
 */
export const sampleFinding = (textNorm: string): SampleFinding | undefined =>
    db
        .prepare(
            `SELECT t."mediaId", m."kind", t."text", t."firstAtMs",
                    t."boxX", t."boxY", t."boxW", t."boxH"
               FROM "MediaText" t JOIN "Media" m ON m."id" = t."mediaId"
              WHERE t."textNorm" = ? AND t."reviewState" IS NOT 'dismissed' AND m."listable" = 1
              ORDER BY t."mediaId"
              LIMIT 1`
        )
        .get(textNorm) as SampleFinding | undefined;
