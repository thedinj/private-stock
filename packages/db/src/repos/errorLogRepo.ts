import { randomUUID } from "node:crypto";

import { db } from "../db.js";

/**
 * Persisted errors, surfaced at /admin/error-logs.
 *
 * The point is the `requestId`: a user can report "it failed, id abc123" and the exact
 * stack is one query away, without asking them to reproduce anything.
 */

export interface LogErrorInput {
    requestId: string;
    userId?: string | null;
    code: string;
    message: string;
    stack?: string | null;
    path?: string | null;
    method?: string | null;
}

export const logError = (input: LogErrorInput): void => {
    db.prepare(
        `INSERT INTO "ErrorLog"
            ("id", "requestId", "userId", "code", "message", "stack", "path", "method")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        randomUUID(),
        input.requestId,
        input.userId ?? null,
        input.code.slice(0, 60),
        input.message.slice(0, 4000),
        input.stack?.slice(0, 20000) ?? null,
        input.path?.slice(0, 1024) ?? null,
        input.method?.slice(0, 10) ?? null
    );
};

export interface ErrorLogRow {
    id: string;
    requestId: string | null;
    userId: string | null;
    code: string;
    message: string;
    stack: string | null;
    path: string | null;
    method: string | null;
    createdAt: string;
}

export const listRecent = (limit = 100): ErrorLogRow[] =>
    db
        .prepare(`SELECT * FROM "ErrorLog" ORDER BY "createdAt" DESC LIMIT ?`)
        .all(limit) as ErrorLogRow[];
