import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * The recycle bin (§10).
 *
 * Two things are worth testing here and the rest is bookkeeping. The first is that trashing
 * genuinely removes an item from the library without any query being told about this feature
 * — that claim is the entire argument for building it this way, and it rests on a trigger
 * nobody edits when they add a filter. The second is that the irreversible step cannot run on
 * something that is no longer trashed, because everything else in this file is recoverable
 * and that one is not.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const trashRepo = await import("./trashRepo.js");
const mediaRepo = await import("./mediaRepo.js");
const mediaFileRepo = await import("./mediaFileRepo.js");
const { db: sharedDb } = await import("../db.js");

const ROOT = "aaaaaaaa-0000-4000-8000-000000000000";
const USER = "bbbbbbbb-0000-4000-8000-000000000000";

const addMedia = (id: string): { fileId: string } => {
    const fileId = `f-${id}`;

    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
         VALUES (?, 'video', 'Test', CURRENT_TIMESTAMP)`
    ).run(id);

    db.prepare(
        `INSERT INTO "MediaFile"
             ("id", "rootId", "relPath", "size", "mtime", "lastSeenAt", "updatedAt")
         VALUES (?, ?, ?, 1024, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(fileId, ROOT, `${id}.mp4`);

    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l-${id}`, id, fileId);

    return { fileId };
};

const trash = (
    mediaId: string,
    fileId: string,
    retentionDays = 7,
    twinFileId: string | null = null
) =>
    trashRepo.create({
        mediaId,
        fileId,
        rootId: ROOT,
        relPath: `${mediaId}.mp4`,
        trashRelPath: `2026-01-01/${mediaId}`,
        bytes: 1024,
        deletedById: USER,
        retentionDays,
        twinFileId,
    });

/** A scan seeing `m1.mp4` exactly as `addMedia` catalogued it. */
const sighting = {
    scanId: "scan-1",
    rootId: ROOT,
    relPath: "m1.mp4",
    size: 1024,
    mtime: 0,
    dev: null,
    inode: null,
    classification: "media" as const,
};

/** What the library itself would show, through the ordinary list path. */
const listQuery = {
    sort: "addedAt",
    direction: "desc",
    limit: 100,
    page: 0,
} as unknown as Parameters<typeof mediaRepo.listMedia>[0];

const visibleIds = (): string[] =>
    mediaRepo.listMedia(listQuery, USER, [ROOT]).rows.map((row) => row.id);

beforeEach(() => {
    db = sharedDb as Database.Database;
    db.pragma("foreign_keys = OFF");

    const virtualPrefixes = (
        db
            .prepare(
                `SELECT "name" FROM sqlite_master
                  WHERE "type" = 'table' AND "sql" LIKE 'CREATE VIRTUAL TABLE%'`
            )
            .all() as { name: string }[]
    ).map((row) => `${row.name}_`);

    for (const table of (
        db
            .prepare(
                `SELECT "name" FROM sqlite_master
                  WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
            )
            .all() as { name: string }[]
    ).filter((row) => !virtualPrefixes.some((prefix) => row.name.startsWith(prefix)))) {
        db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);

    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "writable", "updatedAt")
         VALUES (?, '/media/videos', 'Videos', 1, 1, CURRENT_TIMESTAMP)`
    ).run(ROOT);

    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "scopes", "updatedAt")
         VALUES (?, 'a@b.c', 'Curator', 'x', 'admin,delete', CURRENT_TIMESTAMP)`
    ).run(USER);
});

describe("trashing", () => {
    /**
     * The claim the whole design rests on.
     *
     * Nothing in `listMedia` knows this feature exists. If that stops being true — someone
     * drops the `listable` gate, or adds a list path that queries `Media` directly — deleted
     * items come back into the grid, and this is the test that says so.
     */
    it("removes the item from the library without any query knowing why", () => {
        const { fileId } = addMedia("m1");
        addMedia("m2");

        expect(visibleIds().sort()).toEqual(["m1", "m2"]);

        trash("m1", fileId);

        expect(visibleIds()).toEqual(["m2"]);
    });

    it("keeps the item's row, and everything hanging off it", () => {
        const { fileId } = addMedia("m1");
        db.prepare(
            `INSERT INTO "UserMedia" ("userId", "mediaId", "rating", "updatedAt")
             VALUES (?, 'm1', 5, CURRENT_TIMESTAMP)`
        ).run(USER);

        trash("m1", fileId);

        // The point of limbo. A recycle bin that discarded the rating would be restoring a
        // file, not an item — which is the distinction §10 exists to make.
        const rating = db
            .prepare(`SELECT "rating" FROM "UserMedia" WHERE "mediaId" = 'm1'`)
            .get() as { rating: number } | undefined;

        expect(rating?.rating).toBe(5);
    });

    it("marks the file trashed rather than missing", () => {
        const { fileId } = addMedia("m1");
        trash("m1", fileId);

        expect(mediaFileRepo.findById(fileId)?.state).toBe("trashed");
    });

    it("sets the window from the retention setting", () => {
        const { fileId } = addMedia("m1");
        const entry = trash("m1", fileId, 7);

        const days = db
            .prepare(`SELECT julianday(?) - julianday(?) AS d`)
            .get(entry.purgeAfter, entry.deletedAt) as { d: number };

        expect(days.d).toBeCloseTo(7, 1);
    });
});

describe("restoring", () => {
    it("brings the item back into the library", () => {
        const { fileId } = addMedia("m1");
        const entry = trash("m1", fileId);

        trashRepo.markRestored(entry.id);

        expect(visibleIds()).toEqual(["m1"]);
        expect(mediaFileRepo.findById(fileId)?.state).toBe("active");
    });

    it("closes the entry so it cannot be restored or purged twice", () => {
        const { fileId } = addMedia("m1");
        const entry = trash("m1", fileId);

        trashRepo.markRestored(entry.id);

        expect(trashRepo.listPending(50, 0)).toEqual([]);
        expect(trashRepo.findOpenForFile(fileId)).toBeUndefined();
    });

    /**
     * Someone puts the file back with a file manager.
     *
     * The scanner revives the row, and the entry left open would keep counting down to a
     * purge of an item the library is showing. Closing it on revival is the first of the two
     * locks on that door.
     */
    it("closes the entry when the file reappears on its own", () => {
        const { fileId } = addMedia("m1");
        const entry = trash("m1", fileId);
        trashRepo.markMoved(entry.id);

        const result = mediaFileRepo.upsertSeen({
            scanId: "scan-1",
            rootId: ROOT,
            relPath: "m1.mp4",
            size: 1024,
            mtime: 0,
            inode: null,
            classification: "media",
        });

        expect(result.revivedFromTrash).toBe(true);
        expect(trashRepo.markRestoredByFile(fileId)).toBe(true);
        expect(trashRepo.listPending(50, 0)).toEqual([]);
    });

    /**
     * The race this guards against.
     *
     * Trashing hides the row at once and moves the bytes later, so for a while the original is
     * still at its path. A scan that walked past it used to revive the row and close the entry,
     * and the move job then did nothing: the deletion quietly undone.
     */
    it("does not revive a file whose move has not happened yet", () => {
        const { fileId } = addMedia("m1");
        trash("m1", fileId);

        const result = mediaFileRepo.upsertSeen({ ...sighting, isOnDiskNow: () => true });

        expect(result.revivedFromTrash).toBe(false);
        expect(result.file.state).toBe("trashed");
        expect(trashRepo.findOpenForFile(fileId)).toBeDefined();
    });

    /**
     * The scan's `stat` came before the move copied and unlinked the file; its batch commits
     * after. Looking again at commit time is what stops a stale sighting reviving the row.
     */
    it("does not revive a moved file from a sighting taken before it moved", () => {
        const { fileId } = addMedia("m1");
        const entry = trash("m1", fileId);
        trashRepo.markMoved(entry.id);

        const result = mediaFileRepo.upsertSeen({ ...sighting, isOnDiskNow: () => false });

        expect(result.revivedFromTrash).toBe(false);
        expect(result.file.state).toBe("trashed");
    });

    /**
     * What the move job's refusal asks for: "rescan the library and try again". Different
     * bytes at the path are not the original waiting to move, so they come back as the item.
     */
    it("revives an unmoved file whose bytes are no longer the ones catalogued", () => {
        const { fileId } = addMedia("m1");
        trash("m1", fileId);

        const result = mediaFileRepo.upsertSeen({ ...sighting, size: 2048 });

        expect(result.revivedFromTrash).toBe(true);
        expect(result.file.state).toBe("active");
    });

    it("forgets the failures the item picked up in the bin, and keeps the ones from before", () => {
        const { fileId } = addMedia("m1");

        db.prepare(
            `INSERT INTO "MediaStage" ("mediaId", "stage", "version", "state", "attempts", "at")
             VALUES ('m1', 'cover', 1, 'failed', 3, '2020-01-01 00:00:00')`
        ).run();

        const entry = trash("m1", fileId);

        db.prepare(
            `INSERT INTO "MediaStage" ("mediaId", "stage", "version", "state", "attempts", "at")
             VALUES ('m1', 'sprite', 1, 'failed', 3, CURRENT_TIMESTAMP)`
        ).run();
        db.prepare(
            `INSERT INTO "Job" ("id", "kind", "mediaId", "fileId", "state", "finishedAt",
                                "updatedAt")
             VALUES ('j1', 'transcode', 'm1', ?, 'cancelled', CURRENT_TIMESTAMP,
                     CURRENT_TIMESTAMP)`
        ).run(fileId);

        trashRepo.markRestored(entry.id);

        const stages = db
            .prepare(`SELECT "stage" FROM "MediaStage" WHERE "mediaId" = 'm1'`)
            .all() as { stage: string }[];

        expect(stages.map((row) => row.stage)).toEqual(["cover"]);
        expect(db.prepare(`SELECT count(*) AS n FROM "Job"`).get()).toEqual({ n: 0 });
    });
});

describe("the item's other work", () => {
    const addJob = (id: string, kind: string, mediaId: string, state: string): void => {
        db.prepare(
            `INSERT INTO "Job" ("id", "kind", "mediaId", "fileId", "state", "updatedAt")
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        ).run(id, kind, mediaId, `f-${mediaId}`, state);
    };

    const stateOf = (id: string): string | undefined =>
        (
            db.prepare(`SELECT "state" FROM "Job" WHERE "id" = ?`).get(id) as
                { state: string } | undefined
        )?.state;

    it("stops when the item is trashed, and leaves everything else alone", () => {
        const { fileId } = addMedia("m1");
        addMedia("m2");

        addJob("pending", "sprite", "m1", "pending");
        addJob("running", "transcode", "m1", "claimed");
        addJob("move", "restore", "m1", "pending");
        addJob("other", "sprite", "m2", "pending");

        trash("m1", fileId);

        // Deleted, not cancelled: a cancelled row would read as a decision after a restore.
        expect(stateOf("pending")).toBeUndefined();
        // Cancelled, so its runner's next heartbeat misses and the encode is killed.
        expect(stateOf("running")).toBe("cancelled");
        expect(stateOf("move")).toBe("pending");
        expect(stateOf("other")).toBe("pending");
    });
});

describe("purging", () => {
    it("deletes the item but keeps the audit entry", () => {
        const { fileId } = addMedia("m1");
        const entry = trash("m1", fileId);

        trashRepo.purge(entry.id);

        expect(db.prepare(`SELECT count(*) AS n FROM "Media"`).get()).toEqual({ n: 0 });

        const after = trashRepo.findById(entry.id);

        expect(after?.purgedAt).not.toBeNull();
        expect(after?.deletedById).toBe(USER);
        // Null rather than dangling: ON DELETE SET NULL is what lets the record outlive the
        // thing it records.
        expect(after?.mediaId).toBeNull();
    });

    /**
     * A purged entry must never read as a restored one.
     *
     * These are the only two ways an entry can end, they are recorded in the only row that
     * survives the item, and collapsing them into one column would describe every destroyed
     * file as one that came back.
     */
    it("does not record a purge as a restore", () => {
        const { fileId } = addMedia("m1");
        const entry = trash("m1", fileId);

        trashRepo.purge(entry.id);

        expect(trashRepo.findById(entry.id)?.restoredAt).toBeNull();
    });

    it("offers nothing for purge before the window closes", () => {
        const { fileId } = addMedia("m1");
        trash("m1", fileId, 7);

        expect(trashRepo.listPurgeable(10)).toEqual([]);
    });

    it("offers an expired entry, and reports the file state with it", () => {
        const { fileId } = addMedia("m1");
        trash("m1", fileId, 0);

        const [expired] = trashRepo.listPurgeable(10);

        expect(expired?.id).toBeDefined();
        // The guard the purge job reads before doing anything irreversible.
        expect(expired?.fileState).toBe("trashed");
    });

    it("reports a revived file as no longer trashed, so the purge can refuse", () => {
        const { fileId } = addMedia("m1");
        const entry = trash("m1", fileId, 0);
        trashRepo.markMoved(entry.id);

        mediaFileRepo.upsertSeen({
            scanId: "scan-1",
            rootId: ROOT,
            relPath: "m1.mp4",
            size: 1024,
            mtime: 0,
            inode: null,
            classification: "media",
        });

        expect(trashRepo.fileStateOf(fileId)).toBe("active");
    });
});

describe("the queue", () => {
    /**
     * What the free-space check adds to each file it is asked about. Free space only shrinks
     * once a move lands, so a bulk resolve checked against it alone passes every file and then
     * fills the volume holding the database.
     */
    it("counts the bytes accepted into the bin and not yet moved", () => {
        const a = addMedia("m1");
        const b = addMedia("m2");
        const c = addMedia("m3");

        const moved = trash("m1", a.fileId);
        trash("m2", b.fileId);
        const restored = trash("m3", c.fileId);

        expect(trashRepo.unmovedBytes()).toBe(3 * 1024);

        trashRepo.markMoved(moved.id);
        trashRepo.markRestored(restored.id);

        // Moved bytes are already off the free figure; restored ones are not going anywhere.
        expect(trashRepo.unmovedBytes()).toBe(1024);
    });

    it("does not queue the same move twice", () => {
        const { fileId } = addMedia("m1");
        const entry = trash("m1", fileId);

        trashRepo.enqueueMove("trash", entry.id, "m1", fileId);
        trashRepo.enqueueMove("trash", entry.id, "m1", fileId);

        const jobs = db.prepare(`SELECT count(*) AS n FROM "Job" WHERE "kind" = 'trash'`).get();

        expect(jobs).toEqual({ n: 1 });
    });

    /**
     * The hole this test found.
     *
     * The queue's unique index allows one live job per (kind, file), so the second entry's
     * enqueue is refused — and refusing must not throw, or a delete request becomes a 500.
     * What matters is that the move is not simply forgotten.
     */
    it("refuses the second move quietly rather than failing", () => {
        const { fileId } = addMedia("m1");
        const first = trash("m1", fileId);

        trashRepo.enqueueMove("trash", first.id, "m1", fileId);
        trashRepo.markRestored(first.id);

        const second = trash("m1", fileId);

        expect(() => trashRepo.enqueueMove("trash", second.id, "m1", fileId)).not.toThrow();
    });

    it("finds the refused move again once the queue is clear", () => {
        const { fileId } = addMedia("m1");
        const first = trash("m1", fileId);

        trashRepo.enqueueMove("trash", first.id, "m1", fileId);
        trashRepo.markRestored(first.id);

        const second = trash("m1", fileId);
        trashRepo.enqueueMove("trash", second.id, "m1", fileId);

        // Hidden from the sweep while the first job still holds the slot: queueing a second
        // move for the same file is exactly what the queue refuses.
        expect(trashRepo.listAwaitingMove(10)).toEqual([]);

        db.prepare(`UPDATE "Job" SET "state" = 'done'`).run();

        // And found the moment the slot is free, which is what stops the move being lost.
        expect(trashRepo.listAwaitingMove(10).map((row) => row.id)).toEqual([second.id]);
    });

    it("stops owing a move once the bytes are in the bin", () => {
        const { fileId } = addMedia("m1");
        const entry = trash("m1", fileId);

        trashRepo.markMoved(entry.id);

        expect(trashRepo.listAwaitingMove(10)).toEqual([]);
    });
});

describe("identical copies (§10e)", () => {
    const hash = (fileId: string, contentHash: string) =>
        db
            .prepare(`UPDATE "MediaFile" SET "contentHash" = ? WHERE "id" = ?`)
            .run(contentHash, fileId);

    it("finds an active file with the same bytes, preferring the named item's", () => {
        const { fileId: a } = addMedia("a");
        const { fileId: b } = addMedia("b");
        const { fileId: c } = addMedia("c");
        const { fileId: other } = addMedia("other");

        hash(a, "same");
        hash(b, "same");
        hash(c, "same");
        hash(other, "different");

        expect(trashRepo.findIdenticalActiveFile(a, "c")).toBe(c);
        expect(trashRepo.findIdenticalActiveFile(a, null)).toBe(b);
    });

    it("finds nothing for a file that was never fully hashed", () => {
        const { fileId: a } = addMedia("a");
        addMedia("b");

        expect(trashRepo.findIdenticalActiveFile(a, null)).toBeNull();
    });

    it("never offers a twin that is itself in the bin", () => {
        const { fileId: a } = addMedia("a");
        const { fileId: b } = addMedia("b");

        hash(a, "same");
        hash(b, "same");
        trash("b", b);

        expect(trashRepo.findIdenticalActiveFile(a, null)).toBeNull();
    });

    /**
     * The point of the feature: the bin holds no bytes for a copy it can restore from its twin,
     * so neither the space the trash page reports nor the free-space check counts them.
     */
    it("holds and owes no bytes for an entry with a twin", () => {
        const { fileId: a } = addMedia("a");
        const { fileId: b } = addMedia("b");
        const { fileId: c } = addMedia("c");

        trash("a", a, 7, b);
        trash("c", c);

        expect(trashRepo.heldBytes()).toBe(1024);
        expect(trashRepo.unmovedBytes()).toBe(1024);
    });

    it("counts the bytes again once the twin can no longer vouch for them", () => {
        const { fileId: a } = addMedia("a");
        const { fileId: b } = addMedia("b");
        const entry = trash("a", a, 7, b);

        trashRepo.clearTwin(entry.id);

        expect(trashRepo.heldBytes()).toBe(1024);
    });
});

describe("emptying the bin", () => {
    it("lists every open entry, and says which have finished moving", () => {
        const { fileId: a } = addMedia("a");
        const { fileId: b } = addMedia("b");
        const { fileId: c } = addMedia("c");
        const moved = trash("a", a);
        const waiting = trash("b", b);
        const restored = trash("c", c);

        trashRepo.markMoved(moved.id);
        trashRepo.markRestored(restored.id);

        const open = trashRepo.listOpen();

        expect(open.map((row) => row.id).sort()).toEqual([moved.id, waiting.id].sort());
        expect(open.find((row) => row.id === waiting.id)?.movedAt).toBeNull();
    });
});

describe("an identical copy is not the bin's (§10e)", () => {
    it("is never listed, counted, emptied or purged on schedule", () => {
        const { fileId: a } = addMedia("a");
        const { fileId: b } = addMedia("b");
        const { fileId: c } = addMedia("c");

        trash("a", a, 0, b);
        const ordinary = trash("c", c, 0);

        expect(trashRepo.listPending(50, 0).map((row) => row.id)).toEqual([ordinary.id]);
        expect(trashRepo.countPending()).toBe(1);
        expect(trashRepo.listOpen().map((row) => row.id)).toEqual([ordinary.id]);
        expect(trashRepo.listPurgeable(50).map((row) => row.id)).toEqual([ordinary.id]);
    });

    it("becomes an ordinary entry when its twin can no longer vouch for the bytes", () => {
        const { fileId: a } = addMedia("a");
        const { fileId: b } = addMedia("b");
        const entry = trash("a", a, 7, b);

        trashRepo.clearTwin(entry.id);

        expect(trashRepo.listPending(50, 0).map((row) => row.id)).toEqual([entry.id]);
    });
});

describe("purging", () => {
    /**
     * An identical copy is purged seconds after it is trashed (§10e), and anything queued for it
     * in between must not outlive it. `Job` cascades from both the item and its file, so purging
     * takes every job the item has -- a running one included, whose runner then finds its row
     * gone at the next heartbeat and stops as a lost claim rather than a failure.
     */
    it("takes every job the item still has", () => {
        const { fileId } = addMedia("m1");
        const { fileId: other } = addMedia("m2");
        const entry = trash("m1", fileId);
        const job = (id: string, kind: string, state: string, mediaId: string, file: string) =>
            db
                .prepare(
                    `INSERT INTO "Job" ("id", "kind", "mediaId", "fileId", "state", "updatedAt")
                     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
                )
                .run(id, kind, mediaId, file, state);

        db.prepare(`DELETE FROM "Job"`).run();
        job("queued", "probe", "pending", "m1", fileId);
        job("running", "sprite", "claimed", "m1", fileId);
        job("failed", "transcode", "failed", "m1", fileId);
        job("unrelated", "probe", "pending", "m2", other);

        trashRepo.purge(entry.id);

        expect(db.prepare(`SELECT "id" FROM "Job"`).all()).toEqual([{ id: "unrelated" }]);
    });
});

describe("a duplicate that comes back (§10e)", () => {
    const reviewedGroupOf = (...mediaIds: string[]): string => {
        db.prepare(
            `INSERT INTO "DupeGroup" ("id", "kind", "reviewed", "updatedAt")
             VALUES ('g1', 'exact', 1, CURRENT_TIMESTAMP)`
        ).run();

        for (const mediaId of mediaIds) {
            db.prepare(
                `INSERT INTO "DupeMember" ("id", "groupId", "mediaId") VALUES (?, 'g1', ?)`
            ).run(`dm-${mediaId}`, mediaId);
        }

        return "g1";
    };

    const reviewed = (groupId: string) =>
        (
            db.prepare(`SELECT "reviewed" FROM "DupeGroup" WHERE "id" = ?`).get(groupId) as {
                reviewed: number | null;
            }
        ).reviewed;

    /**
     * The case found on a real library: a copy trashed from a group, which was then marked
     * reviewed, was obtained again at its old path. The scan revived it, and it sat on the
     * Reviewed tab as a duplicate nobody would be asked about.
     */
    it("reopens its group when the scan finds it back at its old path", () => {
        addMedia("kept");
        const { fileId } = addMedia("copy");
        const group = reviewedGroupOf("kept", "copy");
        const entry = trash("copy", fileId);

        trashRepo.markMoved(entry.id);
        expect(reviewed(group)).toBe(1);

        trashRepo.markRestoredByFile(fileId);

        expect(reviewed(group)).toBeNull();
    });

    it("reopens its group when an administrator restores it", () => {
        addMedia("kept");
        const { fileId } = addMedia("copy");
        const group = reviewedGroupOf("kept", "copy");
        const entry = trash("copy", fileId);

        trashRepo.markRestored(entry.id);

        expect(reviewed(group)).toBeNull();
    });
});
