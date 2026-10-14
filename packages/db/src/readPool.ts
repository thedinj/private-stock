import { existsSync } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

import {
    AuthorizationError,
    ConflictError,
    NotFoundError,
    PathSafetyError,
    ValidationError,
} from "@private-stock/core";

import { getDb } from "./db.js";
import { runNow, type ReadPlan, type ReadRequest } from "./reads.js";
import type { ReaderReply, ReaderRequest } from "./readThread.js";

/**
 * Reader threads for the web process (§20 "Reads off the thread").
 *
 * `better-sqlite3` is synchronous and Node serves on one thread, so a six-second statement was a
 * six-second pause for every request in the process: covers, video ranges and the next API call
 * all sat Pending behind it. `runOffThread` moves a plan's statements onto a small pool of worker
 * threads, each with its own read-only use of its own connection, and the main thread waits on
 * them the way it waits on a file read -- serving everything else meanwhile.
 *
 * WAL is what makes this free of new locking: readers never block each other or the worker's
 * writer, so a reader thread is one more reader of the kind there already are.
 */

/**
 * How many reader threads, `PRIVATE_STOCK_READ_THREADS`; 0 runs every plan inline as before.
 *
 * Two by default, because the container is given two CPUs and a reader spends its time waiting
 * on the disk rather than computing: a third would add a connection's cache and an isolate's heap
 * for a read the disk would serve no sooner. More plans than readers wait for one; the main
 * thread does not.
 */
const DEFAULT_READ_THREADS = 2;

const threadCount = (): number => {
    const raw = process.env.PRIVATE_STOCK_READ_THREADS?.trim();
    const configured = raw ? Number(raw) : NaN;

    return Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_READ_THREADS;
};

const THREAD_ENTRY = path.join("packages", "db", "dist", "readThread.js");

/**
 * The compiled thread entry, found by walking up from the working directory; null if absent.
 *
 * **Not `new URL("./readThread.js", import.meta.url)`, which is what a thread entry normally
 * is.** Next bundles this package into the web server despite `serverExternalPackages` -- it
 * does not externalise a workspace package -- and webpack reads that expression as an asset:
 * it copied the file alone into `.next/server/chunks/static/media/`, where its relative imports
 * resolve to nothing, and handed back a URL of its own that `fileURLToPath` refused. Every grid
 * page answered 500.
 *
 * So the entry is the compiled file on disk, found the way `findModelsDir` finds the models:
 * up from `apps/web` to the repo in development, and from `/app/apps/web` to `/app` in the
 * container, where the Dockerfile copies `packages/` whole. The thread loads the package's own
 * `dist` rather than the bundle, which is what it needs to resolve `better-sqlite3` and core.
 */
let entryPath: string | null | undefined;

const threadEntry = (): string | null => {
    if (entryPath !== undefined) return entryPath;

    let current = process.cwd();

    for (;;) {
        const candidate = path.join(current, THREAD_ENTRY);

        if (existsSync(candidate)) return (entryPath = candidate);

        const parent = path.dirname(current);

        if (parent === current) return (entryPath = null);

        current = parent;
    }
};

/**
 * Whether plans may go to threads at all; they do where `threadEntry` also finds one to start.
 *
 * Not under vitest, where plans run inline -- the same code minus the transport. `docker/smoke.sh`
 * is what loads the real thread.
 */
const threadsAvailable = (): boolean => threadCount() > 0 && !process.env.VITEST;

/** The typed errors a read can throw, rebuilt by name so `toErrorResponse` still recognises them. */
const TYPED_ERRORS: Record<string, { prototype: Error }> = {
    AuthorizationError,
    ConflictError,
    NotFoundError,
    PathSafetyError,
    ValidationError,
};

/**
 * An error as it crossed the thread boundary, made into one again.
 *
 * Structured cloning keeps no prototype, so the class is restored from the name -- which is what
 * lets a `NotFoundError` still answer 404 and a busy database still satisfy `isBusyError`.
 */
const rebuildError = (failure: Extract<ReaderReply, { ok: false }>["error"]): Error => {
    const type = TYPED_ERRORS[failure.name];
    const error: Error = type ? Object.create(type.prototype) : new Error(failure.message);

    return Object.assign(error, {
        name: failure.name,
        message: failure.message,
        ...(failure.code !== undefined && { code: failure.code }),
    });
};

interface Reader {
    worker: Worker;
    pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
    alive: boolean;
}

let nextId = 0;
let readers: Reader[] | null = null;
const idle: Reader[] = [];
const waiting: ((reader: Reader) => void)[] = [];

const startReader = (entry: string): Reader => {
    const reader: Reader = {
        worker: new Worker(entry, {
            env: { ...process.env, PRIVATE_STOCK_DB_ROLE: "reader" },
        }),
        pending: new Map(),
        alive: true,
    };

    reader.worker.on("message", (reply: ReaderReply) => {
        const call = reader.pending.get(reply.id);

        if (!call) return;

        reader.pending.delete(reply.id);

        if (reader.pending.size === 0) reader.worker.unref();

        if (reply.ok) call.resolve(reply.value);
        else call.reject(rebuildError(reply.error));
    });

    const fail = (error: Error): void => {
        if (!reader.alive) return;

        reader.alive = false;
        console.error(`[reads] reader thread stopped: ${error.message}`);

        for (const call of reader.pending.values()) call.reject(error);

        reader.pending.clear();

        const parked = idle.indexOf(reader);

        if (parked >= 0) idle.splice(parked, 1);

        // Replaced in place, so the pool keeps its size; the next lease gets the new one.
        const index = readers?.indexOf(reader) ?? -1;

        if (index >= 0 && readers) {
            readers[index] = startReader(entry);
            release(readers[index]);
        }
    };

    reader.worker.on("error", fail);
    reader.worker.on("exit", (code) => fail(new Error(`exited with code ${code}`)));

    // Idle, a reader must never be the reason the process stays up; `call` refs it while it has
    // an answer owed. After the listeners, because adding a `message` listener refs it again.
    reader.worker.unref();

    return reader;
};

const release = (reader: Reader): void => {
    if (!reader.alive) return;

    const next = waiting.shift();

    if (next) next(reader);
    else idle.push(reader);
};

/** A reader for one plan's whole run, so its statements share a snapshot and a cache. */
const lease = (entry: string): Promise<Reader> => {
    if (!readers) {
        readers = Array.from({ length: threadCount() }, () => startReader(entry));
        idle.push(...readers);
    }

    const reader = idle.pop();

    return reader ? Promise.resolve(reader) : new Promise((resolve) => waiting.push(resolve));
};

const call = (reader: Reader, message: ReaderRequest): Promise<unknown> =>
    new Promise((resolve, reject) => {
        if (!reader.alive) {
            reject(new Error("reader thread is not running"));
            return;
        }

        const id = nextId++;

        if (reader.pending.size === 0) reader.worker.ref();

        reader.pending.set(id, { resolve, reject });
        reader.worker.postMessage({ ...message, id });
    });

/**
 * Runs a plan with its statements on a reader thread, and everything else here.
 *
 * Inline under one deferred snapshot when there are no threads -- tests, `tsx`, or
 * `PRIVATE_STOCK_READ_THREADS=0` -- which is what the services did before plans existed.
 */
export const runOffThread = async <T>(plan: ReadPlan<T>): Promise<T> => {
    const entry = threadsAvailable() ? threadEntry() : null;

    if (entry === null) {
        return getDb()
            .transaction(() => runNow(plan))
            .deferred();
    }

    const reader = await lease(entry);

    try {
        await call(reader, { op: "begin" });

        let step = plan.next();

        while (!step.done) {
            let value: unknown;

            try {
                value = await call(reader, {
                    op: "read",
                    request: step.value satisfies ReadRequest,
                });
            } catch (error) {
                step = plan.throw(error);
                continue;
            }

            step = plan.next(value);
        }

        return step.value;
    } finally {
        await call(reader, { op: "end" }).catch(() => undefined);
        release(reader);
    }
};
