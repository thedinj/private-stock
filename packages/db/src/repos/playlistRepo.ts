import { randomUUID } from "node:crypto";

import {
    shuffleExhausted,
    shufflePageSlots,
    shuffleParams,
    type PlaylistSortMode,
    type UpdatePlaylistInput,
} from "@private-stock/core";

import { db } from "../db.js";

/**
 * Playlists and their ordered membership (§6).
 *
 * Private by default, shareable read-only. There is no cross-user write anywhere in here —
 * collaborative editing means conflict resolution, and a playlist is not worth it.
 *
 * Membership is stored as an explicit `position` rather than being derived from insertion
 * order, because the order *is* the content: a reel or a viewing session is the sequence,
 * not the set.
 */

export interface PlaylistRow {
    id: string;
    ownerId: string;
    name: string;
    description: string | null;
    visibility: "private" | "shared";
    sortMode: PlaylistSortMode | null;
    pinned: 1 | null;
    position: number;
    createdAt: string;
    updatedAt: string;
}

export interface PlaylistSummaryRow extends PlaylistRow {
    /** Entries, not visible items — see `listItemIds`. */
    itemCount: number;
    ownerName: string;
}

export interface NewPlaylistInput {
    ownerId: string;
    name: string;
    description: string | null;
    visibility: "private" | "shared";
    pinned: boolean;
}

const SUMMARY_SELECTION = `
    SELECT p.*, u."displayName" AS "ownerName",
           (SELECT COUNT(*) FROM "PlaylistItem" pi WHERE pi."playlistId" = p."id") AS "itemCount"
      FROM "Playlist" p
      JOIN "User" u ON u."id" = p."ownerId"
`;

export const create = (input: NewPlaylistInput): string => {
    const id = randomUUID();

    const next = db
        .prepare(
            `SELECT COALESCE(MAX("position"), -1) + 1 AS n FROM "Playlist" WHERE "ownerId" = ?`
        )
        .get(input.ownerId) as { n: number };

    db.prepare(
        `INSERT INTO "Playlist"
             ("id", "ownerId", "name", "description", "visibility", "pinned", "position",
              "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(
        id,
        input.ownerId,
        input.name,
        input.description,
        input.visibility,
        // 1 or NULL, never 0 — the column's CHECK and the conventions both require it.
        input.pinned ? 1 : null,
        next.n
    );

    return id;
};

export const findById = (id: string): PlaylistRow | undefined =>
    db.prepare(`SELECT * FROM "Playlist" WHERE "id" = ?`).get(id) as PlaylistRow | undefined;

export const findSummary = (id: string): PlaylistSummaryRow | undefined =>
    db.prepare(`${SUMMARY_SELECTION} WHERE p."id" = ?`).get(id) as PlaylistSummaryRow | undefined;

/**
 * What this user can open: their own, plus everything anyone has shared.
 *
 * Own first, because a list of playlists is overwhelmingly a list of your own and burying
 * them alphabetically among other people's makes the common case the slow one. Then pinned,
 * then the order they arranged — the same ordering a saved filter gets, because both end up
 * in the same sidebar and an arrangement that applied to only one of them would be arbitrary.
 *
 * Someone else's pin and position describe their sidebar, not this one, so a shared playlist
 * from another account falls to the end and sorts by name.
 */
export const listVisibleTo = (userId: string): PlaylistSummaryRow[] =>
    db
        .prepare(
            `${SUMMARY_SELECTION}
              WHERE p."ownerId" = :userId OR p."visibility" = 'shared'
              ORDER BY (p."ownerId" = :userId) DESC,
                       (p."ownerId" = :userId AND p."pinned" IS NOT NULL) DESC,
                       CASE WHEN p."ownerId" = :userId THEN p."position" ELSE 0 END ASC,
                       p."name" COLLATE NOCASE ASC`
        )
        .all({ userId }) as PlaylistSummaryRow[];

export const update = (id: string, input: UpdatePlaylistInput): void => {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) {
        sets.push(`"name" = ?`);
        params.push(input.name);
    }

    if (input.description !== undefined) {
        sets.push(`"description" = ?`);
        params.push(input.description);
    }

    if (input.visibility !== undefined) {
        sets.push(`"visibility" = ?`);
        params.push(input.visibility);
    }

    if (input.pinned !== undefined) {
        sets.push(`"pinned" = ?`);
        params.push(input.pinned ? 1 : null);
    }

    if (input.position !== undefined) {
        sets.push(`"position" = ?`);
        params.push(input.position);
    }

    // `null` is a value here, not an omission: it puts the list back to having no opinion
    // about which order it opens in.
    if (input.sortMode !== undefined) {
        sets.push(`"sortMode" = ?`);
        params.push(input.sortMode);
    }

    if (sets.length === 0) {
        return;
    }

    db.prepare(
        `UPDATE "Playlist" SET ${sets.join(", ")}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?`
    ).run(...params, id);
};

/**
 * Marks the playlist as changed.
 *
 * Membership is the playlist's content, so adding an item is an edit to it. Without this,
 * "recently updated" would only ever reflect renames.
 */
const touch = (playlistId: string): void => {
    db.prepare(`UPDATE "Playlist" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?`).run(
        playlistId
    );
};

/** Items cascade; nothing outside the playlist is touched. */
export const remove = (id: string): void => {
    db.prepare(`DELETE FROM "Playlist" WHERE "id" = ?`).run(id);
};

/** Media ids in playlist order. Paged, because a playlist has no bound on its length. */
export const listItemIds = (playlistId: string, limit: number, offset: number): string[] =>
    (
        db
            .prepare(
                `SELECT "mediaId" FROM "PlaylistItem"
                  WHERE "playlistId" = ?
                  ORDER BY "position" ASC
                  LIMIT ? OFFSET ?`
            )
            .all(playlistId, limit, offset) as { mediaId: string }[]
    ).map((row) => row.mediaId);

/**
 * One page of the playlist, shuffled (§14b).
 *
 * The same permutation the library's `random` sort uses, over a different key. `shuffle.ts`
 * never knew it was shuffling a library — it turns a seed into an addressable permutation of
 * a dense integer key, so that any page is arithmetic rather than a sort and no item can land
 * on two pages. The library feeds it `Media.rowid`; a playlist has `position`, which is the
 * same kind of key and is already indexed.
 *
 * The fit is better here than there. The library permutes the whole table and filters
 * afterwards, so a narrow filter spends most of its slots on rows the filter rejects. A
 * playlist's positions *are* its membership, so every slot that exists hits — and because
 * `removeItem` closes the gaps it leaves, the only slots that miss are the few between the
 * last position and the prime above it.
 *
 * Slots are 1-based because that is what `shufflePageSlots` guarantees to visit, and
 * positions are 0-based, so the two are offset by one. Without that, slot 0 would be
 * discarded as out of range and the first item of every playlist would be unreachable.
 */
export const listItemIdsShuffled = (
    playlistId: string,
    page: number,
    pageSize: number,
    seed: number
): { ids: string[]; hasMore: boolean } => {
    const highest = (
        db
            .prepare(
                `SELECT COALESCE(MAX("position"), -1) AS n FROM "PlaylistItem"
                  WHERE "playlistId" = ?`
            )
            .get(playlistId) as { n: number }
    ).n;

    if (highest < 0) {
        return { ids: [], hasMore: false };
    }

    const slotCount = highest + 1;
    const permutation = shuffleParams(seed, slotCount);
    const slots = shufflePageSlots(page, pageSize, slotCount, permutation);
    // A page can be short without the shuffle being over, so the end of the permutation is
    // the only reliable end marker -- the same rule the library's shuffle follows.
    const hasMore = !shuffleExhausted(page + 1, pageSize, permutation);

    if (slots.length === 0) {
        return { ids: [], hasMore };
    }

    const positions = slots.map((slot) => slot - 1);

    const found = new Map(
        (
            db
                .prepare(
                    `SELECT "mediaId", "position" FROM "PlaylistItem"
                      WHERE "playlistId" = :playlistId
                        AND "position" IN (SELECT value FROM json_each(:positions))`
                )
                .all({ playlistId, positions: JSON.stringify(positions) }) as {
                mediaId: string;
                position: number;
            }[]
        ).map((row) => [row.position, row.mediaId])
    );

    return {
        // Walked in slot order rather than in whatever order SQLite returned, or the
        // "shuffle" would be playlist order within each page.
        ids: positions
            .map((position) => found.get(position))
            .filter((id): id is string => id !== undefined),
        hasMore,
    };
};

export const countItems = (playlistId: string): number =>
    (
        db
            .prepare(`SELECT COUNT(*) AS n FROM "PlaylistItem" WHERE "playlistId" = ?`)
            .get(playlistId) as { n: number }
    ).n;

/**
 * A handful of item ids spread across the whole playlist (§14b).
 *
 * For the cover mosaic on a playlist card. Spread rather than the first few, so the picture
 * is of the playlist and not of its opening — a long list assembled from one filter would
 * otherwise show four near-identical stills. Spread rather than random, because a card whose
 * face changes on every visit is a card nobody can learn to recognise, and the arithmetic is
 * the same either way.
 *
 * Positions are dense (`removeItem` closes its gaps), so evenly spaced indices land on rows
 * that exist. Ascending, and the caller may get back fewer than it asked for once the
 * viewer's own access has been applied to them.
 */
export const sampleItemIds = (playlistId: string, count: number): string[] => {
    const total = countItems(playlistId);
    const wanted = Math.min(count, total);

    if (wanted <= 0) {
        return [];
    }

    const positions = Array.from({ length: wanted }, (_, index) =>
        Math.floor((index * total) / wanted)
    );

    return (
        db
            .prepare(
                `SELECT "mediaId" FROM "PlaylistItem"
                  WHERE "playlistId" = :playlistId
                    AND "position" IN (SELECT value FROM json_each(:positions))
                  ORDER BY "position" ASC`
            )
            .all({ playlistId, positions: JSON.stringify(positions) }) as { mediaId: string }[]
    ).map((row) => row.mediaId);
};

/**
 * Appends items, ignoring ones already present.
 *
 * `DO NOTHING` rather than an error: adding a hundred items from a filter where three are
 * already in the playlist is a normal thing to do, and failing the whole batch over it would
 * make the feature useless. The return value is what actually went in, so the caller can say
 * "added 97 of 100" instead of claiming all of them.
 */
export const addItems = (playlistId: string, mediaIds: string[]): number => {
    if (mediaIds.length === 0) {
        return 0;
    }

    return db.transaction((): number => {
        const next = db
            .prepare(
                `SELECT COALESCE(MAX("position"), -1) + 1 AS n FROM "PlaylistItem"
                  WHERE "playlistId" = ?`
            )
            .get(playlistId) as { n: number };

        const insert = db.prepare(
            `INSERT INTO "PlaylistItem" ("id", "playlistId", "mediaId", "position")
             VALUES (?, ?, ?, ?)
             ON CONFLICT("playlistId", "mediaId") DO NOTHING`
        );

        let position = next.n;
        let added = 0;

        for (const mediaId of mediaIds) {
            if (insert.run(randomUUID(), playlistId, mediaId, position).changes > 0) {
                position += 1;
                added += 1;
            }
        }

        touch(playlistId);

        return added;
    })();
};

/**
 * Removes one item and closes the gap behind it.
 *
 * The gap used to be left alone, on the grounds that only the order of positions is ever
 * read. Shuffle made the numbers themselves observable: a shuffled playlist is a permutation
 * of the position space rather than a sort of it (§14b), so a hole is a slot that resolves to
 * nothing, and enough of them make "7 of 40" a number that can exceed forty.
 *
 * Only the positions after the removed one move, which is one indexed statement rather than
 * the renumbering `moveItem` does. Density is preserved rather than restored — `addItems`
 * appends at the end and `moveItem` renumbers completely, so this was the only thing that
 * could put a hole in a playlist that did not already have one.
 */
export const removeItem = (playlistId: string, mediaId: string): boolean =>
    db.transaction((): boolean => {
        const row = db
            .prepare(
                `SELECT "position" FROM "PlaylistItem"
                  WHERE "playlistId" = ? AND "mediaId" = ?`
            )
            .get(playlistId, mediaId) as { position: number } | undefined;

        if (row === undefined) {
            return false;
        }

        db.prepare(`DELETE FROM "PlaylistItem" WHERE "playlistId" = ? AND "mediaId" = ?`).run(
            playlistId,
            mediaId
        );

        db.prepare(
            `UPDATE "PlaylistItem" SET "position" = "position" - 1
              WHERE "playlistId" = ? AND "position" > ?`
        ).run(playlistId, row.position);

        touch(playlistId);

        return true;
    })();

/**
 * Moves one item to a given index, renumbering what it passes.
 *
 * A single item and a destination rather than the whole sequence: that is what a drag is,
 * and it means a client cannot silently drop members of a long playlist by sending a stale
 * list back.
 *
 * Renumbering the whole playlist afterwards is O(n) in one transaction. That was obviously
 * fine while playlists were assembled by hand; freezing a filter into one raised the ceiling
 * to `BULK_SELECTION_LIMIT`, so the worst case is now ten thousand updates for a single drag.
 * Still a few tens of milliseconds, and still worth the simplicity — but it is a bound that
 * exists now rather than an assumption that nobody would ever build a large playlist.
 */
export const moveItem = (playlistId: string, mediaId: string, toIndex: number): boolean =>
    db.transaction((): boolean => {
        const ids = listItemIds(playlistId, Number.MAX_SAFE_INTEGER, 0);
        const from = ids.indexOf(mediaId);

        if (from < 0) {
            return false;
        }

        ids.splice(from, 1);
        ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, mediaId);

        const setPosition = db.prepare(
            `UPDATE "PlaylistItem" SET "position" = ? WHERE "playlistId" = ? AND "mediaId" = ?`
        );

        ids.forEach((id, index) => setPosition.run(index, playlistId, id));

        touch(playlistId);

        return true;
    })();

/**
 * Puts another item in this one's place, in every playlist that holds it (§10c).
 *
 * A move rather than a copy -- the only one in the merge, and the position is why. A playlist
 * is an order somebody arranged, so the surviving copy has to take the departing one's slot
 * rather than be appended at the end of a list it was already partway through. Copying would
 * also leave both copies in the playlist for the length of the retention window, so anyone
 * playing it through would watch the same thing twice.
 *
 * `UPDATE OR IGNORE` for the playlists that already hold the survivor: those rows are left
 * where they are, pointing at the item on its way out, and the unique index is what says the
 * survivor is already in the right place. They disappear with the item at purge.
 */
export const repointItems = (fromMediaId: string, toMediaId: string): number => {
    if (fromMediaId === toMediaId) {
        return 0;
    }

    return db.transaction((): number => {
        const playlists = (
            db
                .prepare(`SELECT DISTINCT "playlistId" FROM "PlaylistItem" WHERE "mediaId" = ?`)
                .all(fromMediaId) as { playlistId: string }[]
        ).map((row) => row.playlistId);

        const moved = db
            .prepare(`UPDATE OR IGNORE "PlaylistItem" SET "mediaId" = ? WHERE "mediaId" = ?`)
            .run(toMediaId, fromMediaId).changes;

        for (const playlistId of playlists) {
            touch(playlistId);
        }

        return moved;
    })();
};
