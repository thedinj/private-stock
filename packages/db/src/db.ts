import Database from "better-sqlite3";
import { loadConfig, dataPaths, ensureDataDirs } from "@private-stock/core/server";

/**
 * The database handle.
 *
 * Differs from basket-bot's `db.ts` in two ways, both forced by this app's shape:
 *
 * 1. The path comes from config (`dataDir`) rather than being hardcoded, because the NAS
 *    deployment mounts its data volume somewhere the code cannot assume.
 * 2. WAL mode and `busy_timeout`, because two processes use this file — Next reads while
 *    the worker writes (§4). Without WAL the UI would block behind every ffmpeg job's
 *    bookkeeping.
 */

const globalForDb = globalThis as unknown as {
    privateStockDb: Database.Database | undefined;
};

export interface OpenDatabaseOptions {
    /** Override the file path. `:memory:` is what the tests use. */
    path?: string;
    verbose?: boolean;
    /** Override how long a contended write waits. See `busyTimeoutMs`. */
    busyTimeoutMs?: number;
}

/**
 * How long a contended write waits for the lock, and why the two processes disagree.
 *
 * SQLite has no writer queue and no fairness: `busy_timeout` is a retry loop, so a steady
 * stream of short writes from one process can starve the other for the whole timeout. The
 * worker produces exactly that stream — a scan's batches, a job's bookkeeping, a change-feed
 * row per item — and with one timeout shared between them, five seconds was the wrong number
 * for both ends of the same contention:
 *
 * - **The web process should not wait long.** `better-sqlite3` is synchronous and Node serves
 *   on one thread, so a request waiting for the lock is not slow by itself: it freezes *every*
 *   other request in the process for as long as it waits. Five seconds of that is the whole
 *   site hanging (§20).
 * - **The worker should wait.** Nobody is watching it, its writes are the ones that must not
 *   be lost, and a job that fails on contention is retried — which produces more contention.
 *
 * **Three seconds, not the 750 ms this first shipped with.** Fail-fast was the right idea
 * applied at the wrong altitude: a timeout is a property of the *connection*, so 750 ms did not
 * only abandon progress pings, it abandoned logins. A person typing a password under a busy
 * worker got a 503, which is a far worse failure than the wait it avoided. The rule that
 * survives is narrower — **the write that nobody waits on is the write that may be dropped** —
 * and it belongs at the call site, through `withBusyTimeout`, not on the connection.
 *
 * Told apart by `NEXT_RUNTIME`, which Next sets in its server process and the worker never
 * has. `instrumentation.ts` reads the same variable for the same purpose. Either can be
 * overridden with `PRIVATE_STOCK_BUSY_TIMEOUT_MS`, which is how you find out whether a
 * different number would have helped without shipping an image to ask — and it is how a
 * deployment gets itself out of a bad default without waiting for one.
 */
const WEB_BUSY_TIMEOUT_MS = 3_000;
const WORKER_BUSY_TIMEOUT_MS = 15_000;

const busyTimeoutMs = (): number => {
    const override = Number(process.env.PRIVATE_STOCK_BUSY_TIMEOUT_MS);

    if (Number.isFinite(override) && override > 0) {
        return override;
    }

    return process.env.NEXT_RUNTIME ? WEB_BUSY_TIMEOUT_MS : WORKER_BUSY_TIMEOUT_MS;
};

/**
 * How many WAL pages a commit may leave behind before that commit checkpoints them, per process.
 *
 * SQLite checkpoints from inside whichever commit pushes the WAL past this mark: that statement
 * copies the pages into the database file and fsyncs it before it returns. At the default of 1,000
 * pages the web process takes that turn regularly — the worker writes nearly all of the WAL, but a
 * progress ping every ten seconds per viewer is a steady chance to be the commit that crosses the
 * line, and on a disk ffmpeg is using the copy costs hundreds of milliseconds of the only thread
 * (§4, §20). A single-row update measured 437 ms under a 250 ms lock budget, which only work done
 * *after* getting the lock can explain.
 *
 * So the worker keeps the default and also checkpoints on a timer (`checkpointWal`), and the web
 * process's mark is set far enough out that it is a safety net for a stopped worker rather than a
 * duty: about 40 MB of WAL, which web writes alone take a long time to produce.
 */
const WEB_WAL_AUTOCHECKPOINT_PAGES = 10_000;
const WORKER_WAL_AUTOCHECKPOINT_PAGES = 1_000;

const walAutocheckpointPages = (): number =>
    process.env.NEXT_RUNTIME ? WEB_WAL_AUTOCHECKPOINT_PAGES : WORKER_WAL_AUTOCHECKPOINT_PAGES;

/**
 * Copy what the WAL holds into the database file, without waiting for anybody.
 *
 * The worker's half of the arrangement above, run on a timer so the WAL is drained while the
 * worker is idle too — otherwise web writes would accumulate toward the web's safety-net mark and
 * the eventual checkpoint would be a large one, on the thread that must not stall. `PASSIVE` takes
 * no lock a writer needs and stops at pages a reader still holds, so it never blocks the web
 * process; whatever it could not copy is picked up next time.
 */
export const checkpointWal = (database: Database.Database = getDb()): void => {
    database.pragma("wal_checkpoint(PASSIVE)");
};

/**
 * Run one synchronous piece of work with a different patience for the lock.
 *
 * For the writes nobody is waiting on — a playback position, a view count — where waiting costs
 * every other request in the process and the value is superseded within seconds anyway. The
 * caller catches `isBusyError` and carries on.
 *
 * **Sound only because the callback is synchronous.** The pragma is connection-wide, and the
 * connection is shared by every request in the process; what makes a temporary change safe is
 * that nothing else can run in between. An `async` callback would hand the shortened timeout to
 * whatever request ran during its first `await`, so the type deliberately does not allow one —
 * and a promise-returning function passed here would restore the pragma before its work began.
 */
export const withBusyTimeout = <T>(timeoutMs: number, run: () => T): T => {
    const database = getDb();
    const previous = database.pragma("busy_timeout", { simple: true }) as number;

    database.pragma(`busy_timeout = ${timeoutMs}`);

    try {
        return run();
    } finally {
        database.pragma(`busy_timeout = ${previous}`);
    }
};

/**
 * Whether a failure is the lock rather than the statement.
 *
 * Exported because the callers that care are outside this package: a route deciding whether a
 * write is worth reporting, and the error handler deciding whether it can be recorded. Matched
 * on the driver's own code rather than on the message, which is localised nowhere and stable
 * nowhere either.
 */
export const isBusyError = (error: unknown): boolean => {
    const code = (error as { code?: unknown } | null)?.code;

    return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT";
};

export const openDatabase = (options: OpenDatabaseOptions = {}): Database.Database => {
    let dbPath = options.path;

    if (!dbPath) {
        const config = loadConfig();
        ensureDataDirs(config);
        dbPath = dataPaths(config).database;
    }

    const database = new Database(dbPath, {
        verbose: options.verbose ? console.log : undefined,
    });

    applyPragmas(database, options.busyTimeoutMs);
    reuseStatements(database, STATEMENT_CACHE_SIZE);

    if (process.env.NEXT_RUNTIME) {
        immediateTransactions(database);
    }

    const threshold = slowStatementMs();

    if (threshold !== null) {
        timeStatements(database, threshold);
    }

    return database;
};

/**
 * How many compiled statements a connection keeps for reuse, most recently used first.
 *
 * The worker's whole repertoire is a few hundred distinct strings and the web's not much more;
 * what pushes past this are the filter builders, whose IN-lists and optional clauses make a new
 * string per shape, and those are exactly the ones worth letting go. A compiled statement is a
 * few KB of native memory, so the bound is a few MB at most.
 */
const STATEMENT_CACHE_SIZE = 400;

/**
 * Makes `prepare` hand back an already-compiled statement for SQL it has seen.
 *
 * **better-sqlite3 has no statement cache of its own**, and every repo function here calls
 * `db.prepare(...)` on every call, so each call compiled its statement again. That cost CPU,
 * and on the NAS it cost memory: the driver compiles with `SQLITE_PREPARE_PERSISTENT`, so every
 * statement is a `malloc` of its own that is freed only when V8 garbage-collects the small
 * JavaScript object wrapping it -- and V8 cannot see the native size behind that object, so it
 * is in no hurry. The worker prepares several statements a second for ever (the claim loop,
 * heartbeats, the bookkeeping of every job), and the unfreed ones sat interleaved with SQLite's
 * page cache in glibc's main heap, which cannot hand back a page while anything lives on it.
 * How many are waiting depends on how rarely V8 runs a full collection, which is set by the size
 * of the JavaScript heap, not by this: measured in the production image on the production
 * database, the worker's statement pattern held 45 MB of native heap beside a small JavaScript
 * heap and **199 MB** beside a 57 MB one -- which is what the worker's file watcher used to keep --
 * against 19 MB, the page cache alone, with reuse (§20 "The worker's own memory").
 *
 * Three things make reuse safe, and the rest of the code must not undo them:
 *
 * - A statement busy in an `iterate()` is never handed out a second time; the caller gets a
 *   fresh one, uncached.
 * - `pluck`, `raw` and `expand` change a compiled statement's mode for good, and two callers of the
 *   same SQL share one. So each `prepare` returns its own handle (`modeHandle`) that remembers the
 *   mode *it* was asked for and sets it on the shared statement immediately before every execution.
 *   A statement held in a variable across a loop therefore keeps its mode even when another caller
 *   plucks the same SQL in between -- which a reset-on-hand-out alone would not guarantee.
 * - **Never `.bind()` a prepared statement.** Its parameters would then be fixed for every later
 *   caller of the same SQL, which fails them with "already has bound parameters". Nothing does.
 *
 * `pragma` and `transaction` do not go through `prepare`, so they are untouched.
 */
const reuseStatements = (database: Database.Database, capacity: number): void => {
    const prepare = database.prepare.bind(database);
    const compiled = new Map<string, Database.Statement>();

    database.prepare = ((sql: string) => {
        const cached = compiled.get(sql);

        if (cached && !cached.busy) {
            // Most recently used last, so eviction takes from the front.
            compiled.delete(sql);
            compiled.set(sql, cached);

            return modeHandle(cached);
        }

        const statement = prepare(sql);

        if (!cached) {
            compiled.set(sql, statement);

            if (compiled.size > capacity) {
                compiled.delete(compiled.keys().next().value!);
            }
        }

        return modeHandle(statement);
    }) as Database.Database["prepare"];
};

type Mode = "rows" | "pluck" | "raw" | "expand";

/**
 * One caller's view of a shared compiled statement: its own output mode, applied just before it
 * runs (see `reuseStatements`). Everything else -- `run`, `columns`, `reader`, `busy`, `source` --
 * passes straight through. Execution is synchronous, so nothing can change the mode between
 * setting it and the call that reads it.
 */
const modeHandle = (statement: Database.Statement): Database.Statement => {
    let mode: Mode = "rows";

    const apply = (): void => {
        if (!statement.reader) {
            return;
        }

        // Each of these switches the other two off when turned on, so set the wanted one last.
        statement.pluck(false).raw(false).expand(false);

        if (mode === "pluck") statement.pluck(true);
        else if (mode === "raw") statement.raw(true);
        else if (mode === "expand") statement.expand(true);
    };

    const handle: Database.Statement = new Proxy(statement, {
        get: (target, property) => {
            if (property === "pluck" || property === "raw" || property === "expand") {
                return (on = true) => {
                    if (on) mode = property;
                    else if (mode === property) mode = "rows";

                    return handle;
                };
            }

            if (property === "get" || property === "all" || property === "iterate") {
                const run = Reflect.get(target, property, target) as (...a: unknown[]) => unknown;

                return (...args: unknown[]) => {
                    apply();

                    return run.apply(target, args);
                };
            }

            const value = Reflect.get(target, property, target);

            return typeof value === "function" ? value.bind(target) : value;
        },
    });

    return handle;
};

/**
 * Makes `db.transaction(fn)` begin `IMMEDIATE` on this connection, in the web process only.
 *
 * A deferred transaction takes the write lock at its first write rather than at `BEGIN`, and
 * nearly every write here reads first — resolve a tag name, find the next chip position, then
 * insert. When the worker commits between that read and that write, SQLite refuses the upgrade
 * outright: `SQLITE_BUSY_SNAPSHOT`, with no `busy_timeout` wait, because waiting cannot help a
 * transaction whose snapshot is already stale. The worker commits several times a second and a
 * cold read on the NAS takes hundreds of milliseconds, so saving a tag failed often (§20).
 * `BEGIN IMMEDIATE` takes the lock first, where `busy_timeout` applies.
 *
 * `trashRepo` and `mergeService` learned this one call site at a time; this is the default
 * instead, because a hundred sites cannot all be remembered. Nesting is unaffected — inside a
 * transaction better-sqlite3 uses a savepoint whichever variant is called — and `.deferred`
 * stays available for a read that only wants a consistent snapshot.
 *
 * **Not in the worker.** There a read-only transaction holding the write lock would stall the
 * web process's writes, the direction that matters; in the web process the cost is the worker
 * waiting, which it does for fifteen seconds without anyone noticing.
 */
const immediateTransactions = (database: Database.Database): void => {
    const transaction = database.transaction.bind(database);

    database.transaction = ((fn: Parameters<typeof transaction>[0]) =>
        transaction(fn).immediate) as typeof database.transaction;
};

/**
 * Pragmas applied to every connection, in both processes.
 *
 * `busy_timeout` is the one that matters operationally, and it is deliberately **not** the
 * same on both sides — `busyTimeoutMs` above argues the split. It was five seconds everywhere,
 * chosen on the reasoning that no write this app makes should take that long. True, and beside
 * the point: the wait is not caused by the length of anyone's write but by the *rate* of them,
 * and five seconds of waiting in the web process is five seconds of the whole site stopped.
 */
export const applyPragmas = (database: Database.Database, timeoutMs?: number): void => {
    database.pragma("journal_mode = WAL");
    database.pragma(`busy_timeout = ${timeoutMs ?? busyTimeoutMs()}`);
    database.pragma(`wal_autocheckpoint = ${walAutocheckpointPages()}`);
    database.pragma("foreign_keys = ON");
    database.pragma("synchronous = NORMAL");
    database.pragma(`cache_size = -${cacheKibibytes()}`);
    database.pragma(`mmap_size = ${mmapBytes()}`);
};

/**
 * How much of the database each connection may hold in its own heap, in KiB.
 *
 * `better-sqlite3` defaults this to 16 MB, which was chosen for nobody in particular. On the NAS
 * the measured symptom was every statement being slow — a single-row `UPDATE ... WHERE id = ?`
 * taking a second, which has no algorithmic explanation and is entirely a story about pages
 * coming off a disk that ffmpeg is also using (§20). More cache is the direct answer to that.
 *
 * 48 MB in the web process rather than something bolder because the container has a memory cap
 * set against what the box actually has free, and this is heap. Raise it with
 * `PRIVATE_STOCK_SQLITE_CACHE_MB` on a machine with room (both processes).
 *
 * **16 MB in the worker**, which is the answer to a different question. Its reads are sweeps and
 * batches that cycle through any cache size, and on the NAS every MB of this anonymous memory is a
 * MB the kernel's page cache -- through which the web process reads the database -- does not have;
 * it is also the first thing swapped. Measured in the production image on the production database,
 * the cache was ~43 of the worker's ~50 MB of live native heap after twenty minutes (`PRAGMA
 * shrink_memory` released exactly that), and it filled to its cap within the hour (§20 "The
 * worker's own memory").
 */
const WEB_CACHE_MB = 48;
const WORKER_CACHE_MB = 16;
/**
 * **16 MB in each of the web process's reader threads** (`readPool.ts`). Their reads are the
 * grid's and the filter panel's, which the web cache served before; the readers take that work,
 * and each is one more heap in the same container cap, so they get the worker's figure rather than
 * the web's. What they read is shared below them anyway, in the kernel's page cache.
 */
const READER_CACHE_MB = 16;

/** `web` defaults to which process this is; `db:diagnose --cost` asks for the web's figure. */
export const cacheKibibytes = (web: boolean = Boolean(process.env.NEXT_RUNTIME)): number => {
    const megabytes = Number(process.env.PRIVATE_STOCK_SQLITE_CACHE_MB);

    if (Number.isFinite(megabytes) && megabytes > 0) {
        return megabytes * 1024;
    }

    if (process.env.PRIVATE_STOCK_DB_ROLE === "reader") {
        return READER_CACHE_MB * 1024;
    }

    return (web ? WEB_CACHE_MB : WORKER_CACHE_MB) * 1024;
};

/**
 * How much of the file to read through a memory map instead of `read()` calls.
 *
 * The cheaper half of the same fix, and the one that scales past the cap: mapped pages are the
 * kernel's page cache rather than this process's heap, so they are shared between the two
 * processes, counted as reclaimable, and handed back under pressure instead of provoking the OOM
 * killer. For the random single-row reads this app is made of — one probe into `UserMedia` per
 * listable row, one row per job claim — it removes a syscall and a copy per page.
 *
 * 256 MB is a ceiling, not an allocation: SQLite maps up to this much of the file and no more, so
 * a database smaller than this is simply mapped whole. `PRIVATE_STOCK_SQLITE_MMAP_MB=0` turns it
 * off, which is the thing to try if a platform's mmap turns out to be the problem rather than the
 * cure — QNAP volumes are ordinary ext4/btrfs, but a network-backed `/data` would not be.
 */
const DEFAULT_MMAP_MB = 256;

const mmapBytes = (): number => {
    const megabytes = Number(process.env.PRIVATE_STOCK_SQLITE_MMAP_MB);

    return (
        (Number.isFinite(megabytes) && megabytes >= 0 ? megabytes : DEFAULT_MMAP_MB) * 1024 * 1024
    );
};

/**
 * Process-wide handle, opened on first use.
 *
 * Laziness is not an optimisation here, it is a requirement. `next build` evaluates every
 * route module to collect page data, so a connection opened at import time means the build
 * tries to load the native addon and touch a database that may not exist yet — on a machine
 * that is not the one the app will run on. Deferring to first property access keeps the
 * build a pure compile step.
 *
 * Cached off `globalThis` so Next's hot reload does not leak a connection per edit — the
 * same trick basket-bot uses.
 */
/**
 * Whether to echo every statement to stdout.
 *
 * An explicit opt-in, not `NODE_ENV === "development"`, which is what it used to be and which
 * made it the *default* state of every dev run. Measured on this library the worker emits
 * **9.6 MB and 35,000 lines in twenty seconds** -- roughly 1.6 GB an hour -- because the claim
 * loop logs a query every couple of seconds forever and every job logs its whole
 * bookkeeping.
 *
 * That is not merely noisy. On Windows `process.stdout` is synchronous when it is a console,
 * so once a terminal stops draining that volume the next write blocks the event loop. The
 * worker then sits at 0% CPU with every timer dead: no heartbeats, no claims, no
 * completions -- and its in-flight jobs frozen at the exact second it stopped, which is what
 * a stuck worker looked like here, twice.
 *
 * So: `PRIVATE_STOCK_SQL_LOG=1` when someone wants to watch statements go by, and silence the
 * rest of the time.
 */
const sqlLoggingRequested = (): boolean => {
    const flag = process.env.PRIVATE_STOCK_SQL_LOG;

    return flag === "1" || flag === "true";
};

/**
 * How long a single statement may take before it is worth a line of log.
 *
 * The gap between the two instruments that already exist. Request timing says a response was
 * slow; event-loop delay says the process was blocked; **neither says which statement did it**,
 * and `PRIVATE_STOCK_SQL_LOG` is the opposite problem — it prints every statement, at 1.6 GB an
 * hour (§15), which is unusable on the box where the question arises.
 *
 * So: a threshold, off unless a number is given. `PRIVATE_STOCK_SQL_SLOW_MS=250` prints the
 * duration, the row count and the SQL of anything slower, in both processes. What sent this
 * looking was a `/api/library/stats` that took 19 seconds to run four aggregates over a
 * 14k-item library — a number with no legitimate explanation, and four candidates for it.
 *
 * Wrapping is installed only when the variable is set, so the unwrapped path is exactly what it
 * was before: no proxy, no timer, no branch per statement.
 */
const slowStatementMs = (): number | null => {
    const threshold = Number(process.env.PRIVATE_STOCK_SQL_SLOW_MS);

    return Number.isFinite(threshold) && threshold > 0 ? threshold : null;
};

/** One line per slow statement. Collapsed to a single line because a NAS console is the reader. */
const logSlowStatement = (sql: string, method: string, ms: number, rows: number | null): void => {
    const flat = sql.replace(/\s+/g, " ").trim();

    console.warn(
        `[sql] ${ms.toFixed(0).padStart(6)}ms ${method}` +
            `${rows === null ? "" : ` rows=${rows}`} ${flat.slice(0, 300)}`
    );
};

/**
 * Times `get`, `all` and `run`, and leaves everything else alone.
 *
 * A proxy per statement rather than a wrapper class: `Statement` carries `pluck`, `expand`,
 * `raw`, `bind`, `iterate`, `columns` and a `reader` getter, some of which return the statement
 * for chaining. Forwarding the three that execute and delegating the rest is the only version
 * that cannot quietly change behaviour — and `iterate` is deliberately not timed, because its
 * cost is spread over the consumer's loop rather than spent inside the call.
 */
const timeStatements = (database: Database.Database, thresholdMs: number): void => {
    const prepare = database.prepare.bind(database);

    database.prepare = ((sql: string) => {
        const statement = prepare(sql);

        return new Proxy(statement, {
            get: (target, property, receiver) => {
                const value = Reflect.get(target, property, receiver);

                if (property !== "get" && property !== "all" && property !== "run") {
                    return typeof value === "function" ? value.bind(target) : value;
                }

                return (...args: unknown[]) => {
                    const started = process.hrtime.bigint();
                    const result = (value as (...a: unknown[]) => unknown).apply(target, args);
                    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

                    if (elapsed >= thresholdMs) {
                        logSlowStatement(
                            sql,
                            property,
                            elapsed,
                            Array.isArray(result) ? result.length : null
                        );
                    }

                    return result;
                };
            },
        });
    }) as Database.Database["prepare"];
};

export const getDb = (): Database.Database => {
    if (!globalForDb.privateStockDb) {
        const database = openDatabase({ verbose: sqlLoggingRequested() });
        globalForDb.privateStockDb = database;

        process.once("beforeExit", () => {
            database.close();
        });
    }

    return globalForDb.privateStockDb;
};

/**
 * Ergonomic alias so call sites read `db.prepare(...)` as they do in basket-bot, while the
 * connection is still deferred until the first property access.
 */
export const db: Database.Database = new Proxy({} as Database.Database, {
    get: (_target, property, receiver) => Reflect.get(getDb(), property, receiver),
    set: (_target, property, value, receiver) => Reflect.set(getDb(), property, value, receiver),
    has: (_target, property) => Reflect.has(getDb(), property),
});

/**
 * The database handle type, re-exported so consumers never import better-sqlite3 directly.
 *
 * Keeps the native dependency an implementation detail of this package: `apps/worker` and
 * `apps/web` depend on `@private-stock/db`, not on the driver underneath it.
 */
export type Db = Database.Database;
