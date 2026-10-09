import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Playlists (§6).
 *
 * The claims worth proving are about *order* and about what a viewer may see. Ordering is the
 * whole content of a playlist, so a move that renumbers wrongly silently corrupts it; and
 * `listByIds` is the one place a shared playlist could leak an item from a library the viewer
 * has no access to.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const playlistRepo = await import("./playlistRepo.js");
const mediaRepo = await import("./mediaRepo.js");
const { db: sharedDb } = await import("../db.js");

const ROOT = "aaaaaaaa-0000-4000-8000-000000000000";
const OTHER_ROOT = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "bbbbbbbb-0000-4000-8000-000000000000";
const FRIEND = "bbbbbbbb-0000-4000-8000-000000000001";

const addMedia = (id: string, rootId = ROOT): string => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
         VALUES (?, 'video', ?, CURRENT_TIMESTAMP)`
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

const newPlaylist = (
    ownerId = USER,
    visibility: "private" | "shared" = "private",
    options: { name?: string; pinned?: boolean } = {}
) =>
    playlistRepo.create({
        ownerId,
        name: options.name ?? `List ${(sequence += 1)}`,
        description: null,
        visibility,
        pinned: options.pinned ?? false,
    });

const order = (playlistId: string): string[] => playlistRepo.listItemIds(playlistId, 100, 0);

/**
 * The stored positions themselves, which shuffle makes observable (§14b).
 *
 * `order` cannot see a hole — it reads the sequence, and a gap sorts the same way. The
 * numbers are what a permutation of the position space actually addresses.
 */
const positions = (playlistId: string): number[] =>
    (
        db
            .prepare(
                `SELECT "position" FROM "PlaylistItem" WHERE "playlistId" = ?
                  ORDER BY "position" ASC`
            )
            .all(playlistId) as { position: number }[]
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

describe("membership", () => {
    it("appends in the order given and reports what was new", () => {
        const playlist = newPlaylist();
        ["a", "b", "c"].forEach((id) => addMedia(id));

        expect(playlistRepo.addItems(playlist, ["c", "a", "b"])).toBe(3);
        expect(order(playlist)).toEqual(["c", "a", "b"]);

        // Adding a set that overlaps is a normal thing to do from a filter, so the ones
        // already present are skipped rather than failing the batch.
        addMedia("d");
        expect(playlistRepo.addItems(playlist, ["a", "d"])).toBe(1);
        expect(order(playlist)).toEqual(["c", "a", "b", "d"]);
    });

    it("closes the gap a removal would leave, and keeps the order intact", () => {
        const playlist = newPlaylist();
        ["a", "b", "c"].forEach((id) => addMedia(id));
        playlistRepo.addItems(playlist, ["a", "b", "c"]);

        expect(playlistRepo.removeItem(playlist, "b")).toBe(true);
        expect(order(playlist)).toEqual(["a", "c"]);

        // Shuffle permutes the position space rather than sorting it (§14b), so a hole is a
        // slot that resolves to nothing and the count stops matching the highest position.
        expect(positions(playlist)).toEqual([0, 1]);

        // The gap must not strand a later append behind the removed position.
        addMedia("d");
        playlistRepo.addItems(playlist, ["d"]);
        expect(order(playlist)).toEqual(["a", "c", "d"]);
        expect(positions(playlist)).toEqual([0, 1, 2]);
    });

    it("stays dense through repeated removals from both ends", () => {
        const playlist = newPlaylist();
        ["a", "b", "c", "d", "e"].forEach((id) => addMedia(id));
        playlistRepo.addItems(playlist, ["a", "b", "c", "d", "e"]);

        // The first and the last are the two that a shift-by-one could get wrong in
        // opposite directions.
        playlistRepo.removeItem(playlist, "a");
        playlistRepo.removeItem(playlist, "e");
        playlistRepo.removeItem(playlist, "c");

        expect(order(playlist)).toEqual(["b", "d"]);
        expect(positions(playlist)).toEqual([0, 1]);
    });

    it("changes nothing when the item is not a member", () => {
        const playlist = newPlaylist();
        ["a", "b"].forEach((id) => addMedia(id));
        playlistRepo.addItems(playlist, ["a", "b"]);

        expect(playlistRepo.removeItem(playlist, "nope")).toBe(false);
        expect(positions(playlist)).toEqual([0, 1]);
    });

    it("counts entries whether or not the media is visible", () => {
        const playlist = newPlaylist();
        ["a", "b"].forEach((id) => addMedia(id));
        playlistRepo.addItems(playlist, ["a", "b"]);

        expect(playlistRepo.countItems(playlist)).toBe(2);
        expect(playlistRepo.findSummary(playlist)?.itemCount).toBe(2);
    });

    it("refuses to move an item that is not a member", () => {
        const playlist = newPlaylist();
        addMedia("a");
        playlistRepo.addItems(playlist, ["a"]);

        expect(playlistRepo.moveItem(playlist, "nope", 0)).toBe(false);
    });
});

describe("moving an item", () => {
    const setup = (): string => {
        const playlist = newPlaylist();
        ["a", "b", "c", "d"].forEach((id) => addMedia(id));
        playlistRepo.addItems(playlist, ["a", "b", "c", "d"]);

        return playlist;
    };

    it("moves forwards, backwards, and to either end", () => {
        const playlist = setup();

        playlistRepo.moveItem(playlist, "a", 2);
        expect(order(playlist)).toEqual(["b", "c", "a", "d"]);

        playlistRepo.moveItem(playlist, "d", 0);
        expect(order(playlist)).toEqual(["d", "b", "c", "a"]);

        // Past the end clamps rather than erroring — a drag to the bottom of a list should
        // land at the bottom, not fail because the index was one too many.
        playlistRepo.moveItem(playlist, "d", 99);
        expect(order(playlist)).toEqual(["b", "c", "a", "d"]);
    });

    it("leaves the order unchanged when an item is moved onto itself", () => {
        const playlist = setup();

        playlistRepo.moveItem(playlist, "b", 1);

        expect(order(playlist)).toEqual(["a", "b", "c", "d"]);
    });
});

describe("visibility", () => {
    it("lists a user's own playlists and anyone's shared ones, own first", () => {
        newPlaylist(USER, "private");
        newPlaylist(FRIEND, "shared");
        const hidden = newPlaylist(FRIEND, "private");

        const visible = playlistRepo.listVisibleTo(USER);

        expect(visible.map((row) => row.ownerId)).toEqual([USER, FRIEND]);
        expect(visible.map((row) => row.id)).not.toContain(hidden);
    });

    it("carries the owner's name, so a shared playlist can say whose it is", () => {
        const playlist = newPlaylist(FRIEND, "shared");

        expect(playlistRepo.findSummary(playlist)?.ownerName).toBe("Friend");
    });
});

describe("the owner's arrangement", () => {
    it("puts pinned playlists first, then the order they were arranged in", () => {
        const first = newPlaylist(USER, "private", { name: "Zebra" });
        const pinned = newPlaylist(USER, "private", { name: "Aardvark", pinned: true });

        expect(playlistRepo.listVisibleTo(USER).map((row) => row.id)).toEqual([pinned, first]);
    });

    /**
     * A pin describes your own sidebar, not anyone else's.
     *
     * Someone else's pin says where *they* want a playlist in *their* list of lists, and
     * honouring it here would let one account reorder every other account's sidebar by pinning
     * something and sharing it.
     */
    it("ignores another account's pin and sorts their shared playlists by name", () => {
        const theirs = newPlaylist(FRIEND, "shared", { name: "Zebra", pinned: true });
        const alsoTheirs = newPlaylist(FRIEND, "shared", { name: "Aardvark" });
        const mine = newPlaylist(USER, "private", { name: "Mine" });

        expect(playlistRepo.listVisibleTo(USER).map((row) => row.id)).toEqual([
            mine,
            alsoTheirs,
            theirs,
        ]);
    });
});

describe("hydrating a list of ids", () => {
    it("returns them in the order asked for, not the table's", () => {
        ["a", "b", "c"].forEach((id) => addMedia(id));

        const rows = mediaRepo.listByIds(["c", "a", "b"], USER, [ROOT]);

        expect(rows.map((row) => row.id)).toEqual(["c", "a", "b"]);
    });

    /**
     * The one that matters.
     *
     * A shared playlist is the only place one account's collection is rendered for another,
     * so if access were trusted to the playlist rather than re-checked per viewer, sharing a
     * playlist would be a way to hand over items from a library the viewer cannot reach.
     */
    it("drops items from libraries the viewer cannot reach", () => {
        addMedia("mine", ROOT);
        addMedia("theirs", OTHER_ROOT);

        const rows = mediaRepo.listByIds(["mine", "theirs"], FRIEND, [ROOT]);

        expect(rows.map((row) => row.id)).toEqual(["mine"]);
    });

    it("drops items the viewer has hidden, and items that are no longer listable", () => {
        addMedia("hidden");
        addMedia("trashed");

        db.prepare(
            `INSERT INTO "UserMedia" ("userId", "mediaId", "hidden", "updatedAt")
             VALUES (?, 'hidden', 1, CURRENT_TIMESTAMP)`
        ).run(USER);

        db.prepare(`UPDATE "MediaFile" SET "state" = 'trashed' WHERE "id" = 'f-trashed'`).run();

        expect(mediaRepo.listByIds(["hidden", "trashed"], USER, [ROOT])).toEqual([]);
    });

    it("returns nothing when the viewer has no accessible libraries", () => {
        addMedia("a");

        expect(mediaRepo.listByIds(["a"], USER, [])).toEqual([]);
    });
});

describe("shuffled pages", () => {
    /** Every id the shuffle yields, walked page by page until the permutation is spent. */
    const walk = (playlistId: string, seed: number, pageSize: number): string[] => {
        const seen: string[] = [];

        for (let page = 0; page < 200; page += 1) {
            const result = playlistRepo.listItemIdsShuffled(playlistId, page, pageSize, seed);

            seen.push(...result.ids);

            if (!result.hasMore) {
                break;
            }
        }

        return seen;
    };

    const filled = (size: number): string => {
        const playlist = newPlaylist();
        const ids = Array.from({ length: size }, (_, index) => `m${index}`);

        ids.forEach((id) => addMedia(id));
        playlistRepo.addItems(playlist, ids);

        return playlist;
    };

    it("visits every item exactly once, including the first", () => {
        const playlist = filled(25);

        // Position 0 is the case a 1-based slot space would silently drop: it is the one
        // item the permutation cannot address if the offset is wrong, and losing it looks
        // like a playlist that is merely missing something.
        const seen = walk(playlist, 7, 10);

        expect([...seen].sort()).toEqual(
            Array.from({ length: 25 }, (_, index) => `m${index}`).sort()
        );
        expect(new Set(seen).size).toBe(25);
    });

    it("is not the stored order, and is stable for a seed", () => {
        const playlist = filled(30);

        const first = walk(playlist, 3, 30);
        const again = walk(playlist, 3, 30);

        expect(again).toEqual(first);
        expect(first).not.toEqual(playlistRepo.listItemIds(playlist, 100, 0));
    });

    it("gives an unrelated order for a different seed", () => {
        const playlist = filled(30);

        // Consecutive seeds are what the reshuffle button produces, and `shuffleParams`
        // mixes them precisely so the next one is not the last one shifted by a row.
        expect(walk(playlist, 4, 30)).not.toEqual(walk(playlist, 5, 30));
    });

    it("says nothing is coming for an empty playlist", () => {
        expect(playlistRepo.listItemIdsShuffled(newPlaylist(), 0, 60, 1)).toEqual({
            ids: [],
            hasMore: false,
        });
    });

    it("keeps its pages non-overlapping when one comes back short", () => {
        // The prime overshoots the top position, so some slots resolve to nothing and a page
        // arrives short without the shuffle being over. Treating short as final would
        // truncate the playlist at an arbitrary point.
        const playlist = filled(12);
        const pages: string[][] = [];

        for (let page = 0; page < 20; page += 1) {
            const result = playlistRepo.listItemIdsShuffled(playlist, page, 5, 11);

            pages.push(result.ids);

            if (!result.hasMore) break;
        }

        const flat = pages.flat();

        expect(new Set(flat).size).toBe(flat.length);
        expect(flat.length).toBe(12);
    });

    it("drops an item from the shuffle as soon as it leaves the playlist", () => {
        const playlist = filled(15);

        playlistRepo.removeItem(playlist, "m7");

        const seen = walk(playlist, 2, 15);

        expect(seen).not.toContain("m7");
        // Removal closes the gap, so the permutation still addresses a dense space and no
        // other item is lost with it.
        expect(seen.length).toBe(14);
    });
});

/**
 * The sample behind a playlist card's mosaic (§14b).
 *
 * Spread across the whole list rather than taken off the top, which is the only thing that
 * makes the face of a card worth looking at: a long playlist frozen out of one filter would
 * otherwise show four near-identical stills from its opening minute.
 */
describe("sampling items for a cover", () => {
    const fill = (playlistId: string, count: number): void => {
        playlistRepo.addItems(
            playlistId,
            Array.from({ length: count }, (_, index) => addMedia(`s${index}`))
        );
    };

    it("has nothing to sample from an empty playlist", () => {
        expect(playlistRepo.sampleItemIds(newPlaylist(), 4)).toEqual([]);
    });

    it("returns everything, once, when the playlist is shorter than the sample", () => {
        const playlist = newPlaylist();

        fill(playlist, 2);

        expect(playlistRepo.sampleItemIds(playlist, 4)).toEqual(["s0", "s1"]);
    });

    it("spreads across the whole playlist rather than taking the first few", () => {
        const playlist = newPlaylist();

        fill(playlist, 20);

        expect(playlistRepo.sampleItemIds(playlist, 4)).toEqual(["s0", "s5", "s10", "s15"]);
    });

    /** Positions are dense, so every index the arithmetic picks is an entry that exists. */
    it("still lands on real entries after a removal has closed the gaps", () => {
        const playlist = newPlaylist();

        fill(playlist, 8);
        playlistRepo.removeItem(playlist, "s3");

        expect(playlistRepo.sampleItemIds(playlist, 4)).toHaveLength(4);
    });
});
