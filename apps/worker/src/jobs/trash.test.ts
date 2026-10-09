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
 * Deleting an identical copy outright (§10e).
 *
 * This is the one place an original is unlinked with no copy of it in the bin, so every test
 * here asks the same question from a different side: does the same content survive somewhere?
 * The twin has to be present *and* unchanged since it was hashed before the original goes; when
 * it is not, the entry must fall back to an ordinary trash, bytes and all.
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
    trashRelPath: string;
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
        markMoved: (id: string) => {
            entries[id]!.movedAt = "now";
        },
        markRestored: (id: string) => {
            entries[id]!.restoredAt = "now";
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

const { runTrash } = await import("./trash.js");

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
        trashRelPath: `2026-09-30/${fileId}.mp4`,
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

const inBin = (entry: EntryRow) => path.join(dataDir, "trash", entry.trashRelPath);

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

describe("deleting an identical copy", () => {
    it("deletes the original and purges the item, with nothing in the bin", async () => {
        const original = givenFile("dup", "same bytes");
        const twin = givenFile("keep", "same bytes");
        const entry = givenEntry("dup", "keep");

        await runTrash(job(entry.id));

        expect(existsSync(original)).toBe(false);
        expect(existsSync(inBin(entry))).toBe(false);
        expect(readFileSync(twin, "utf8")).toBe("same bytes");
        expect(entry.purgedAt).not.toBeNull();
        expect(files.dup).toBeUndefined();
    });

    it("is trashed like any other when the twin has changed since it was hashed", async () => {
        const original = givenFile("dup", "same bytes");
        const twin = givenFile("keep", "same bytes");
        const entry = givenEntry("dup", "keep");

        writeFileSync(twin, "edited in place, longer now");

        await runTrash(job(entry.id));

        expect(entry.twinFileId).toBeNull();
        expect(entry.purgedAt).toBeNull();
        expect(readFileSync(inBin(entry), "utf8")).toBe("same bytes");
        expect(existsSync(original)).toBe(false);
    });

    it("is trashed like any other when the twin has gone", async () => {
        givenFile("dup", "same bytes");
        const twin = givenFile("keep", "same bytes");
        const entry = givenEntry("dup", "keep");

        rmSync(twin);

        await runTrash(job(entry.id));

        expect(entry.twinFileId).toBeNull();
        expect(entry.purgedAt).toBeNull();
        expect(readFileSync(inBin(entry), "utf8")).toBe("same bytes");
    });

    /** The whole-group case (§10d): the last copy keeps the content in the bin. */
    it("trusts a twin that is in the bin with its own bytes", async () => {
        const original = givenFile("dup", "same bytes");
        givenFile("keep", "same bytes");
        const keepEntry = givenEntry("keep", null);

        await runTrash(job(keepEntry.id));

        const entry = givenEntry("dup", "keep");

        await runTrash(job(entry.id));

        expect(existsSync(original)).toBe(false);
        expect(existsSync(inBin(entry))).toBe(false);
        expect(entry.purgedAt).not.toBeNull();
        expect(readFileSync(inBin(keepEntry), "utf8")).toBe("same bytes");
    });

    it("does not trust a twin that was itself deleted outright", async () => {
        givenFile("dup", "same bytes");
        givenFile("gone", "same bytes");
        givenFile("keep", "same bytes");
        const goneEntry = givenEntry("gone", "keep");
        const entry = givenEntry("dup", "gone");

        // "gone" was deleted against "keep", which then vanished too: nothing vouches now.
        goneEntry.movedAt = "now";
        rmSync(path.join(libraryDir, "gone.mp4"));

        await runTrash(job(entry.id));

        expect(entry.twinFileId).toBeNull();
        expect(readFileSync(inBin(entry), "utf8")).toBe("same bytes");
    });
});
