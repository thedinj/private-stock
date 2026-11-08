import { randomUUID } from "node:crypto";

import { db } from "../db.js";

/**
 * Review passes and their marks (§14d "Reviewing recordings for a reel").
 *
 * A pass belongs to one person and one room; a mark says an item has been through it. Every
 * function that reads somebody's passes takes the owner explicitly (§6). Whether a caller may
 * use a pass on an item -- whose it is, which room -- is the service's to decide; the rows here
 * carry what it needs to.
 *
 * Lists of ids travel as one JSON parameter (`json_each`), so a selection of five hundred is one
 * statement with one binding rather than five hundred placeholders.
 */

export interface ReviewPassRow {
    id: string;
    ownerId: string;
    domain: string;
    name: string;
}

export interface ReviewPassListRow extends ReviewPassRow {
    marks: number;
}

/**
 * Somebody's passes with how many items each has marked, in one room or in all of them.
 *
 * The count is a walk of the pass's own primary-key range, and people have a handful of passes,
 * so it is read every time rather than kept.
 */
export const listForOwner = (ownerId: string, domain: string | null): ReviewPassListRow[] =>
    db
        .prepare(
            `SELECT p."id", p."ownerId", p."domain", p."name",
                    (SELECT COUNT(*) FROM "ReviewMark" rm WHERE rm."passId" = p."id") AS "marks"
               FROM "ReviewPass" p
              WHERE p."ownerId" = :ownerId AND (:domain IS NULL OR p."domain" = :domain)
              ORDER BY p."domain", p."name"`
        )
        .all({ ownerId, domain }) as ReviewPassListRow[];

export const findById = (id: string): ReviewPassRow | undefined =>
    db
        .prepare(`SELECT "id", "ownerId", "domain", "name" FROM "ReviewPass" WHERE "id" = ?`)
        .get(id) as ReviewPassRow | undefined;

/** A pass by name, ignoring case as the unique constraint does. */
export const findByName = (
    ownerId: string,
    domain: string,
    name: string
): ReviewPassRow | undefined =>
    db
        .prepare(
            `SELECT "id", "ownerId", "domain", "name" FROM "ReviewPass"
              WHERE "ownerId" = ? AND "domain" = ? AND "name" = ?`
        )
        .get(ownerId, domain, name) as ReviewPassRow | undefined;

export const create = (ownerId: string, domain: string, name: string): string => {
    const id = randomUUID();

    db.prepare(
        `INSERT INTO "ReviewPass" ("id", "ownerId", "domain", "name", "updatedAt")
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(id, ownerId, domain, name);

    return id;
};

export const rename = (id: string, name: string): void => {
    db.prepare(
        `UPDATE "ReviewPass" SET "name" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?`
    ).run(name, id);
};

/**
 * Deletes a pass and its marks, returning how many marks went.
 *
 * The marks are deleted by name rather than left to the cascade, so the count is the number
 * actually removed and nothing depends on `foreign_keys` being on for the connection.
 */
export const remove = (id: string): number =>
    db.transaction((): number => {
        const marks = db.prepare(`DELETE FROM "ReviewMark" WHERE "passId" = ?`).run(id).changes;

        db.prepare(`DELETE FROM "ReviewPass" WHERE "id" = ?`).run(id);

        return marks;
    })();

/**
 * Marks items for a pass, returning how many were newly marked.
 *
 * `OR IGNORE`: marking an item again keeps the first date, so a second sitting over the same
 * items does not move "when" forward.
 */
export const mark = (passId: string, mediaIds: string[]): number =>
    db
        .prepare(
            `INSERT OR IGNORE INTO "ReviewMark" ("passId", "mediaId")
             SELECT ?, value FROM json_each(?)`
        )
        .run(passId, JSON.stringify(mediaIds)).changes;

/** Takes the mark off items, returning how many carried it. */
export const unmark = (passId: string, mediaIds: string[]): number =>
    db
        .prepare(
            `DELETE FROM "ReviewMark"
              WHERE "passId" = ? AND "mediaId" IN (SELECT value FROM json_each(?))`
        )
        .run(passId, JSON.stringify(mediaIds)).changes;

export interface ItemReviewRow {
    passId: string;
    name: string;
    reviewedAt: string;
}

/** The passes of one person's that an item has been through, oldest mark first. */
export const marksFor = (ownerId: string, mediaId: string): ItemReviewRow[] =>
    db
        .prepare(
            `SELECT rm."passId", p."name", rm."reviewedAt"
               FROM "ReviewMark" rm
               JOIN "ReviewPass" p ON p."id" = rm."passId"
              WHERE rm."mediaId" = ? AND p."ownerId" = ?
              ORDER BY rm."reviewedAt", p."name"`
        )
        .all(mediaId, ownerId) as ItemReviewRow[];

/**
 * The room each item is in: its library's (§21), by the original file `listRootId` follows. An
 * item with no original left to say is absent from the answer.
 */
export const itemDomains = (mediaIds: string[]): Map<string, string> =>
    new Map(
        (
            db
                .prepare(
                    `SELECT m."id", r."domain"
                       FROM "Media" m JOIN "MediaRoot" r ON r."id" = m."listRootId"
                      WHERE m."id" IN (SELECT value FROM json_each(?))`
                )
                .all(JSON.stringify(mediaIds)) as { id: string; domain: string }[]
        ).map((row) => [row.id, row.domain])
    );

/**
 * Carries one item's marks to the copy that outlives it (§10c), keeping the earlier date where
 * both have one. Returns how many marks were added or moved earlier.
 *
 * Every person's, because the merge runs as an administrator over data they cannot see -- the
 * reason `listOverlays` takes no user. **Only passes of the survivor's room** (§21), as tags are
 * copied: a Cellar pass has no business on a Parlour item. A survivor whose room cannot be read
 * takes everything. Copied, not moved, so a restored copy still has its own (§10).
 */
export const copyMarks = (fromMediaId: string, toMediaId: string): number => {
    if (fromMediaId === toMediaId) {
        return 0;
    }

    return db
        .prepare(
            `INSERT INTO "ReviewMark" ("passId", "mediaId", "reviewedAt")
             SELECT rm."passId", :to, rm."reviewedAt"
               FROM "ReviewMark" rm
               JOIN "ReviewPass" p ON p."id" = rm."passId"
              WHERE rm."mediaId" = :from
                AND (:room IS NULL OR p."domain" = :room)
             ON CONFLICT ("passId", "mediaId") DO UPDATE SET "reviewedAt" = excluded."reviewedAt"
              WHERE excluded."reviewedAt" < "ReviewMark"."reviewedAt"`
        )
        .run({
            from: fromMediaId,
            to: toMediaId,
            room: itemDomains([toMediaId]).get(toMediaId) ?? null,
        }).changes;
};
