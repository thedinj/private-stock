import type { Mention, MentionField, TagNameEntry } from "@private-stock/core";

import { db } from "../db.js";

import { activeDecision } from "./faceDecisionRepo.js";

/**
 * Which tags an item's own text names (§5b "One rule for names").
 *
 * The rows are facts the name matcher derives — the worker computes them; this stores and reads
 * them. Every tag's names are matched, private ones included: who may *ask* about a private tag
 * is the query's rule (`mediaRepo`: the library's tags and the viewer's own), not this table's.
 */

/** Every tag's name and aliases, each pointing at its tag: what the matcher is built from. */
export const vocabulary = (): TagNameEntry[] =>
    db
        .prepare(
            `SELECT "id" AS "tagId", "name" FROM "Tag"
             UNION ALL
             SELECT "tagId", "name" FROM "TagAlias"
              ORDER BY "tagId", "name"`
        )
        .all() as TagNameEntry[];

/** One item's text as its search document holds it, by mention field. */
export interface DocumentTexts {
    cursor: number;
    mediaId: string;
    texts: Record<MentionField, string>;
}

/**
 * Search documents in rowid order, after `cursor`: the text a library-wide rematch reads.
 *
 * The document rather than the file, the title and the findings separately, because it is what
 * the index stage just assembled from all three — one row per item, and the same text search
 * itself reads.
 */
export const documentsAfter = (cursor: number, limit: number): DocumentTexts[] =>
    (
        db
            .prepare(
                `SELECT "rowid" AS "cursor", "mediaId", "filename", "title", "ocr"
                   FROM "MediaSearchDoc" WHERE "rowid" > ? ORDER BY "rowid" LIMIT ?`
            )
            .all(cursor, limit) as {
            cursor: number;
            mediaId: string;
            filename: string;
            title: string;
            ocr: string;
        }[]
    ).map((row) => ({
        cursor: row.cursor,
        mediaId: row.mediaId,
        texts: { filename: row.filename, title: row.title, screen: row.ocr },
    }));

const keyOf = (mention: Mention): string => `${mention.tagId}\t${mention.field}`;

const sameSet = (a: Mention[], b: Mention[]): boolean => {
    if (a.length !== b.length) {
        return false;
    }

    const keys = new Set(a.map(keyOf));

    return b.every((mention) => keys.has(keyOf(mention)));
};

const CHUNK = 500;

/**
 * Store these items' mentions, writing only the items whose mentions changed.
 *
 * The current rows are read first, outside any transaction, and compared: a library-wide rematch
 * after one new name changes a handful of items, and rewriting all of them would hold the write
 * lock for the whole library (§20). Returns how many items were written.
 */
export const writeChanged = (entries: { mediaId: string; mentions: Mention[] }[]): number => {
    const stored = new Map<string, Mention[]>();

    for (let i = 0; i < entries.length; i += CHUNK) {
        const ids = entries.slice(i, i + CHUNK).map((entry) => entry.mediaId);

        for (const row of db
            .prepare(
                `SELECT "mediaId", "tagId", "field" FROM "MediaMention"
                  WHERE "mediaId" IN (${ids.map(() => "?").join(", ")})`
            )
            .all(...ids) as { mediaId: string; tagId: string; field: MentionField }[]) {
            stored.set(row.mediaId, [
                ...(stored.get(row.mediaId) ?? []),
                { tagId: row.tagId, field: row.field },
            ]);
        }
    }

    const changed = entries.filter(
        (entry) => !sameSet(entry.mentions, stored.get(entry.mediaId) ?? [])
    );

    if (changed.length === 0) {
        return 0;
    }

    const clear = db.prepare(`DELETE FROM "MediaMention" WHERE "mediaId" = ?`);
    // OR IGNORE: a tag deleted since the matcher was built has no row to reference.
    const insert = db.prepare(
        `INSERT OR IGNORE INTO "MediaMention" ("mediaId", "tagId", "field")
         SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM "Tag" WHERE "id" = ?)`
    );

    db.transaction(() => {
        for (const { mediaId, mentions } of changed) {
            clear.run(mediaId);

            for (const { tagId, field } of mentions) {
                insert.run(mediaId, tagId, field, tagId);
            }
        }
    })();

    return changed.length;
};

/**
 * Items whose text names the tag bound as `:mentions` (§5d "Find untagged"), as a membership
 * test. Its own parameter so it composes with the search box, ANDed like every other filter.
 */
export const MENTION_FILTER_SQL = `m."id" IN (SELECT "mediaId" FROM "MediaMention" WHERE "tagId" = :mentions)
    AND m."id" NOT IN (SELECT "mediaId" FROM "ItemRefusal" WHERE "tagId" = :mentions)`;

/**
 * The same items as a row source, one per item, for a query driven from the mentions rather
 * than walking `Media` (`mediaRepo`'s choice, by `countMentioned`).
 */
export const MENTIONED_IDS_SQL = `SELECT DISTINCT mm."mediaId" FROM "MediaMention" mm
     WHERE mm."tagId" = :mentions
       AND NOT EXISTS (SELECT 1 FROM "ItemRefusal" r
                        WHERE r."tagId" = mm."tagId" AND r."mediaId" = mm."mediaId")`;

/** How many items name the tag, from `idx_MediaMention_tag` alone. */
export const countMentioned = (tagId: string): number =>
    db
        .prepare(`SELECT count(DISTINCT "mediaId") FROM "MediaMention" WHERE "tagId" = ?`)
        .pluck()
        .get(tagId) as number;

/**
 * Items whose own text names the tag but which do not carry it, among those this viewer can see,
 * with where each was named: the name half of a performer's "Likely" list (§5f).
 */
export const untaggedMentions = (
    tagId: string,
    rootIds: readonly string[]
): { mediaId: string; field: MentionField }[] => {
    if (rootIds.length === 0) {
        return [];
    }

    const params: Record<string, unknown> = { tagId };

    rootIds.forEach((id, i) => {
        params[`root${i}`] = id;
    });

    return db
        .prepare(
            `SELECT mm."mediaId", mm."field" FROM "MediaMention" mm
               JOIN "Media" m ON m."id" = mm."mediaId"
              WHERE mm."tagId" = :tagId AND m."listable" = 1
                AND m."listRootId" IN (${rootIds.map((_, i) => `:root${i}`).join(", ")})
                AND NOT EXISTS (SELECT 1 FROM "MediaTag" mt
                                 WHERE mt."mediaId" = mm."mediaId" AND mt."tagId" = :tagId)
                AND NOT EXISTS (SELECT 1 FROM "ItemRefusal" r
                                 WHERE r."tagId" = :tagId AND r."mediaId" = mm."mediaId")`
        )
        .all(params) as { mediaId: string; field: MentionField }[];
};

/**
 * The library performers an item's own text names that it does not carry and nobody refused for
 * it: the name half of "Maybe in this item" (§5f).
 */
export const untaggedPerformersNamedOn = (
    mediaId: string
): { tagId: string; field: MentionField }[] =>
    db
        .prepare(
            `SELECT mm."tagId", mm."field" FROM "MediaMention" mm
               JOIN "Tag" t ON t."id" = mm."tagId" AND t."kind" = 'performer' AND t."ownerId" IS NULL
              WHERE mm."mediaId" = ?
                AND NOT EXISTS (SELECT 1 FROM "MediaTag" mt
                                 WHERE mt."mediaId" = mm."mediaId" AND mt."tagId" = mm."tagId")
                AND NOT EXISTS (SELECT 1 FROM "ItemRefusal" r
                                 WHERE r."mediaId" = mm."mediaId" AND r."tagId" = mm."tagId")`
        )
        .all(mediaId) as { tagId: string; field: MentionField }[];

/**
 * "Not them", said of items whose own text names the tag (§5d "Find untagged"): the name match
 * stays a fact, and these items stop being offered for the tag. Returns the refusals added.
 */
export const refuse = (tagId: string, mediaIds: readonly string[], userId: string): number =>
    db
        .prepare(
            `INSERT OR IGNORE INTO "ItemRefusal" ("tagId", "mediaId", "decidedByUserId", "decisionId")
             SELECT ?, value, ?, ? FROM json_each(?)
              WHERE value IN (SELECT "mediaId" FROM "MediaMention" WHERE "tagId" = ?)`
        )
        .run(tagId, userId, activeDecision(), JSON.stringify(mediaIds), tagId).changes;

/**
 * "Not them on these items" (§5f "Decisions you can take back"): what taking a library performer
 * off items by hand says, whether or not their text names them. The items leave everything that
 * would offer or tag them as the performer, until the tag is added again. Returns the refusals
 * added.
 */
export const refuseItems = (tagId: string, mediaIds: readonly string[], userId: string): number =>
    db
        .prepare(
            `INSERT OR IGNORE INTO "ItemRefusal" ("tagId", "mediaId", "decidedByUserId", "decisionId")
             SELECT ?, value, ?, ? FROM json_each(?)`
        )
        .run(tagId, userId, activeDecision(), JSON.stringify(mediaIds)).changes;
