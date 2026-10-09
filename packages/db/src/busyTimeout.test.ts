import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
    cacheKibibytes,
    getDb,
    isBusyError,
    openDatabase,
    withBusyTimeout,
    type Db,
} from "./db.js";

/**
 * The two sides of lock contention (§20).
 *
 * `busy_timeout` is a number nobody looks at until the day it is the whole problem, and it was
 * one number for two processes with opposite needs: the web process must give up quickly,
 * because waiting freezes every other request in it, and the worker must not, because its
 * writes are the ones worth keeping. Pinning both here is cheap and the alternative was
 * discovering the difference in production.
 */

const withEnv = (value: string | undefined, run: () => void): void => {
    const previous = process.env.NEXT_RUNTIME;

    if (value === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = value;

    try {
        run();
    } finally {
        if (previous === undefined) delete process.env.NEXT_RUNTIME;
        else process.env.NEXT_RUNTIME = previous;
    }
};

/** What the connection actually ended up with, read back from SQLite rather than assumed. */
const timeoutOf = (): number => {
    const database = openDatabase({ path: ":memory:" });

    try {
        return database.pragma("busy_timeout", { simple: true }) as number;
    } finally {
        database.close();
    }
};

afterEach(() => {
    delete process.env.PRIVATE_STOCK_BUSY_TIMEOUT_MS;
});

describe("busy_timeout", () => {
    it("waits less in the web process, where waiting stops everything", () => {
        withEnv("nodejs", () => expect(timeoutOf()).toBe(3_000));
    });

    /**
     * The regression this number exists to prevent. At 750 ms a login under a busy worker
     * failed with a 503, which is worse than the stall it was avoiding: a progress ping may be
     * dropped, a password may not.
     */
    it("leaves room for a write somebody is waiting on", () => {
        withEnv("nodejs", () => expect(timeoutOf()).toBeGreaterThanOrEqual(2_000));
    });

    it("waits in the worker, where nobody is watching and the write matters", () => {
        withEnv(undefined, () => expect(timeoutOf()).toBe(15_000));
    });

    it("can be overridden without shipping an image to ask", () => {
        process.env.PRIVATE_STOCK_BUSY_TIMEOUT_MS = "1234";

        withEnv("nodejs", () => expect(timeoutOf()).toBe(1234));
        withEnv(undefined, () => expect(timeoutOf()).toBe(1234));
    });

    it("ignores an override that is not a positive number", () => {
        for (const value of ["", "0", "-5", "soon"]) {
            process.env.PRIVATE_STOCK_BUSY_TIMEOUT_MS = value;

            withEnv("nodejs", () => expect(timeoutOf()).toBe(3_000));
        }
    });

    it("takes an explicit value over both", () => {
        const database = openDatabase({ path: ":memory:", busyTimeoutMs: 42 });

        try {
            expect(database.pragma("busy_timeout", { simple: true })).toBe(42);
        } finally {
            database.close();
        }
    });
});

/**
 * Who pays for the checkpoint (§4).
 *
 * SQLite runs it inside whichever commit crosses the mark, so the mark decides which process
 * spends a disk-bound copy and an fsync on its own thread. The web process must almost never be
 * that commit; the worker, which nobody is waiting on, takes the duty.
 */
describe("wal_autocheckpoint", () => {
    const pagesOf = (): number => {
        const database = openDatabase({ path: ":memory:" });

        try {
            return database.pragma("wal_autocheckpoint", { simple: true }) as number;
        } finally {
            database.close();
        }
    };

    it("leaves the web process a safety net rather than a duty", () => {
        withEnv("nodejs", () => expect(pagesOf()).toBe(10_000));
    });

    it("keeps SQLite's default in the worker", () => {
        withEnv(undefined, () => expect(pagesOf()).toBe(1_000));
    });
});

describe("isBusyError", () => {
    it("recognises the driver's own codes", () => {
        expect(isBusyError({ code: "SQLITE_BUSY" })).toBe(true);
        expect(isBusyError({ code: "SQLITE_BUSY_SNAPSHOT" })).toBe(true);
    });

    /** Matching on the message was the alternative, and this is why it was not chosen. */
    it("does not guess from the message", () => {
        expect(isBusyError(new Error("database is locked"))).toBe(false);
    });

    it("survives everything a catch block can actually hand it", () => {
        expect(isBusyError(null)).toBe(false);
        expect(isBusyError(undefined)).toBe(false);
        expect(isBusyError("SQLITE_BUSY")).toBe(false);
        expect(isBusyError({ code: "SQLITE_CONSTRAINT" })).toBe(false);
    });
});

describe("withBusyTimeout", () => {
    /**
     * Against `getDb()`, because that is the connection the helper changes and the whole point
     * is that it is shared: a shortened timeout left behind would be inherited by a login.
     *
     * A throwaway data directory rather than a mock, so this exercises the real lazy handle.
     */
    const workDir = mkdtempSync(path.join(os.tmpdir(), "private-stock-busy-"));
    let opened: Db | null = null;

    /**
     * Closed before the directory goes, because Windows refuses to unlink a file that is still
     * open — `getDb` caches its handle for the life of the process, so nothing else would.
     */
    afterAll(() => {
        opened?.close();

        try {
            rmSync(workDir, { recursive: true, force: true });
        } catch {
            // A temp directory the OS will clear anyway. Not worth failing a green suite over.
        }
    });

    it("restores the previous timeout, including when the work throws", () => {
        process.env.PRIVATE_STOCK_DATA_DIR = workDir;

        const database = getDb();
        opened = database;
        const read = () => database.pragma("busy_timeout", { simple: true });
        const before = read();

        expect(
            withBusyTimeout(250, () => {
                expect(read()).toBe(250);

                return "done";
            })
        ).toBe("done");
        expect(read()).toBe(before);

        expect(() =>
            withBusyTimeout(250, () => {
                throw new Error("nope");
            })
        ).toThrow("nope");
        expect(read()).toBe(before);
    });
});

/**
 * The two pragmas that answer "every statement is slow" (§20).
 *
 * Pinned because they are invisible until a NAS is reading pages off a disk that ffmpeg is also
 * using, and because both are tunable per deployment — a default that silently stopped applying
 * would look exactly like the box getting slower.
 */
describe("read cache", () => {
    afterEach(() => {
        delete process.env.PRIVATE_STOCK_SQLITE_CACHE_MB;
        delete process.env.PRIVATE_STOCK_SQLITE_MMAP_MB;
    });

    /**
     * A file, not `:memory:` — `mmap_size` reads back as undefined for an in-memory database,
     * because there is no file to map. Testing it against one would assert nothing.
     */
    const pragmasOf = (): { cache: number; mmap: number } => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "private-stock-pragma-"));
        const database = openDatabase({ path: path.join(dir, "test.db") });

        try {
            return {
                cache: database.pragma("cache_size", { simple: true }) as number,
                mmap: database.pragma("mmap_size", { simple: true }) as number,
            };
        } finally {
            database.close();
            rmSync(dir, { recursive: true, force: true });
        }
    };

    /**
     * Negative means KiB rather than pages, which is the only form with a stable meaning. The
     * worker keeps less than the web process: on the NAS its cache is anonymous memory taken from
     * the kernel's page cache, which the web process reads through (§20 "The worker's own memory").
     */
    it("asks for 16 MiB of page cache in the worker and 48 MiB in the web process", () => {
        expect(pragmasOf().cache).toBe(-16384);
        withEnv("nodejs", () => expect(pragmasOf().cache).toBe(-49152));
    });

    it("answers for the web process when asked from elsewhere (db:diagnose --cost)", () => {
        expect(cacheKibibytes(true)).toBe(49152);
        expect(cacheKibibytes(false)).toBe(16384);
    });

    it("maps up to 256 MiB of the file", () => {
        expect(pragmasOf().mmap).toBe(268435456);
    });

    it("takes a deployment's own numbers", () => {
        process.env.PRIVATE_STOCK_SQLITE_CACHE_MB = "128";
        process.env.PRIVATE_STOCK_SQLITE_MMAP_MB = "512";

        expect(pragmasOf()).toEqual({ cache: -131072, mmap: 536870912 });
        withEnv("nodejs", () => expect(pragmasOf().cache).toBe(-131072));
    });

    /** Zero is a real answer for mmap — "turn it off" — and not one for the cache. */
    it("allows mmap to be switched off but keeps a cache", () => {
        process.env.PRIVATE_STOCK_SQLITE_MMAP_MB = "0";
        process.env.PRIVATE_STOCK_SQLITE_CACHE_MB = "0";

        expect(pragmasOf()).toEqual({ cache: -16384, mmap: 0 });
    });

    it("ignores nonsense", () => {
        process.env.PRIVATE_STOCK_SQLITE_CACHE_MB = "lots";
        process.env.PRIVATE_STOCK_SQLITE_MMAP_MB = "-1";

        expect(pragmasOf()).toEqual({ cache: -16384, mmap: 268435456 });
    });
});

/**
 * Where a web transaction takes the write lock (§20).
 *
 * At `BEGIN`, so `busy_timeout` applies. A deferred transaction reads first and upgrades at its
 * first write, and SQLite refuses that upgrade without waiting when the worker has committed in
 * between — which is how saving a tag failed with a busy error on a box where the worker commits
 * several times a second.
 */
describe("transactions", () => {
    /**
     * Whether a second connection could start writing while `body` runs inside a transaction on
     * the first. A read-only body is the whole point: only `BEGIN IMMEDIATE` holds the lock
     * before anything has been written.
     */
    const lockedDuring = (variant?: "deferred"): boolean => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "private-stock-txn-"));
        const file = path.join(dir, "test.db");
        const database = openDatabase({ path: file });
        const other = openDatabase({ path: file, busyTimeoutMs: 1 });

        try {
            database.exec(`CREATE TABLE "T" ("x" INTEGER)`);

            const body = () => {
                database.prepare(`SELECT count(*) FROM "T"`).get();

                try {
                    other.exec("BEGIN IMMEDIATE");
                    other.exec("ROLLBACK");

                    return false;
                } catch (error) {
                    if (isBusyError(error)) return true;
                    throw error;
                }
            };

            const run = database.transaction(body);

            return variant === "deferred" ? run.deferred() : run();
        } finally {
            other.close();
            database.close();
            rmSync(dir, { recursive: true, force: true });
        }
    };

    it("take the write lock at BEGIN in the web process", () => {
        withEnv("nodejs", () => expect(lockedDuring()).toBe(true));
    });

    it("can still be deferred on request, for a read that wants a snapshot", () => {
        withEnv("nodejs", () => expect(lockedDuring("deferred")).toBe(false));
    });

    /** A read-only worker transaction holding the lock would stall the web process's writes. */
    it("stay deferred in the worker", () => {
        withEnv(undefined, () => expect(lockedDuring()).toBe(false));
    });

    it("nest as savepoints, whichever variant began them", () => {
        withEnv("nodejs", () => {
            const database = openDatabase({ path: ":memory:" });

            try {
                database.exec(`CREATE TABLE "T" ("x" INTEGER)`);
                const insert = database.transaction(() => {
                    database.prepare(`INSERT INTO "T" VALUES (1)`).run();
                });

                database.transaction(() => {
                    insert();
                    insert();
                })();

                expect(database.prepare(`SELECT count(*) AS n FROM "T"`).get()).toEqual({ n: 2 });
            } finally {
                database.close();
            }
        });
    });
});
