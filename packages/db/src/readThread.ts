/**
 * A reader thread: runs the web process's slow statements on a connection of its own (§20
 * "Reads off the thread").
 *
 * Started by `readPool.ts`, never imported. It answers three messages, always in order, from
 * one plan at a time: `begin` opens a deferred read transaction, so the plan's statements share
 * one snapshot and one warm cache exactly as `inOneSnapshot` gave them on the main thread; `read`
 * runs one named statement from `reads.ts`; `end` closes the transaction.
 *
 * Its connection is opened with `PRIVATE_STOCK_DB_ROLE=reader`, set by the pool, which gives it
 * a cache sized for a reader rather than the web process's own (`cacheKibibytes`).
 */
import { parentPort } from "node:worker_threads";

import { getDb } from "./db.js";
import { runRead, type ReadRequest } from "./reads.js";

export type ReaderRequest = { op: "begin" } | { op: "read"; request: ReadRequest } | { op: "end" };

export type ReaderMessage = ReaderRequest & { id: number };

export type ReaderReply =
    | { id: number; ok: true; value: unknown }
    | { id: number; ok: false; error: { name: string; message: string; code?: unknown } };

const port = parentPort;

if (!port) {
    throw new Error("readThread.js is a worker thread entry; readPool.ts starts it");
}

const handle = (message: ReaderMessage): unknown => {
    const database = getDb();

    switch (message.op) {
        case "begin":
            database.exec("BEGIN DEFERRED");
            return null;
        case "read":
            return runRead(message.request);
        case "end":
            // Rolled back rather than committed: nothing here wrote, and a rollback cannot fail
            // for want of a lock.
            if (database.inTransaction) database.exec("ROLLBACK");
            return null;
    }
};

port.on("message", (message: ReaderMessage) => {
    try {
        port.postMessage({
            id: message.id,
            ok: true,
            value: handle(message),
        } satisfies ReaderReply);
    } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));

        port.postMessage({
            id: message.id,
            ok: false,
            error: {
                name: failure.name,
                message: failure.message,
                code: "code" in failure ? failure.code : undefined,
            },
        } satisfies ReaderReply);
    }
});
