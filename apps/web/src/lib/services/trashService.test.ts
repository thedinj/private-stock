import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../auth/withAuth";

/**
 * Trashing one item while the worker is busy writing (§4, §10).
 *
 * A bulk deletion hands the worker hundreds of trash and purge jobs, and the web process gives
 * up on the lock after three seconds. One copy in thirty failed a bulk run with "database is
 * locked". What is tested here is the answer: a busy database is waited out and tried again,
 * and trying again never writes a second entry for a deletion that already landed.
 */

const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

let createAttempts = 0;
let createFailures = 0;
let mergeFailures = 0;
let entries: string[] = [];
let jobs: string[] = [];
let changes: { entityId: string; op: string }[] = [];
let entry: Record<string, unknown> | undefined;

vi.mock("@private-stock/db", () => ({
    isBusyError: (error: unknown) => (error as { code?: string } | null)?.code === "SQLITE_BUSY",
    // A transaction runs its function and lets its error through, as better-sqlite3's does.
    db: {
        prepare: () => ({
            get: () => ({
                fileId: "f1",
                rootId: "r1",
                relPath: "a.mp4",
                size: 10,
                writable: 1,
                state: "active",
            }),
        }),
        transaction: <T>(run: () => T) => ({ immediate: () => run() }),
    },
    changeLogRepo: {
        record: (change: { entityId: string; op: string }) => changes.push(change),
    },
    mediaRepo: { findDetail: () => ({}) },
    settingRepo: { get: (_key: string, fallback: unknown) => fallback },
    trashRepo: {
        findIdenticalActiveFile: () => "f-twin",
        unmovedBytes: () => 0,
        create: (input: { mediaId: string }) => {
            createAttempts += 1;

            if (createFailures > 0) {
                createFailures -= 1;
                throw busy();
            }

            entries.push(input.mediaId);

            return { id: `e-${input.mediaId}` };
        },
        enqueueMove: (_kind: string, entryId: string) => jobs.push(entryId),
        findById: () => entry,
    },
}));

vi.mock("@private-stock/core/server", () => ({
    loadConfig: () => ({ dataDir: "/data" }),
    freeBytes: async () => null,
}));

vi.mock("./artService", () => ({ coverUrl: () => null }));

vi.mock("./mergeService", () => ({
    mergeIntoSurvivingCopy: () => {
        if (mergeFailures > 0) {
            mergeFailures -= 1;
            throw busy();
        }

        return null;
    },
}));

const { purgeEntry, trashMedia } = await import("./trashService");

const auth: AuthContext = {
    userId: "u1",
    email: "a@b.c",
    displayName: "Admin",
    scopes: ["admin", "delete"],
    accessibleRootIds: ["r1"],
    tokenEpoch: 1,
};

beforeEach(() => {
    vi.useFakeTimers();
    createAttempts = 0;
    createFailures = 0;
    mergeFailures = 0;
    entries = [];
    jobs = [];
    changes = [];
    entry = undefined;
});

/** Runs a trash to completion, letting the backoff timers fire. */
const settle = async <T>(work: Promise<T>): Promise<T> => {
    await vi.runAllTimersAsync();

    return work;
};

describe("announcing a trash", () => {
    /**
     * Another tab's grid holds still rather than refetching (§13b), so this is the only way it
     * learns the tile has left the library. A busy retry must not announce it twice.
     */
    it("records one removal, alongside the entry it describes", async () => {
        createFailures = 1;

        await settle(trashMedia("m1", auth));

        expect(changes).toMatchObject([{ entityId: "m1", op: "delete" }]);
    });
});

describe("trashing while the database is busy", () => {
    it("waits and tries again, writing one entry and one job", async () => {
        createFailures = 2;

        const result = await settle(trashMedia("m1", auth));

        expect(result.entryId).toBe("e-m1");
        expect(createAttempts).toBe(3);
        expect(entries).toEqual(["m1"]);
        expect(jobs).toEqual(["e-m1"]);
    });

    it("waits out a busy merge too, which is safe to repeat", async () => {
        mergeFailures = 1;

        await settle(trashMedia("m1", auth));

        expect(entries).toEqual(["m1"]);
    });

    it("gives up in the end, and says the database was busy", async () => {
        createFailures = 100;

        // Caught before the timers run, so the rejection is never unhandled in between.
        const outcome = trashMedia("m1", auth).catch((error: unknown) => error);

        await vi.runAllTimersAsync();

        expect(await outcome).toMatchObject({ code: "SQLITE_BUSY" });
        expect(entries).toEqual([]);
    });
});

describe("purging one entry", () => {
    const open = {
        id: "e1",
        mediaId: "m1",
        fileId: "f1",
        restoredAt: null,
        purgedAt: null,
        twinFileId: null,
    };

    it("queues the purge of an entry that is in the bin", () => {
        entry = { ...open, movedAt: "2026-10-01 00:00:00" };

        purgeEntry("e1", auth);

        expect(jobs).toEqual(["e1"]);
    });

    /**
     * The guard emptying the bin already had. The original is still in the media root, and
     * purging now would delete the catalogue row and leave the file for the next scan to adopt.
     */
    it("refuses an entry whose move has not finished", () => {
        entry = { ...open, movedAt: null };

        expect(() => purgeEntry("e1", auth)).toThrow(/still being moved/);
        expect(jobs).toEqual([]);
    });
});
