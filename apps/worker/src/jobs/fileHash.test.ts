import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRow } from "../queue.js";

/**
 * The identity hash runs before the probe and owes it one (§10f).
 *
 * Both ways of getting this wrong are quiet. Never queuing the probe leaves an item with no
 * duration and no cover, which reads as a broken import. Queuing it twice re-renders every
 * artifact the probe chains, which reads as nothing at all.
 */

let probedAt: string | null = null;
let source: { absolutePath: string } | null = null;
let quickHash: string | null = null;
let peers: { id: string; contentHash: string | null }[] = [];
const enqueued: { kind: string; mediaId?: string | null }[] = [];
const readInFull: string[] = [];
const contentHashes: Record<string, string | null> = {};

vi.mock("@private-stock/db", () => ({
    db: {},
    dupeRepo: { enqueueRescan: () => undefined },
    mediaFileRepo: {
        setHashes: (id: string, _quick: string | null, content: string | null) => {
            if (content) contentHashes[id] = content;
        },
        quickHashPeers: () => peers,
    },
    mediaRepo: { findBasic: () => ({ probedAt }) },
}));

vi.mock("../media/sourcePath.js", () => ({
    resolveSource: (id: string) => (source ? { absolutePath: `/media/${id}` } : null),
}));

vi.mock("../media/fileHash.js", () => ({
    quickHashFile: async () => {
        if (!quickHash) throw new Error("share went away");
        return quickHash;
    },
    contentHashFile: async (absolutePath: string) => {
        readInFull.push(absolutePath);
        return "same";
    },
}));

vi.mock("../queue.js", () => ({
    enqueue: (_db: unknown, options: { kind: string; mediaId?: string | null }) => {
        enqueued.push(options);
        return true;
    },
}));

const { runFileHash } = await import("./fileHash.js");

const job = (payload: unknown): JobRow => ({
    id: "job",
    kind: "filehash",
    mediaId: "media",
    fileId: "file",
    payloadJson: payload === undefined ? null : JSON.stringify(payload),
    attempts: 1,
    maxAttempts: 3,
    requestedByUserId: null,
});

beforeEach(() => {
    probedAt = null;
    source = null;
    quickHash = null;
    peers = [];
    enqueued.length = 0;
    readInFull.length = 0;
    for (const id of Object.keys(contentHashes)) delete contentHashes[id];
});

describe("the probe a scanned file is owed", () => {
    it("is queued once the file has been identified", async () => {
        await runFileHash(job({ probeAfter: true, probedAt: null }));

        expect(enqueued).toEqual([expect.objectContaining({ kind: "probe", mediaId: "media" })]);
    });

    it("is queued even when the file could not be hashed", async () => {
        source = { absolutePath: "/media/unreadable.mp4" };

        await expect(runFileHash(job({ probeAfter: true, probedAt: null }))).rejects.toThrow(
            "share went away"
        );

        expect(enqueued.map((entry) => entry.kind)).toEqual(["probe"]);
    });

    it("is not queued again by a retry once the probe has run", async () => {
        probedAt = "2026-10-01 12:00:00";

        await runFileHash(job({ probeAfter: true, probedAt: null }));

        expect(enqueued).toEqual([]);
    });

    it("is re-probed when the file changed, since the old probe described other bytes", async () => {
        probedAt = "2026-09-01 12:00:00";

        await runFileHash(job({ probeAfter: true, probedAt: "2026-09-01 12:00:00" }));

        expect(enqueued.map((entry) => entry.kind)).toEqual(["probe"]);
    });

    it("is none of a swept hash's business", async () => {
        await runFileHash(job(undefined));

        expect(enqueued).toEqual([]);
    });
});

describe("a quick-hash collision", () => {
    beforeEach(() => {
        source = { absolutePath: "/media/file" };
        quickHash = "quick";
    });

    it("reads both sides in full the first time", async () => {
        peers = [{ id: "first-copy", contentHash: null }];

        await runFileHash(job(undefined));

        expect(readInFull).toEqual(["/media/file", "/media/first-copy"]);
        expect(contentHashes).toEqual({ file: "same", "first-copy": "same" });
    });

    it("does not read a peer again that already has its content hash", async () => {
        peers = [
            { id: "first-copy", contentHash: "same" },
            { id: "second-copy", contentHash: null },
        ];

        await runFileHash(job(undefined));

        expect(readInFull).toEqual(["/media/file", "/media/second-copy"]);
    });
});
