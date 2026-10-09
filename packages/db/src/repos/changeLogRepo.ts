import { db } from "../db.js";

/**
 * The change feed (§13b).
 *
 * The process that *knows* about changes (the worker) is not the one holding the browser
 * connections (Next), and the two communicate through the database rather than HTTP (§2).
 * So the worker appends rows here in the same transaction as the change they describe, and
 * the web process tails the table with a single poller that fans out over SSE.
 *
 * Writing the row inside the change's own transaction is the load-bearing part: a change
 * that commits without its notification is a grid that silently goes stale, and there is no
 * later moment at which that can be detected and repaired.
 */

export type ChangeEntity = "media" | "artifact" | "variant" | "scan" | "job";
export type ChangeOp = "insert" | "update" | "delete";

export interface ChangeRow {
    id: number;
    entity: ChangeEntity;
    entityId: string | null;
    rootId: string | null;
    op: ChangeOp;
    detail: string | null;
    at: string;
}

export interface RecordChangeInput {
    entity: ChangeEntity;
    entityId?: string | null;
    rootId?: string | null;
    op: ChangeOp;
    /** Short free-form hint for the client, e.g. which artifact kind became ready. */
    detail?: string | null;
}

const insertStatement = () =>
    db.prepare(
        `INSERT INTO "ChangeLog" ("entity", "entityId", "rootId", "op", "detail")
         VALUES (?, ?, ?, ?, ?)`
    );

export const record = (change: RecordChangeInput): void => {
    insertStatement().run(
        change.entity,
        change.entityId ?? null,
        change.rootId ?? null,
        change.op,
        change.detail?.slice(0, 500) ?? null
    );
};

/**
 * Append several rows at once.
 *
 * A scan batch produces up to 200 changes, and 200 separate `INSERT`s inside an already-open
 * transaction is 200 statement preparations that a single reused statement avoids.
 */
export const recordMany = (changes: RecordChangeInput[]): void => {
    if (changes.length === 0) {
        return;
    }

    const statement = insertStatement();

    for (const change of changes) {
        statement.run(
            change.entity,
            change.entityId ?? null,
            change.rootId ?? null,
            change.op,
            change.detail?.slice(0, 500) ?? null
        );
    }
};

/**
 * The newest id, for a client starting fresh.
 *
 * A new connection resumes from *now* rather than from 0: a browser that has just loaded the
 * grid already has current data, and replaying an hour of scan history into it would be a
 * burst of animations describing changes it can already see.
 */
export const latestId = (): number => {
    const row = db.prepare(`SELECT COALESCE(max("id"), 0) AS "id" FROM "ChangeLog"`).get() as {
        id: number;
    };

    return row.id;
};

/**
 * Read changes after a cursor.
 *
 * `limit` is a safety valve, not paging. If a connection has fallen so far behind that it
 * would need more than this, the right answer is not to catch it up row by row — the caller
 * detects the truncation and tells the client to refetch instead.
 */
export const readSince = (cursor: number, limit = 500): ChangeRow[] =>
    db
        .prepare(
            `SELECT "id", "entity", "entityId", "rootId", "op", "detail", "at"
               FROM "ChangeLog"
              WHERE "id" > ?
              ORDER BY "id" ASC
              LIMIT ?`
        )
        .all(cursor, limit) as ChangeRow[];

/**
 * Drop rows older than the retention window.
 *
 * The feed is not history — nothing reads it except live connections, and a browser offline
 * for longer than the window resynchronises rather than replaying. Keeping it short is what
 * stops a 200k-file scan leaving 200k rows behind in a database meant to be small enough to
 * snapshot nightly.
 */
export const prune = (olderThanMinutes = 60): number =>
    db
        .prepare(
            `DELETE FROM "ChangeLog"
              WHERE "at" < datetime(CURRENT_TIMESTAMP, '-' || ? || ' minutes')`
        )
        .run(olderThanMinutes).changes;
