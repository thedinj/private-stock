import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bin's jobs (§10, §10e).
 *
 * A trashed file stays at its path until purge, so the questions here are about the two
 * moments a file is unlinked: an identical copy deleted outright, which must find the same
 * content surviving somewhere first, and a purge, which must find the file it was asked to
 * destroy. Entries from before 2026-11-13 still have their bytes in `dataDir/trash`, and their
 * restore and purge act there.
 */

interface FileRow {
    id: string;
    rootId: string;
    relPath: string;
    size: number;
    mtime: number;
    state: "active" | "trashed";
}

interface EntryRow {
    id: string;
    mediaId: string | null;
    fileId: string | null;
    rootId: string;
    relPath: string;
    trashRelPath: string | null;
    bytes: number;
    deletedAt: string;
    movedAt: string | null;
    restoredAt: string | null;
    purgedAt: string | null;
    twinFileId: string | null;
}

let dataDir: string;
let libraryDir: string;
let files: Record<string, FileRow> = {};
let entries: Record<string, EntryRow> = {};

vi.mock("@private-stock/db", () => ({
    mediaFileRepo: { findById: (id: string) => files[id] },
    mediaRootRepo: {
        findById: (id: string) => (id === "root" ? { id, path: libraryDir } : undefined),
    },
    artifactRepo: { listForMedia: () => [] },
    trashRepo: {
        findForJob: (payload: string) =>
            entries[(JSON.parse(payload) as { entryId: string }).entryId],
        findOpenForFile: (fileId: string) =>
            Object.values(entries).find(
                (entry) => entry.fileId === fileId && !entry.restoredAt && !entry.purgedAt
            ),
        fileStateOf: (fileId: string) => files[fileId]?.state ?? null,
        markRestored: (id: string) => {
            const entry = entries[id]!;

            entry.restoredAt = "now";
            if (entry.fileId) files[entry.fileId]!.state = "active";
        },
        clearTwin: (id: string) => {
            entries[id]!.twinFileId = null;
        },
        purge: (id: string) => {
            const entry = entries[id]!;

            entry.purgedAt = "now";
            if (entry.fileId) delete files[entry.fileId];
        },
    },
}));

const { runPurge, runRestore, runTrash } = await import("./trash.js");

const job = (entryId: string) =>
    ({ payloadJson: JSON.stringify({ entryId }) }) as Parameters<typeof runTrash>[0];

/** A file in the library, catalogued exactly as it is on disk. */
const givenFile = (id: string, contents: string, state: FileRow["state"] = "active"): string => {
    const absolute = path.join(libraryDir, `${id}.mp4`);

    writeFileSync(absolute, contents);

    const stats = statSync(absolute);

    files[id] = {
        id,
        rootId: "root",
        relPath: `${id}.mp4`,
        size: stats.size,
        mtime: stats.mtimeMs,
        state,
    };

    return absolute;
};

const givenEntry = (fileId: string, twinFileId: string | null): EntryRow => {
    const file = files[fileId]!;

    file.state = "trashed";

    const entry: EntryRow = {
        id: `e-${fileId}`,
        mediaId: `m-${fileId}`,
        fileId,
        rootId: "root",
        relPath: file.relPath,
        trashRelPath: null,
        bytes: file.size,
        deletedAt: "2026-09-30 00:00:00",
        movedAt: null,
        restoredAt: null,
        purgedAt: null,
        twinFileId,
    };

    entries[entry.id] = entry;

    return entry;
};

/** An entry made before 2026-11-13: its bytes were copied into the bin and the original went. */
const givenMovedEntry = (fileId: string): { entry: EntryRow; binPath: string } => {
    const entry = givenEntry(fileId, null);
    const original = path.join(libraryDir, entry.relPath);

    entry.trashRelPath = `2026-09-30/${fileId}.mp4`;
    entry.movedAt = "2026-09-30 00:00:01";

    const binPath = path.join(dataDir, "trash", entry.trashRelPath);

    mkdirSync(path.dirname(binPath), { recursive: true });
    writeFileSync(binPath, readFileSync(original));
    rmSync(original);

    return { entry, binPath };
};

beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ps-trash-data-"));
    libraryDir = mkdtempSync(path.join(tmpdir(), "ps-trash-lib-"));
    mkdirSync(path.join(dataDir, "trash"), { recursive: true });
    process.env.PRIVATE_STOCK_DATA_DIR = dataDir;
    files = {};
    entries = {};
});

afterEach(() => {
    delete process.env.PRIVATE_STOCK_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(libraryDir, { recursive: true, force: true });
});

describe("trashing", () => {
    it("leaves an ordinary entry's file where it is", async () => {
        const original = givenFile("one", "bytes");
        const entry = givenEntry("one", null);

        await runTrash(job(entry.id));

        expect(readFileSync(original, "utf8")).toBe("bytes");
        expect(entry.purgedAt).toBeNull();
    });
});

describe("deleting an identical copy", () => {
    it("deletes the original and purges the item", async () => {
        const original = givenFile("dup", "same bytes");
        const twin = givenFile("keep", "same bytes");
        const entry = givenEntry("dup", "keep");

        await runTrash(job(entry.id));

        expect(existsSync(original)).toBe(false);
        expect(readFileSync(twin, "utf8")).toBe("same bytes");
        expect(entry.purgedAt).not.toBeNull();
        expect(files.dup).toBeUndefined();
    });

    it("stays in the bin like any other when the twin has changed since it was hashed", async () => {
        const original = givenFile("dup", "same bytes");
        const twin = givenFile("keep", "same bytes");
        const entry = givenEntry("dup", "keep");

        writeFileSync(twin, "edited in place, longer now");

        await runTrash(job(entry.id));

        expect(entry.twinFileId).toBeNull();
        expect(entry.purgedAt).toBeNull();
        expect(readFileSync(original, "utf8")).toBe("same bytes");
    });

    it("stays in the bin like any other when the twin has gone", async () => {
        const original = givenFile("dup", "same bytes");
        const twin = givenFile("keep", "same bytes");
        const entry = givenEntry("dup", "keep");

        rmSync(twin);

        await runTrash(job(entry.id));

        expect(entry.twinFileId).toBeNull();
        expect(entry.purgedAt).toBeNull();
        expect(readFileSync(original, "utf8")).toBe("same bytes");
    });

    /** The whole-group case (§10d): the last copy keeps the content, at its own path. */
    it("trusts a twin that is in the bin with its own bytes", async () => {
        const original = givenFile("dup", "same bytes");
        const kept = givenFile("keep", "same bytes");
        givenEntry("keep", null);
        const entry = givenEntry("dup", "keep");

        await runTrash(job(entry.id));

        expect(existsSync(original)).toBe(false);
        expect(entry.purgedAt).not.toBeNull();
        expect(readFileSync(kept, "utf8")).toBe("same bytes");
    });

    it("trusts a twin whose bytes were moved into the old bin", async () => {
        const original = givenFile("dup", "same bytes");
        givenFile("keep", "same bytes");
        givenMovedEntry("keep");
        const entry = givenEntry("dup", "keep");

        await runTrash(job(entry.id));

        expect(existsSync(original)).toBe(false);
        expect(entry.purgedAt).not.toBeNull();
    });

    it("does not trust a twin that was itself deleted outright", async () => {
        const original = givenFile("dup", "same bytes");
        givenFile("gone", "same bytes");
        givenFile("keep", "same bytes");
        givenEntry("gone", "keep");
        const entry = givenEntry("dup", "gone");

        // "gone" was deleted against "keep", which then vanished too: nothing vouches now.
        rmSync(path.join(libraryDir, "gone.mp4"));

        await runTrash(job(entry.id));

        expect(entry.twinFileId).toBeNull();
        expect(readFileSync(original, "utf8")).toBe("same bytes");
    });
});

describe("purging", () => {
    it("unlinks the file at its path and purges the item", async () => {
        const original = givenFile("one", "bytes");
        const entry = givenEntry("one", null);

        await runPurge(job(entry.id));

        expect(existsSync(original)).toBe(false);
        expect(entry.purgedAt).not.toBeNull();
    });

    it("refuses a file that is not the one that was trashed", async () => {
        const original = givenFile("one", "bytes");
        const entry = givenEntry("one", null);

        writeFileSync(original, "somebody else's file, put here since");

        await expect(runPurge(job(entry.id))).rejects.toThrow(/not the one that was catalogued/);

        expect(readFileSync(original, "utf8")).toBe("somebody else's file, put here since");
        expect(entry.purgedAt).toBeNull();
    });

    it("refuses a file the scan has revived", async () => {
        const original = givenFile("one", "bytes");
        const entry = givenEntry("one", null);

        files.one!.state = "active";

        await expect(runPurge(job(entry.id))).rejects.toThrow(/not trashed/);

        expect(existsSync(original)).toBe(true);
    });

    it("purges a file that has already gone", async () => {
        const original = givenFile("one", "bytes");
        const entry = givenEntry("one", null);

        rmSync(original);

        await runPurge(job(entry.id));

        expect(entry.purgedAt).not.toBeNull();
    });

    it("removes an old entry's bytes from the bin, not the library path", async () => {
        givenFile("one", "bytes");
        const { entry, binPath } = givenMovedEntry("one");

        // Something new at the old path since: it is not the entry's to delete.
        const newcomer = path.join(libraryDir, entry.relPath);
        writeFileSync(newcomer, "a different file");

        await runPurge(job(entry.id));

        expect(existsSync(binPath)).toBe(false);
        expect(readFileSync(newcomer, "utf8")).toBe("a different file");
        expect(entry.purgedAt).not.toBeNull();
    });
});

describe("restoring", () => {
    it("returns the item without touching its file", async () => {
        const original = givenFile("one", "bytes");
        const entry = givenEntry("one", null);

        await runRestore(job(entry.id));

        expect(entry.restoredAt).not.toBeNull();
        expect(files.one!.state).toBe("active");
        expect(readFileSync(original, "utf8")).toBe("bytes");
    });

    it("copies an old entry's bytes back from the bin first", async () => {
        givenFile("one", "bytes");
        const { entry, binPath } = givenMovedEntry("one");

        await runRestore(job(entry.id));

        expect(readFileSync(path.join(libraryDir, entry.relPath), "utf8")).toBe("bytes");
        expect(existsSync(binPath)).toBe(false);
        expect(entry.restoredAt).not.toBeNull();
    });
});
