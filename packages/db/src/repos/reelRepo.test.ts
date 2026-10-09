import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Clips and reels (§14d).
 *
 * Four claims, and each of them fails silently if it is wrong:
 *
 *  - **Positions stay dense.** Nothing here shuffles, but "3 of 12" and `moveItem` both read the
 *    numbers, and a purge removes rows from the middle without going through `removeItem`.
 *  - **A clip may appear twice.** A refrain is a cut, which is why entries are named by
 *    `ReelItem.id` and not by clip id.
 *  - **A reel holds only its owner's clips.** The invariant the whole design rests on.
 *  - **Duration is run time.** A span at half speed takes twice as long to watch, and summing
 *    raw spans is right until somebody uses the speed control.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const clipRepo = await import("./clipRepo.js");
const reelRepo = await import("./reelRepo.js");
const { db: sharedDb } = await import("../db.js");

const ROOT = "aaaaaaaa-0000-4000-8000-000000000000";
const OTHER_ROOT = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "bbbbbbbb-0000-4000-8000-000000000000";
const FRIEND = "bbbbbbbb-0000-4000-8000-000000000001";

const addMedia = (id: string, rootId = ROOT): string => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "durationMs", "updatedAt")
         VALUES (?, 'video', ?, 600000, CURRENT_TIMESTAMP)`
    ).run(id, id);

    db.prepare(
        `INSERT INTO "MediaFile"
             ("id", "rootId", "relPath", "size", "mtime", "lastSeenAt", "updatedAt")
         VALUES (?, ?, ?, 1024, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(`f-${id}`, rootId, `${id}.mp4`);

    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l-${id}`, id, `f-${id}`);

    return id;
};

let sequence = 0;

const newReel = (ownerId = USER, visibility: "private" | "shared" = "private"): string =>
    reelRepo.create({
        ownerId,
        name: `Reel ${(sequence += 1)}`,
        description: null,
        visibility,
    });

const newClip = (
    mediaId: string,
    options: { userId?: string; startMs?: number; endMs?: number; speed?: number | null } = {}
): string =>
    clipRepo.create({
        mediaId,
        userId: options.userId ?? USER,
        startMs: options.startMs ?? 1_000,
        endMs: options.endMs ?? 11_000,
        label: null,
        speed: options.speed ?? null,
    });

const positions = (reelId: string): number[] =>
    (
        db
            .prepare(`SELECT "position" FROM "ReelItem" WHERE "reelId" = ? ORDER BY "position"`)
            .all(reelId) as { position: number }[]
    ).map((row) => row.position);

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

    for (const [id, rootPath] of [
        [ROOT, "/media/videos"],
        [OTHER_ROOT, "/media/private"],
    ]) {
        db.prepare(
            `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "writable", "updatedAt")
             VALUES (?, ?, 'Lib', 1, 1, CURRENT_TIMESTAMP)`
        ).run(id, rootPath);
    }

    for (const [id, email, name] of [
        [USER, "a@b.c", "Curator"],
        [FRIEND, "d@e.f", "Friend"],
    ]) {
        db.prepare(
            `INSERT INTO "User" ("id", "email", "displayName", "password", "scopes", "updatedAt")
             VALUES (?, ?, ?, 'x', '', CURRENT_TIMESTAMP)`
        ).run(id, email, name);
    }
});

describe("the owner invariant", () => {
    it("refuses a clip belonging to somebody else", () => {
        const reel = newReel(USER);
        addMedia("a");
        const theirs = newClip("a", { userId: FRIEND });

        expect(reelRepo.addItems(reel, USER, [theirs])).toBe(0);
        expect(reelRepo.countItems(reel)).toBe(0);
    });

    it("accepts the owner's own clips and reports how many went in", () => {
        const reel = newReel(USER);
        addMedia("a");
        const mine = newClip("a");
        const theirs = newClip("a", { userId: FRIEND });

        expect(reelRepo.addItems(reel, USER, [mine, theirs])).toBe(1);
        expect(positions(reel)).toEqual([0]);
    });

    it("refuses an unattributed clip, which is nobody's to arrange", () => {
        const reel = newReel(USER);
        addMedia("a");
        const orphan = newClip("a");
        db.prepare(`UPDATE "Clip" SET "userId" = NULL WHERE "id" = ?`).run(orphan);

        expect(reelRepo.addItems(reel, USER, [orphan])).toBe(0);
    });
});

describe("membership and order", () => {
    it("appends in the order given", () => {
        const reel = newReel();
        ["a", "b", "c"].forEach((id) => addMedia(id));
        const clips = ["a", "b", "c"].map((id) => newClip(id));

        expect(reelRepo.addItems(reel, USER, clips)).toBe(3);
        expect(reelRepo.listEntries(reel).map((entry) => entry.clipId)).toEqual(clips);
    });

    it("lets the same clip appear twice, because a refrain is a cut", () => {
        const reel = newReel();
        addMedia("a");
        const clip = newClip("a");

        expect(reelRepo.addItems(reel, USER, [clip, clip])).toBe(2);

        const entries = reelRepo.listEntries(reel);

        expect(entries).toHaveLength(2);
        // Two rows, two ids: this is why remove and move name a ReelItem and not a clip.
        expect(entries[0].id).not.toBe(entries[1].id);
        expect(entries[0].clipId).toBe(entries[1].clipId);
    });

    it("removes one occurrence of a repeated clip and leaves the other", () => {
        const reel = newReel();
        addMedia("a");
        const clip = newClip("a");
        reelRepo.addItems(reel, USER, [clip, clip]);
        const [first] = reelRepo.listEntries(reel);

        expect(reelRepo.removeItem(reel, first.id)).toBe(true);

        const left = reelRepo.listEntries(reel);

        expect(left).toHaveLength(1);
        expect(left[0].id).not.toBe(first.id);
    });

    it("closes the gap behind a removal", () => {
        const reel = newReel();
        ["a", "b", "c", "d"].forEach((id) => addMedia(id));
        const clips = ["a", "b", "c", "d"].map((id) => newClip(id));
        reelRepo.addItems(reel, USER, clips);

        reelRepo.removeItem(reel, reelRepo.listEntries(reel)[1].id);

        expect(positions(reel)).toEqual([0, 1, 2]);
    });

    it("renumbers completely on a move", () => {
        const reel = newReel();
        ["a", "b", "c"].forEach((id) => addMedia(id));
        const clips = ["a", "b", "c"].map((id) => newClip(id));
        reelRepo.addItems(reel, USER, clips);

        const entries = reelRepo.listEntries(reel);

        expect(reelRepo.moveItem(reel, entries[2].id, 0)).toBe(true);
        expect(reelRepo.listEntries(reel).map((entry) => entry.clipId)).toEqual([
            clips[2],
            clips[0],
            clips[1],
        ]);
        expect(positions(reel)).toEqual([0, 1, 2]);
    });

    it("clamps a move past the end rather than refusing it", () => {
        const reel = newReel();
        ["a", "b"].forEach((id) => addMedia(id));
        reelRepo.addItems(
            reel,
            USER,
            ["a", "b"].map((id) => newClip(id))
        );

        expect(reelRepo.moveItem(reel, reelRepo.listEntries(reel)[0].id, 99)).toBe(true);
        expect(positions(reel)).toEqual([0, 1]);
    });
});

describe("what a cascade leaves behind", () => {
    it("purging an item takes its spans out of the middle and leaves holes", () => {
        const reel = newReel();
        ["a", "b", "c"].forEach((id) => addMedia(id));
        reelRepo.addItems(
            reel,
            USER,
            ["a", "b", "c"].map((id) => newClip(id))
        );

        // What `trashRepo.purge` does, and it does not go through `removeItem`.
        db.prepare(`DELETE FROM "Media" WHERE "id" = ?`).run("b");

        expect(positions(reel)).toEqual([0, 2]);
    });

    it("renumber closes them, which is why purge has to call it", () => {
        const reel = newReel();
        ["a", "b", "c"].forEach((id) => addMedia(id));
        reelRepo.addItems(
            reel,
            USER,
            ["a", "b", "c"].map((id) => newClip(id))
        );

        const affected = reelRepo.reelIdsHoldingMedia("b");

        db.prepare(`DELETE FROM "Media" WHERE "id" = ?`).run("b");
        affected.forEach((id) => reelRepo.renumber(id));

        expect(affected).toEqual([reel]);
        expect(positions(reel)).toEqual([0, 1]);
    });

    it("finds the affected reels before the delete, when there is still a join to follow", () => {
        const reel = newReel();
        addMedia("a");
        reelRepo.addItems(reel, USER, [newClip("a")]);

        db.prepare(`DELETE FROM "Media" WHERE "id" = ?`).run("a");

        expect(reelRepo.reelIdsHoldingMedia("a")).toEqual([]);
    });

    it("deleting a clip removes its entries and leaves the reel to be renumbered", () => {
        const reel = newReel();
        ["a", "b"].forEach((id) => addMedia(id));
        const first = newClip("a");
        reelRepo.addItems(reel, USER, [first, newClip("b")]);

        expect(clipRepo.reelsUsing(first)).toHaveLength(1);

        clipRepo.remove(first);
        reelRepo.renumber(reel);

        expect(positions(reel)).toEqual([0]);
    });
});

describe("running time", () => {
    it("is the sum of the spans when nothing carries a speed", () => {
        const reel = newReel();
        addMedia("a");
        reelRepo.addItems(reel, USER, [newClip("a", { startMs: 0, endMs: 10_000 })]);

        expect(reelRepo.runningMs(reel)).toBe(10_000);
    });

    it("is longer than the spans at half speed, which is the whole point", () => {
        const reel = newReel();
        addMedia("a");
        reelRepo.addItems(reel, USER, [
            newClip("a", { startMs: 0, endMs: 10_000, speed: 0.5 }),
            newClip("a", { startMs: 0, endMs: 10_000 }),
        ]);

        // 20s for the slow one plus 10s for the other. Summing raw spans would say 20s.
        expect(reelRepo.runningMs(reel)).toBe(30_000);
        expect(reelRepo.findSummary(reel)?.runningMs).toBe(30_000);
    });
});

describe("the index", () => {
    it("shows your own and anything shared, and not somebody else's private reel", () => {
        newReel(USER, "private");
        newReel(FRIEND, "shared");
        newReel(FRIEND, "private");

        const query = {
            ownership: "all" as const,
            sort: "updated" as const,
            limit: 50,
            page: 0,
        };

        expect(reelRepo.listVisibleTo(query, USER, "desc")).toHaveLength(2);
        expect(reelRepo.countVisibleTo(query, USER)).toBe(2);
    });

    it("narrows to mine, and to what the house offered", () => {
        newReel(USER, "private");
        newReel(FRIEND, "shared");

        const base = { sort: "updated" as const, limit: 50, page: 0 };

        expect(reelRepo.listVisibleTo({ ...base, ownership: "mine" }, USER, "desc")).toHaveLength(
            1
        );
        expect(reelRepo.listVisibleTo({ ...base, ownership: "shared" }, USER, "desc")).toHaveLength(
            1
        );
    });

    it("searches name and description with LIKE, and escapes the wildcards", () => {
        reelRepo.create({
            ownerId: USER,
            name: "Florida 2026",
            description: "family cut",
            visibility: "private",
        });
        reelRepo.create({
            ownerId: USER,
            name: "100% keepers",
            description: null,
            visibility: "private",
        });

        const base = { ownership: "all" as const, sort: "name" as const, limit: 50, page: 0 };

        expect(reelRepo.listVisibleTo({ ...base, search: "flor" }, USER, "asc")).toHaveLength(1);
        expect(reelRepo.listVisibleTo({ ...base, search: "family" }, USER, "asc")).toHaveLength(1);
        // A bare "%" would otherwise match everything.
        expect(reelRepo.listVisibleTo({ ...base, search: "100%" }, USER, "asc")).toHaveLength(1);
    });

    it("sorts by running time, which speed changes", () => {
        const slow = newReel();
        const fast = newReel();
        addMedia("a");
        reelRepo.addItems(slow, USER, [newClip("a", { startMs: 0, endMs: 5_000, speed: 0.25 })]);
        reelRepo.addItems(fast, USER, [newClip("a", { startMs: 0, endMs: 10_000 })]);

        const ordered = reelRepo.listVisibleTo(
            { ownership: "all", sort: "duration", limit: 50, page: 0 },
            USER,
            "desc"
        );

        // 5s at quarter speed is 20s, so the shorter span is the longer reel.
        expect(ordered[0].id).toBe(slow);
    });
});

describe("clips", () => {
    it("lists an item's clips in timeline order, never creation order", () => {
        addMedia("a");
        const late = newClip("a", { startMs: 90_000, endMs: 95_000 });
        const early = newClip("a", { startMs: 1_000, endMs: 5_000 });

        expect(clipRepo.listForMedia("a", USER).map((clip) => clip.id)).toEqual([early, late]);
    });

    it("never returns another account's clips from the item page", () => {
        addMedia("a");
        newClip("a", { userId: FRIEND });

        expect(clipRepo.listForMedia("a", USER)).toHaveLength(0);
        expect(clipRepo.countForMedia("a", USER)).toBe(0);
    });

    it("never returns another account's clips from the browser", () => {
        addMedia("a");
        newClip("a", { userId: FRIEND });
        newClip("a");

        const found = clipRepo.search(
            { ownership: "all", sort: "created", limit: 50, page: 0 } as never,
            { userId: USER, accessibleRootIds: null },
            "desc"
        );

        expect(found).toHaveLength(1);
        expect(found[0].userId).toBe(USER);
    });

    /**
     * Hiding is "do not show me this" (§6): an item put away must not come back through the clip
     * browser. On the item's own page it was opened on purpose, so its clips are still listed.
     */
    it("leaves out clips of an item this person has hidden, except when asked for that item", () => {
        addMedia("a");
        addMedia("b");
        newClip("a");
        const hiddenOne = newClip("b");

        db.prepare(
            `INSERT INTO "UserMedia" ("userId", "mediaId", "hidden", "updatedAt")
             VALUES (?, 'b', 1, CURRENT_TIMESTAMP)`
        ).run(USER);

        const browse = (query: Record<string, unknown> = {}) =>
            clipRepo.search(
                { ownership: "all", sort: "created", limit: 50, page: 0, ...query } as never,
                { userId: USER, accessibleRootIds: null },
                "desc"
            );

        expect(browse().map((clip) => clip.mediaId)).toEqual(["a"]);
        expect(
            clipRepo.countSearch({ ownership: "all" } as never, {
                userId: USER,
                accessibleRootIds: null,
            })
        ).toBe(1);
        expect(browse({ mediaId: "b" }).map((clip) => clip.id)).toEqual([hiddenOne]);

        // Somebody else hiding it changes nothing for this person.
        db.prepare(
            `UPDATE "UserMedia" SET "hidden" = NULL WHERE "userId" = ? AND "mediaId" = 'b'`
        ).run(USER);
        db.prepare(
            `INSERT INTO "UserMedia" ("userId", "mediaId", "hidden", "updatedAt")
             VALUES (?, 'b', 1, CURRENT_TIMESTAMP)`
        ).run(FRIEND);

        expect(browse()).toHaveLength(2);
    });

    it("does return another account's clips by id, which is how a shared reel is read", () => {
        addMedia("a");
        const theirs = newClip("a", { userId: FRIEND });

        expect(clipRepo.listByIds([theirs])).toHaveLength(1);
    });

    it("keeps listByIds in the order asked for, because a reel is a sequence", () => {
        addMedia("a");
        const one = newClip("a", { startMs: 1_000, endMs: 2_000 });
        const two = newClip("a", { startMs: 3_000, endMs: 4_000 });

        expect(clipRepo.listByIds([two, one]).map((clip) => clip.id)).toEqual([two, one]);
    });

    it("hides clips in a library this account can no longer reach", () => {
        addMedia("a", OTHER_ROOT);
        newClip("a");

        expect(
            clipRepo.search(
                { ownership: "all", sort: "created", limit: 50, page: 0 } as never,
                { userId: USER, accessibleRootIds: [ROOT] },
                "desc"
            )
        ).toHaveLength(0);
    });

    it("hides clips of an item in the trash, and shows them again once it is restored", () => {
        addMedia("a");
        addMedia("b");
        newClip("a");
        newClip("b");

        const search = () =>
            clipRepo.search(
                { sort: "created", limit: 50, page: 0 } as never,
                { userId: USER, accessibleRootIds: null },
                "desc"
            );
        const count = () =>
            clipRepo.countSearch({ sort: "created", limit: 50, page: 0 } as never, {
                userId: USER,
                accessibleRootIds: null,
            });

        expect(search()).toHaveLength(2);

        db.prepare(`UPDATE "MediaFile" SET "state" = 'trashed' WHERE "id" = 'f-b'`).run();

        expect(search().map((clip) => clip.mediaId)).toEqual(["a"]);
        expect(count()).toBe(1);

        db.prepare(`UPDATE "MediaFile" SET "state" = 'active' WHERE "id" = 'f-b'`).run();

        expect(count()).toBe(2);
    });

    it("finds the clips nobody has used yet", () => {
        const reel = newReel();
        ["a", "b"].forEach((id) => addMedia(id));
        const used = newClip("a");
        newClip("b");
        reelRepo.addItems(reel, USER, [used]);

        const unused = clipRepo.search(
            { unusedOnly: true, sort: "created", limit: 50, page: 0 } as never,
            { userId: USER, accessibleRootIds: null },
            "desc"
        );

        expect(unused).toHaveLength(1);
        expect(unused[0].mediaId).toBe("b");
    });

    it("counts the reels holding a clip, and names them without a viewer filter", () => {
        const one = newReel();
        const two = newReel();
        addMedia("a");
        const clip = newClip("a");
        reelRepo.addItems(one, USER, [clip]);
        reelRepo.addItems(two, USER, [clip]);

        expect(clipRepo.findSummary(clip)?.reelCount).toBe(2);
        expect(
            clipRepo
                .reelsUsing(clip)
                .map((reel) => reel.id)
                .sort()
        ).toEqual([one, two].sort());
    });

    it("suggests only labels this person has used", () => {
        addMedia("a");
        clipRepo.create({
            mediaId: "a",
            userId: USER,
            startMs: 0,
            endMs: 5_000,
            label: "beach",
            speed: null,
        });
        clipRepo.create({
            mediaId: "a",
            userId: FRIEND,
            startMs: 0,
            endMs: 5_000,
            label: "theirs",
            speed: null,
        });

        expect(clipRepo.distinctLabels(USER)).toEqual(["beach"]);
    });

    it("clears a speed with null and leaves it alone when unmentioned", () => {
        addMedia("a");
        const clip = newClip("a", { speed: 0.5 });

        clipRepo.update(clip, { label: "named" });
        expect(clipRepo.findById(clip)?.speed).toBe(0.5);

        clipRepo.update(clip, { speed: null });
        expect(clipRepo.findById(clip)?.speed).toBeNull();
    });
});

describe("what the duplicate reviewer is told", () => {
    it("counts the spans a purge would destroy, and names the reader's own reels", () => {
        const reel = newReel();
        addMedia("a");
        const mine = newClip("a");
        newClip("a", { userId: FRIEND });
        reelRepo.addItems(reel, USER, [mine]);

        const risk = reelRepo.clipsAtRiskFor("a", USER);

        expect(risk).toEqual({
            mine: 1,
            total: 2,
            reels: [{ id: reel, name: expect.any(String) }],
        });
    });

    it("says nothing is at risk for an item nobody has clipped", () => {
        addMedia("a");

        expect(reelRepo.clipsAtRiskFor("a", USER)).toEqual({ mine: 0, total: 0, reels: [] });
    });
});
