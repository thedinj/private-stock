import { randomUUID } from "node:crypto";

import { db } from "../db.js";
import * as reelRepo from "./reelRepo.js";

/**
 * Libraries (§12b).
 *
 * A library is a directory plus the settings an administrator chose for it. It exists because
 * someone added it, and it is identified by its path — so moving content is a repoint, and
 * every file, tag, rating and duplicate group attached to the library survives the move.
 *
 * A row outlives its directory on purpose. An unreachable path is a misconfiguration or an
 * offline share, and neither is a reason to discard what an admin set up; the scanner already
 * refuses to reconcile a library it cannot reach, for the same reason.
 */

export interface MediaRootRow {
    id: string;
    /** Absolute, and validated before it is stored. */
    path: string;
    label: string;
    enabled: 1 | null;
    writable: 1 | null;
    lastScanAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export const listRoots = (): MediaRootRow[] =>
    db.prepare(`SELECT * FROM "MediaRoot" ORDER BY "label" COLLATE NOCASE`).all() as MediaRootRow[];

export const listEnabledRoots = (): MediaRootRow[] =>
    db
        .prepare(`SELECT * FROM "MediaRoot" WHERE "enabled" = 1 ORDER BY "label" COLLATE NOCASE`)
        .all() as MediaRootRow[];

export const findById = (id: string): MediaRootRow | undefined =>
    db.prepare(`SELECT * FROM "MediaRoot" WHERE "id" = ?`).get(id) as MediaRootRow | undefined;

export const findByPath = (path: string): MediaRootRow | undefined =>
    db.prepare(`SELECT * FROM "MediaRoot" WHERE "path" = ?`).get(path) as MediaRootRow | undefined;

/**
 * Adds a library.
 *
 * **Disabled to begin with.** Indexing a multi-terabyte share the moment its path is typed,
 * before anyone has said they want it indexed, is not a decision to make on someone's behalf
 * — and a mistyped path should cost nothing.
 */
export const create = (path: string, label: string): MediaRootRow => {
    const id = randomUUID();

    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "updatedAt")
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(id, path, label);

    return findById(id)!;
};

/**
 * Points a library at a different directory.
 *
 * The whole reason the path is a column rather than an identity derived from the filesystem.
 * Stored paths of individual files are relative to the library, so a move that keeps the
 * internal structure needs nothing else: the catalogue is intact the moment this returns.
 */
export const setPath = (id: string, path: string): void => {
    db.prepare(
        `UPDATE "MediaRoot" SET "path" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?`
    ).run(path, id);
};

/**
 * Forgets a library and everything catalogued from it.
 *
 * Destructive, and deliberately the only way a library row disappears — nothing removes one
 * because its directory went missing. Content on the media root is untouched; this discards
 * what the app remembered about it.
 *
 * **The second statement is the one that matters.** Deleting the row cascades to `MediaFile`
 * and its links and stops there, because `Media` hangs off the *file* rather than the
 * library — there is no `rootId` to cascade from. Without the follow-up, every item survived
 * as an orphan, invisible because the `listable` trigger had just cleared it, and carrying its
 * tags, ratings, artifact rows, processing history and search document with it forever.
 *
 * An item is removed only when no `original` link remains, so one catalogued from two
 * libraries survives the loss of one of them.
 *
 * Removing an item takes its clips with it, and those may sit in the middle of somebody's reel
 * (§14d) — rows leaving through a cascade rather than through `reelRepo.removeItem`, which is
 * what keeps positions dense. There is no one media id to collect here, since the second
 * statement deletes every orphan at once, so the repair is the general one and runs after.
 */
export const remove = (id: string): void => {
    db.transaction(() => {
        db.prepare(`DELETE FROM "MediaRoot" WHERE "id" = ?`).run(id);

        db.prepare(
            `DELETE FROM "Media"
              WHERE NOT EXISTS (
                  SELECT 1 FROM "MediaFileLink" fl
                   WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original'
              )`
        ).run();

        reelRepo.renumberGapped();
    })();
};

export const setEnabled = (id: string, enabled: boolean): void => {
    db.prepare(
        `UPDATE "MediaRoot" SET "enabled" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?`
    ).run(enabled ? 1 : null, id);
};

export const setWritable = (id: string, writable: boolean): void => {
    db.prepare(
        `UPDATE "MediaRoot" SET "writable" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?`
    ).run(writable ? 1 : null, id);
};

export const setLabel = (id: string, label: string): void => {
    db.prepare(
        `UPDATE "MediaRoot" SET "label" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?`
    ).run(label, id);
};

/**
 * Marks every file in a library as unverified, hiding its items until a scan confirms them.
 *
 * Repointing a library says nothing about whether the files are at the new path — that is
 * what the scan is for. Until it runs, the honest position is that we do not know, and an
 * item shown from a path nobody has looked at can be played, deleted or transcoded against
 * whatever happens to be sitting there.
 *
 * `'trashed'` is untouched: those files are in `/data/trash`, not in the library, and their
 * state is a user decision rather than an observation. `'archived'` is left alone too —
 * already hidden, and giving it three more scans to re-archive would achieve nothing.
 */
export const markUnverified = (rootId: string): number =>
    db
        .prepare(
            `UPDATE "MediaFile"
                SET "state" = 'unverified', "missingScans" = 0,
                    "updatedAt" = CURRENT_TIMESTAMP
              WHERE "rootId" = ? AND "state" IN ('active', 'missing')`
        )
        .run(rootId).changes;

export const markScanned = (id: string): void => {
    db.prepare(
        `UPDATE "MediaRoot" SET "lastScanAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ?`
    ).run(id);
};

/**
 * Root ids a user may see.
 *
 * `LibraryAccess` is opt-out: a user with no rows sees every enabled root. Requiring an
 * explicit grant per root would mean a freshly created account sees an empty library and
 * looks broken.
 */
export const accessibleRootIds = (userId: string): string[] => {
    const denied = db
        .prepare(`SELECT "rootId" FROM "LibraryAccess" WHERE "userId" = ? AND "allowed" IS NULL`)
        .all(userId) as { rootId: string }[];

    const deniedSet = new Set(denied.map((row) => row.rootId));

    return listEnabledRoots()
        .map((root) => root.id)
        .filter((id) => !deniedSet.has(id));
};
