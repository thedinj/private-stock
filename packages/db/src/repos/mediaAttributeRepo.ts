import { randomUUID } from "node:crypto";

import type { MediaAttribute } from "@private-stock/core";

import { db } from "../db.js";

/**
 * Long-tail descriptive fields (§5b), one row per item and key.
 *
 * For display and search only. The one writer so far is the `metadata` stage, which owns the
 * `embedded` rows and nothing else: a key somebody typed, or a scraper filled, keeps its value.
 */

/** An item's fields, in key order — the order the search document and its mentions read. */
export const listForMedia = (mediaId: string): MediaAttribute[] =>
    db
        .prepare(
            `SELECT "key", "value", "source" FROM "MediaAttribute"
              WHERE "mediaId" = ? ORDER BY "key"`
        )
        .all(mediaId) as MediaAttribute[];

/**
 * Replace what the file said about itself last time with what it says now.
 *
 * Returns whether anything changed, so the caller rebuilds the search document only when it is
 * out of date: a sweep across a library whose files say nothing writes nothing.
 */
export const replaceEmbedded = (mediaId: string, found: ReadonlyMap<string, string>): boolean => {
    const rows = db
        .prepare(`SELECT "key", "value", "source" FROM "MediaAttribute" WHERE "mediaId" = ?`)
        .all(mediaId) as MediaAttribute[];

    // A key another source holds is not the file's to fill, so it is not a difference either.
    const heldElsewhere = new Set(
        rows.filter((row) => row.source !== "embedded").map((r) => r.key)
    );
    const wanted = [...found].filter(([key]) => !heldElsewhere.has(key));
    const current = new Map(
        rows.filter((row) => row.source === "embedded").map((row) => [row.key, row.value])
    );

    if (
        current.size === wanted.length &&
        wanted.every(([key, value]) => current.get(key) === value)
    ) {
        return false;
    }

    db.transaction(() => {
        db.prepare(
            `DELETE FROM "MediaAttribute" WHERE "mediaId" = ? AND "source" = 'embedded'`
        ).run(mediaId);

        const insert = db.prepare(
            `INSERT INTO "MediaAttribute" ("id", "mediaId", "key", "value", "source")
             VALUES (?, ?, ?, ?, 'embedded')`
        );

        for (const [key, value] of wanted) {
            insert.run(randomUUID(), mediaId, key, value);
        }
    })();

    return true;
};
