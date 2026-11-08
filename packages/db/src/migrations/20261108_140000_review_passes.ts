import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";

/**
 * Named review passes replace the single reviewed flag (§14d "Reviewing recordings for a reel").
 *
 * `UserMedia.reviewedAt` said "I have been through this one" once per item, and a Game Room
 * recording is gone through more than once, for different things: who is in it, then whether it
 * was a win. A pass is one of those questions -- one person's, in one room, by name -- and a mark
 * says an item has been through it, and when.
 *
 * **What exists moves into a pass called "Reviewed"**, one per person per room their marked items
 * are in. An item's room is its library's (`listRootId`, as `20261108_130000_game_room_previews`
 * reads it); an item with no original left to say is the cellar's, as everything made before
 * rooms was. Saved views that asked `reviewed: yes|no` ask the same of that pass, or lose the
 * condition when their owner has no such pass in the view's room -- they had marked nothing
 * there, so "Not reviewed" was everything and "Reviewed" was nothing. Addresses carrying the old
 * parameter are converted by the library page, which has the pass list (`legacyReviewedParams`).
 *
 * The name is spelt out here rather than imported: a migration is history, and must keep meaning
 * what it meant when it ran whatever the app later calls things.
 *
 * Idempotent: the tables are `IF NOT EXISTS`, the pass and its marks `OR IGNORE`, and the column
 * is only read and dropped while it is there. Down restores the column from the earliest mark
 * of any of the person's passes on the item -- best effort, since several passes collapse into
 * one flag -- and puts the saved views back the same way.
 */
const LEGACY_PASS = "Reviewed";

const hasReviewedAt = (db: Database): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('UserMedia') WHERE "name" = 'reviewedAt'`).get() !==
    undefined;

const hasTable = (db: Database, table: string): boolean =>
    db.prepare(`SELECT 1 FROM sqlite_master WHERE "type" = 'table' AND "name" = ?`).get(table) !==
    undefined;

interface FilterRow {
    id: string;
    userId: string;
    domain: string;
    queryJson: string;
}

const legacyPassId = (db: Database, ownerId: string, domain: string): string | undefined =>
    (
        db
            .prepare(
                `SELECT "id" FROM "ReviewPass"
                  WHERE "ownerId" = ? AND "domain" = ? AND "name" = ?`
            )
            .get(ownerId, domain, LEGACY_PASS) as { id: string } | undefined
    )?.id;

const parseQuery = (json: string): Record<string, unknown> | null => {
    try {
        const value: unknown = JSON.parse(json);

        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
};

/** Every saved view whose stored query passes `test`, rewritten by `rewrite`. */
const rewriteFilters = (
    db: Database,
    test: (query: Record<string, unknown>) => boolean,
    rewrite: (query: Record<string, unknown>, row: FilterRow) => Record<string, unknown>
): void => {
    const rows = db
        .prepare(`SELECT "id", "userId", "domain", "queryJson" FROM "SavedFilter"`)
        .all() as FilterRow[];
    const update = db.prepare(`UPDATE "SavedFilter" SET "queryJson" = ? WHERE "id" = ?`);

    for (const row of rows) {
        const query = parseQuery(row.queryJson);

        if (query && test(query)) {
            update.run(JSON.stringify(rewrite(query, row)), row.id);
        }
    }
};

export function up(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS "ReviewPass" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "ownerId" TEXT NOT NULL,
            "domain" TEXT NOT NULL CHECK(length("domain") BETWEEN 1 AND 32),
            "name" TEXT NOT NULL COLLATE NOCASE CHECK(length("name") BETWEEN 1 AND 60),
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE,
            UNIQUE ("ownerId", "domain", "name")
        );

        CREATE TABLE IF NOT EXISTS "ReviewMark" (
            "passId" TEXT NOT NULL,
            "mediaId" TEXT NOT NULL,
            "reviewedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY ("passId", "mediaId"),
            FOREIGN KEY ("passId") REFERENCES "ReviewPass" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS "idx_ReviewMark_mediaId" ON "ReviewMark" ("mediaId");
    `);

    if (!hasReviewedAt(db)) {
        return;
    }

    const rooms = db
        .prepare(
            `SELECT DISTINCT um."userId", COALESCE(r."domain", 'cellar') AS "domain"
               FROM "UserMedia" um
               JOIN "Media" m ON m."id" = um."mediaId"
               LEFT JOIN "MediaRoot" r ON r."id" = m."listRootId"
              WHERE um."reviewedAt" IS NOT NULL`
        )
        .all() as { userId: string; domain: string }[];
    const createPass = db.prepare(
        `INSERT OR IGNORE INTO "ReviewPass" ("id", "ownerId", "domain", "name", "updatedAt")
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
    );

    for (const room of rooms) {
        createPass.run(randomUUID(), room.userId, room.domain, LEGACY_PASS);
    }

    db.prepare(
        `INSERT OR IGNORE INTO "ReviewMark" ("passId", "mediaId", "reviewedAt")
         SELECT p."id", um."mediaId", um."reviewedAt"
           FROM "UserMedia" um
           JOIN "Media" m ON m."id" = um."mediaId"
           LEFT JOIN "MediaRoot" r ON r."id" = m."listRootId"
           JOIN "ReviewPass" p ON p."ownerId" = um."userId"
                              AND p."domain" = COALESCE(r."domain", 'cellar')
                              AND p."name" = ?
          WHERE um."reviewedAt" IS NOT NULL`
    ).run(LEGACY_PASS);

    rewriteFilters(
        db,
        (query) => "reviewed" in query,
        (query, row) => {
            const { reviewed, ...rest } = query;
            const passId = legacyPassId(db, row.userId, row.domain);

            if (passId && (reviewed === "yes" || reviewed === "no")) {
                rest[reviewed === "yes" ? "reviewedFor" : "notReviewedFor"] = [passId];
            }

            return rest;
        }
    );

    db.exec(`ALTER TABLE "UserMedia" DROP COLUMN "reviewedAt";`);
}

export function down(db: Database): void {
    if (!hasReviewedAt(db)) {
        db.exec(`ALTER TABLE "UserMedia" ADD COLUMN "reviewedAt" DATETIME;`);
    }

    if (!hasTable(db, "ReviewPass")) {
        return;
    }

    db.exec(`
        INSERT INTO "UserMedia" ("userId", "mediaId", "reviewedAt", "updatedAt")
        SELECT p."ownerId", rm."mediaId", MIN(rm."reviewedAt"), CURRENT_TIMESTAMP
          FROM "ReviewMark" rm
          JOIN "ReviewPass" p ON p."id" = rm."passId"
         WHERE 1
         GROUP BY p."ownerId", rm."mediaId"
        ON CONFLICT ("userId", "mediaId") DO UPDATE SET "reviewedAt" = excluded."reviewedAt";
    `);

    rewriteFilters(
        db,
        (query) => "reviewedFor" in query || "notReviewedFor" in query,
        (query, row) => {
            const { reviewedFor, notReviewedFor, ...rest } = query;
            const passId = legacyPassId(db, row.userId, row.domain);
            const names = (list: unknown): boolean =>
                passId !== undefined && Array.isArray(list) && list.includes(passId);

            if (names(reviewedFor)) rest.reviewed = "yes";
            else if (names(notReviewedFor)) rest.reviewed = "no";

            return rest;
        }
    );

    db.exec(`DROP TABLE IF EXISTS "ReviewMark"; DROP TABLE IF EXISTS "ReviewPass";`);
}
