import { randomUUID } from "node:crypto";

import type { DupeKind, KeepCandidate, MediaKind, MediaKindCounts } from "@private-stock/core";

import { db } from "../db.js";

/**
 * Materialized duplicate clusters (§10).
 *
 * Groups are stored rather than recomputed per request, because clustering is a pass over
 * the whole library and a review page must open immediately. The trade is that groups go
 * stale, which is why `reviewed` exists and why re-running is cheap and idempotent.
 */

export type { DupeKind };

export interface DupeGroupRow {
    id: string;
    kind: DupeKind;
    reviewed: number | null;
    createdAt: string;
}

export interface DupeMemberRow {
    mediaId: string;
    distance: number | null;
}

/**
 * A stable identity for a set of members.
 *
 * Groups have no natural key, so a re-run would otherwise create a second group for the same
 * files every time it ran, and the review queue would fill with duplicates of duplicates.
 * The sorted member list is that key, and it also means a group someone has already reviewed
 * stays reviewed as long as its membership has not changed — while a group that *gained* a
 * member is correctly treated as new and worth looking at again.
 */
const groupKey = (kind: DupeKind, members: string[]): string =>
    `${kind}:${[...members].sort().join(",")}`;

/**
 * The key of a group already in the database.
 *
 * Sorted in TypeScript rather than with `group_concat`, whose concatenation order SQLite
 * explicitly does not guarantee -- an ORDER BY in a subquery does not survive into the
 * aggregate. A key that silently depended on row order would compare unequal to itself and
 * every run would create fresh groups.
 */
const keyOf = (groupId: string): string | undefined => {
    const group = db.prepare(`SELECT "kind" FROM "DupeGroup" WHERE "id" = ?`).get(groupId) as
        { kind: DupeKind } | undefined;

    if (!group) {
        return undefined;
    }

    const members = (
        db.prepare(`SELECT "mediaId" FROM "DupeMember" WHERE "groupId" = ?`).all(groupId) as {
            mediaId: string;
        }[]
    ).map((row) => row.mediaId);

    return groupKey(group.kind, members);
};

export interface UpsertGroupInput {
    kind: DupeKind;
    members: { mediaId: string; distance: number | null }[];
}

/**
 * Creates a group, or leaves an identical existing one alone.
 *
 * Returns the group id either way. "Identical" means the same kind and exactly the same
 * members, so re-running the clustering pass over an unchanged library is a no-op and does
 * not reset anyone's review progress.
 */
export const upsertGroup = (input: UpsertGroupInput): string =>
    db.transaction((): string => {
        /**
         * One entry per item, whatever the caller passed.
         *
         * `UNIQUE (groupId, mediaId)` would otherwise turn a repeated member into a thrown
         * constraint that fails the whole clustering job -- and a group listing the same file
         * twice is precisely the thing the review screen must never show, so it is worth
         * being unable to express rather than merely unlikely (§10b).
         */
        const byMedia = new Map<string, { mediaId: string; distance: number | null }>();

        for (const member of input.members) {
            byMedia.set(member.mediaId, member);
        }

        const members = [...byMedia.values()].sort((a, b) => a.mediaId.localeCompare(b.mediaId));

        // Two distinct items or it is not a duplicate of anything.
        if (members.length < 2) {
            return "";
        }

        const wanted = groupKey(
            input.kind,
            members.map((member) => member.mediaId)
        );

        const existing = db
            .prepare(
                `SELECT DISTINCT g."id" FROM "DupeGroup" g
                   JOIN "DupeMember" m ON m."groupId" = g."id"
                  WHERE g."kind" = ? AND m."mediaId" = ?`
            )
            .all(input.kind, members[0]?.mediaId ?? "") as { id: string }[];

        for (const candidate of existing) {
            if (keyOf(candidate.id) === wanted) {
                return candidate.id;
            }
        }

        const groupId = randomUUID();

        db.prepare(
            `INSERT INTO "DupeGroup" ("id", "kind", "updatedAt")
             VALUES (?, ?, CURRENT_TIMESTAMP)`
        ).run(groupId, input.kind);

        const insert = db.prepare(
            `INSERT INTO "DupeMember" ("id", "groupId", "mediaId", "distance")
             VALUES (?, ?, ?, ?)`
        );

        for (const member of members) {
            insert.run(randomUUID(), groupId, member.mediaId, member.distance);
        }

        return groupId;
    })();

/**
 * Removes groups that are no longer duplicates.
 *
 * A group whose members have shrunk below two is not a duplicate any more — the usual cause
 * being that someone deleted the extra copies, which is the feature working. Leaving it
 * behind would show a "duplicate" group containing one file.
 */
export const pruneDegenerate = (): number =>
    db
        .prepare(
            `DELETE FROM "DupeGroup" WHERE "id" IN (
                 SELECT g."id" FROM "DupeGroup" g
                   LEFT JOIN "DupeMember" m ON m."groupId" = g."id"
                  GROUP BY g."id"
                 HAVING count(m."id") < 2
             )`
        )
        .run().changes;

export const markReviewed = (groupId: string, reviewed: boolean): void => {
    db.prepare(
        `UPDATE "DupeGroup" SET "reviewed" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?`
    ).run(reviewed ? 1 : null, groupId);
};

/**
 * The same, for a page of groups at once, and in one transaction.
 *
 * Returns how many rows changed. Ids that no longer exist are simply not counted: a group that
 * was pruned between the page loading and the press was resolved by somebody, which is what
 * marking it reviewed wanted anyway.
 */
export const markReviewedMany = (groupIds: string[], reviewed: boolean): number => {
    const update = db.prepare(
        `UPDATE "DupeGroup" SET "reviewed" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?`
    );

    return db.transaction((): number =>
        groupIds.reduce((changed, id) => changed + update.run(reviewed ? 1 : null, id).changes, 0)
    )();
};

export interface DupeGroupSummary {
    id: string;
    kind: DupeKind;
    reviewed: boolean;
    memberCount: number;
    createdAt: string;
}

export interface DupeGroupFilter {
    /** Only groups somebody decided to keep as they are; otherwise only those still waiting. */
    reviewed?: boolean;
    /** Only this kind; both when absent. */
    kind?: DupeKind;
    /** Only groups of videos, or of photos; both when absent. A group never mixes them. */
    media?: MediaKind;
}

/**
 * The members of a group that still have a file, and only groups with two or more of them.
 *
 * A group whose other copies have been deleted is not a duplicate any more, and the service
 * already refuses to show one (`toGroup`). Counting it anyway put "Reviewed · 1" on a tab that
 * then showed nothing, and it made pages short: the page was cut before the empty groups were
 * dropped. So the rule is applied here, once, for the list and every count alike -- they cannot
 * disagree about what a group is. Pruned by the worker too; this covers the time in between.
 */
const LIVE_MEMBERS = `JOIN "DupeMember" m ON m."groupId" = g."id"
                   JOIN "Media" mk ON mk."id" = m."mediaId"
                   JOIN "MediaFileLink" fl ON fl."mediaId" = m."mediaId" AND fl."role" = 'original'
                   JOIN "MediaFile" f ON f."id" = fl."fileId" AND f."state" = 'active'`;

/**
 * Groups awaiting review, worst first.
 *
 * Exact duplicates lead because they are the easy wins — byte-identical files where the
 * decision needs no judgement — and clearing them first shortens the queue fastest.
 */
export const listGroups = (
    options: DupeGroupFilter & { limit?: number; offset?: number }
): DupeGroupSummary[] =>
    (
        db
            .prepare(
                `SELECT g."id", g."kind", g."reviewed", g."createdAt",
                        count(DISTINCT m."mediaId") AS "memberCount"
                   FROM "DupeGroup" g
                   ${LIVE_MEMBERS}
                  WHERE (CASE WHEN ? = 1 THEN g."reviewed" = 1 ELSE g."reviewed" IS NULL END)
                    AND (? IS NULL OR g."kind" = ?)
                    AND (? IS NULL OR mk."kind" = ?)
                  GROUP BY g."id"
                 HAVING count(DISTINCT m."mediaId") >= 2
                  ORDER BY CASE g."kind" WHEN 'exact' THEN 0 ELSE 1 END,
                           "memberCount" DESC, g."createdAt"
                  LIMIT ? OFFSET ?`
            )
            .all(
                options.reviewed ? 1 : 0,
                options.kind ?? null,
                options.kind ?? null,
                options.media ?? null,
                options.media ?? null,
                options.limit ?? 50,
                options.offset ?? 0
            ) as (Omit<DupeGroupSummary, "reviewed"> & { reviewed: number | null })[]
    ).map((row) => ({ ...row, reviewed: row.reviewed === 1 }));

export const countGroups = (filter: DupeGroupFilter): number =>
    (
        db
            .prepare(
                `SELECT count(*) AS n FROM (
                     SELECT g."id" FROM "DupeGroup" g
                       ${LIVE_MEMBERS}
                      WHERE (CASE WHEN ? = 1 THEN g."reviewed" = 1 ELSE g."reviewed" IS NULL END)
                        AND (? IS NULL OR g."kind" = ?)
                        AND (? IS NULL OR mk."kind" = ?)
                      GROUP BY g."id"
                     HAVING count(DISTINCT m."mediaId") >= 2
                 )`
            )
            .get(
                filter.reviewed ? 1 : 0,
                filter.kind ?? null,
                filter.kind ?? null,
                filter.media ?? null,
                filter.media ?? null
            ) as {
            n: number;
        }
    ).n;

/**
 * Unreviewed groups by kind and by what they are groups of, in one pass rather than one count
 * per pair. `max` picks the media kind a group's members share; they never differ.
 */
export const countPending = (): Record<DupeKind, MediaKindCounts> => {
    const rows = db
        .prepare(
            `SELECT "kind", "media", count(*) AS n FROM (
                 SELECT g."id", g."kind", max(mk."kind") AS "media" FROM "DupeGroup" g
                   ${LIVE_MEMBERS}
                  WHERE g."reviewed" IS NULL
                  GROUP BY g."id"
                 HAVING count(DISTINCT m."mediaId") >= 2
             )
             GROUP BY "kind", "media"`
        )
        .all() as { kind: DupeKind; media: MediaKind; n: number }[];

    const counts: Record<DupeKind, MediaKindCounts> = {
        exact: { video: 0, image: 0 },
        near: { video: 0, image: 0 },
    };

    for (const row of rows) {
        counts[row.kind][row.media] = row.n;
    }

    return counts;
};

export const listMembers = (groupId: string): DupeMemberRow[] =>
    db
        .prepare(`SELECT "mediaId", "distance" FROM "DupeMember" WHERE "groupId" = ?`)
        .all(groupId) as DupeMemberRow[];

export const findGroup = (groupId: string): DupeGroupRow | undefined =>
    db
        .prepare(`SELECT "id", "kind", "reviewed", "createdAt" FROM "DupeGroup" WHERE "id" = ?`)
        .get(groupId) as DupeGroupRow | undefined;

/**
 * Exact duplicates, straight from `contentHash` (§5, §10).
 *
 * No perceptual hashing involved: these are byte-identical files, which the scanner already
 * knows about. Grouped separately because the review decision is different — with an exact
 * duplicate there is nothing to compare, only a choice of which path to keep.
 */
export const exactDuplicateSets = (limit = 200): string[][] => {
    const rows = db
        .prepare(
            `SELECT f."contentHash", m."id" AS "mediaId"
               FROM "MediaFile" f
               JOIN "MediaFileLink" fl ON fl."fileId" = f."id" AND fl."role" = 'original'
               JOIN "Media" m ON m."id" = fl."mediaId"
              WHERE f."contentHash" IS NOT NULL AND f."state" = 'active'
                AND f."contentHash" IN (
                    SELECT "contentHash" FROM "MediaFile"
                     WHERE "contentHash" IS NOT NULL AND "state" = 'active'
                     GROUP BY "contentHash" HAVING count(DISTINCT "id") > 1
                )
              ORDER BY f."contentHash"
              LIMIT ?`
        )
        .all(limit * 4) as { contentHash: string; mediaId: string }[];

    const byHash = new Map<string, string[]>();

    for (const row of rows) {
        const set = byHash.get(row.contentHash) ?? [];

        // One Media may be linked from several identical files; a group needs distinct items.
        if (!set.includes(row.mediaId)) {
            set.push(row.mediaId);
        }

        byHash.set(row.contentHash, set);
    }

    return [...byHash.values()].filter((set) => set.length > 1).slice(0, limit);
};

/**
 * Queues a fresh clustering pass.
 *
 * Idempotent through the job queue's uniqueness index, so an impatient admin clicking twice
 * gets one pass rather than two competing ones writing overlapping groups.
 */
export const enqueueRescan = (): void => {
    db.prepare(
        `INSERT INTO "Job" ("id", "kind", "priority", "updatedAt")
         VALUES (?, 'dupes', 200, CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING`
    ).run(randomUUID());
};

/**
 * Items waiting to be compared against the library (§10b).
 *
 * The seeds of an incremental pass. An item qualifies once it has something to compare --
 * a perceptual hash, or a content hash for the exact-duplicate half -- and stops qualifying
 * as soon as it has been compared, because comparison is symmetric and the pairs it would
 * find a second time are the ones it found the first.
 *
 * Newest first, for the same reason everything else is (§7d): if the library is producing
 * hashes faster than this can consume them, the items somebody is looking at should be the
 * ones with duplicate groups.
 *
 * **The unclustered items are found first, from two indexes, before any row is read** (§20).
 * Once a library has been clustered nearly every item is marked, and the plain join walked
 * every active file, its link and its `Media` row to discover that — 3,683 pages, 11 s on the
 * NAS, for 0 seeds, every time a hash finished. The anti-join of `Media`'s id index against
 * `DupeClustered`'s is ~310 pages, and only the handful that survive are joined. `MATERIALIZED`
 * is what keeps the planner from flattening it back into the walk. The conditions themselves are
 * unchanged, so the answer is too.
 */
export const seedsNeedingClustering = (limit = 500): string[] =>
    (
        db
            .prepare(
                `WITH "unclustered" AS MATERIALIZED (
                     SELECT e."id" FROM "Media" e
                      WHERE NOT EXISTS (
                          SELECT 1 FROM "DupeClustered" d WHERE d."mediaId" = e."id"))
                 SELECT m."id"
                   FROM "unclustered" u
                  CROSS JOIN "Media" m ON m."id" = u."id"
                   JOIN "MediaFileLink" fl ON fl."mediaId" = m."id" AND fl."role" = 'original'
                   JOIN "MediaFile" f ON f."id" = fl."fileId"
                   LEFT JOIN "DupeClustered" c ON c."mediaId" = m."id"
                  WHERE f."state" = 'active'
                    AND c."mediaId" IS NULL
                    AND (f."contentHash" IS NOT NULL
                         OR EXISTS (SELECT 1 FROM "PhashImage" p WHERE p."mediaId" = m."id")
                         OR EXISTS (SELECT 1 FROM "PhashVideo" v WHERE v."mediaId" = m."id"))
                  ORDER BY m."addedAt" DESC
                  LIMIT ?`
            )
            .all(limit) as { id: string }[]
    ).map((row) => row.id);

/** Records that these items have been compared, so no later pass repeats the work. */
export const markClustered = (mediaIds: string[]): void => {
    const insert = db.prepare(
        `INSERT INTO "DupeClustered" ("mediaId") VALUES (?) ON CONFLICT DO NOTHING`
    );

    db.transaction(() => {
        for (const mediaId of mediaIds) {
            insert.run(mediaId);
        }
    })();
};

/**
 * Forgets every comparison, so the next pass reconsiders the whole library.
 *
 * The escape hatch for a settings change. Thresholds decide which pairs count, so lowering
 * `imageDistance` after a library has been clustered would otherwise apply only to items
 * hashed from then on -- the setting would look broken for everything already there, which is
 * most of the library.
 *
 * Existing groups are deliberately left alone: `upsertGroup` returns the identical group
 * rather than replacing it, so anything that still clusters the same way keeps its id and its
 * review state through the re-pass.
 */
export const clearClustered = (): number => db.prepare(`DELETE FROM "DupeClustered"`).run().changes;

/**
 * Groups that any of these items already belong to.
 *
 * What makes an incremental pass safe rather than merely cheap. Clustering is transitive
 * (§10), so a new item linking two items that were in separate groups has to merge those
 * groups -- and a pass that only looked at its own new pairs would instead write a third
 * group overlapping both.
 */
export const groupsContaining = (mediaIds: string[]): { id: string; kind: DupeKind }[] => {
    if (mediaIds.length === 0) {
        return [];
    }

    const placeholders = mediaIds.map(() => "?").join(", ");

    return db
        .prepare(
            `SELECT DISTINCT g."id", g."kind"
               FROM "DupeGroup" g
               JOIN "DupeMember" m ON m."groupId" = g."id"
              WHERE m."mediaId" IN (${placeholders})`
        )
        .all(...mediaIds) as { id: string; kind: DupeKind }[];
};

/** Members of several groups at once, for the merge step. */
export const membersOf = (groupIds: string[]): { groupId: string; mediaId: string }[] => {
    if (groupIds.length === 0) {
        return [];
    }

    const placeholders = groupIds.map(() => "?").join(", ");

    return db
        .prepare(
            `SELECT "groupId", "mediaId" FROM "DupeMember" WHERE "groupId" IN (${placeholders})`
        )
        .all(...groupIds) as { groupId: string; mediaId: string }[];
};

/** Removes groups that have been absorbed into a larger one. */
export const deleteGroups = (groupIds: string[]): number => {
    if (groupIds.length === 0) {
        return 0;
    }

    const placeholders = groupIds.map(() => "?").join(", ");

    return db.prepare(`DELETE FROM "DupeGroup" WHERE "id" IN (${placeholders})`).run(...groupIds)
        .changes;
};

/**
 * Exact-duplicate sets that these items belong to.
 *
 * The incremental counterpart of `exactDuplicateSets`, which scans the whole file table. Each
 * seed's `contentHash` is looked up through `idx_MediaFile_contentHash`, so this costs a
 * handful of index probes per seed rather than a pass over the library.
 */
export const exactDuplicateSetsFor = (mediaIds: string[]): string[][] => {
    if (mediaIds.length === 0) {
        return [];
    }

    const placeholders = mediaIds.map(() => "?").join(", ");

    const rows = db
        .prepare(
            `SELECT f."contentHash", m."id" AS "mediaId"
               FROM "MediaFile" f
               JOIN "MediaFileLink" fl ON fl."fileId" = f."id" AND fl."role" = 'original'
               JOIN "Media" m ON m."id" = fl."mediaId"
              WHERE f."state" = 'active'
                AND f."contentHash" IN (
                    SELECT f2."contentHash"
                      FROM "MediaFile" f2
                      JOIN "MediaFileLink" fl2 ON fl2."fileId" = f2."id" AND fl2."role" = 'original'
                     WHERE fl2."mediaId" IN (${placeholders})
                       AND f2."contentHash" IS NOT NULL AND f2."state" = 'active'
                )`
        )
        .all(...mediaIds) as { contentHash: string; mediaId: string }[];

    const byHash = new Map<string, string[]>();

    for (const row of rows) {
        const set = byHash.get(row.contentHash) ?? [];

        if (!set.includes(row.mediaId)) {
            set.push(row.mediaId);
        }

        byHash.set(row.contentHash, set);
    }

    // Only a set with more than one item is a duplicate at all.
    return [...byHash.values()].filter((set) => set.length > 1);
};

/**
 * Removes groups that another group already contains (§10b).
 *
 * The standing guard against the review queue filling with the same files over and over, and
 * the reason it exists is not hypothetical. Clustering identifies a group by its member set,
 * so a cluster that gains a member is correctly a *different* group -- but nothing deleted
 * the smaller one it grew out of. Over one import that left a single item in ten overlapping
 * near-duplicate groups of two, three, four, five, six, seven, eight and nine members, each
 * created as the last one grew, and a reviewer scrolling the page met the same file ten
 * times.
 *
 * The merge step deletes the groups it absorbs, so in ordinary running this finds nothing. It
 * is kept as a sweep anyway: it is cheap, it is the only thing that would catch the same
 * accumulation arriving by a route nobody predicted, and the failure it prevents is silent.
 *
 * Equal sets are broken by id so the choice is deterministic rather than whichever row the
 * planner reached first.
 */
export const pruneSubsumed = (): number =>
    db
        .prepare(
            `DELETE FROM "DupeGroup" WHERE "id" IN (
                 SELECT g1."id" FROM "DupeGroup" g1
                  WHERE EXISTS (
                      SELECT 1 FROM "DupeGroup" g2
                       WHERE g2."id" <> g1."id"
                         AND g2."kind" = g1."kind"
                         AND (
                             (SELECT count(*) FROM "DupeMember" m WHERE m."groupId" = g2."id")
                                 > (SELECT count(*) FROM "DupeMember" m WHERE m."groupId" = g1."id")
                             OR (
                                 (SELECT count(*) FROM "DupeMember" m WHERE m."groupId" = g2."id")
                                     = (SELECT count(*) FROM "DupeMember" m WHERE m."groupId" = g1."id")
                                 AND g2."id" < g1."id"
                             )
                         )
                         AND NOT EXISTS (
                             SELECT 1 FROM "DupeMember" m1
                              WHERE m1."groupId" = g1."id"
                                AND m1."mediaId" NOT IN (
                                    SELECT m2."mediaId" FROM "DupeMember" m2
                                     WHERE m2."groupId" = g2."id"
                                )
                         )
                  )
             )`
        )
        .run().changes;

/**
 * Merges same-kind groups that share a member (§10b).
 *
 * The invariant union-find is supposed to guarantee, enforced against the table rather than
 * assumed from the code that writes it: **within a kind, groups are disjoint.** If two groups
 * share an item then that item links them, so they were always one group.
 *
 * `pruneSubsumed` does not catch this and should not -- neither group contains the other.
 * The live library held two nine-member groups sharing eight members and differing by one,
 * which is one group of ten written twice as it grew, and a reviewer meets those files twice.
 *
 * The survivor is the lower id, so the choice is deterministic; it loses `reviewed` when it
 * actually gains members, because a group somebody approved is not the group they looked at
 * once it has grown.
 *
 * Iterative rather than recursive closure in SQL: each merge can create a new overlap, and a
 * bounded loop over a handful of them is clearer than a recursive CTE nobody will re-derive.
 * Bounded so a bug here cannot become an unbreakable loop inside a job.
 */
export const mergeOverlapping = (maxMerges = 1_000): number => {
    const findOverlap = db.prepare(
        `SELECT a."groupId" AS "keep", b."groupId" AS "absorb"
           FROM "DupeMember" a
           JOIN "DupeMember" b ON b."mediaId" = a."mediaId" AND b."groupId" <> a."groupId"
           JOIN "DupeGroup" ga ON ga."id" = a."groupId"
           JOIN "DupeGroup" gb ON gb."id" = b."groupId"
          WHERE ga."kind" = gb."kind" AND a."groupId" < b."groupId"
          LIMIT 1`
    );

    let merged = 0;

    while (merged < maxMerges) {
        const overlap = findOverlap.get() as { keep: string; absorb: string } | undefined;

        if (!overlap) {
            break;
        }

        db.transaction(() => {
            const moved = db
                .prepare(
                    `INSERT INTO "DupeMember" ("id", "groupId", "mediaId", "distance")
                     SELECT lower(hex(randomblob(16))), ?, b."mediaId", b."distance"
                       FROM "DupeMember" b
                      WHERE b."groupId" = ?
                        AND b."mediaId" NOT IN (
                            SELECT a."mediaId" FROM "DupeMember" a WHERE a."groupId" = ?
                        )`
                )
                .run(overlap.keep, overlap.absorb, overlap.keep).changes;

            db.prepare(`DELETE FROM "DupeGroup" WHERE "id" = ?`).run(overlap.absorb);

            if (moved > 0) {
                db.prepare(
                    `UPDATE "DupeGroup" SET "reviewed" = NULL, "updatedAt" = CURRENT_TIMESTAMP
                      WHERE "id" = ?`
                ).run(overlap.keep);
            }
        })();

        merged += 1;
    }

    return merged;
};

/**
 * Every copy of this item that still has a file, this one included (§10c).
 *
 * Everything `rankCopies` and `preferredKeep` need, so what a panel recommends and what a
 * merge bequeaths to are decided by the same ordering over the same rows -- rather than by
 * two queries that agree until one of them is edited.
 *
 * Across every group the item belongs to, not just one. Groups are kept disjoint (§10b), so
 * in practice there is one; reading them all means nothing is quietly skipped on the day that
 * invariant is broken.
 *
 * `state = 'active'` excludes anything already trashed, including the item itself when this
 * is called after its own state has flipped. A trashed copy is not a copy anybody can keep.
 */
export const activeCopies = (mediaId: string): KeepCandidate[] =>
    db
        .prepare(
            `SELECT DISTINCT m."id" AS "mediaId", m."width", m."height", m."bitrate",
                    f."size" AS "sizeBytes", m."durationMs", m."addedAt"
               FROM "DupeMember" mine
               JOIN "DupeMember" other ON other."groupId" = mine."groupId"
               JOIN "Media" m ON m."id" = other."mediaId"
               JOIN "MediaFileLink" fl ON fl."mediaId" = m."id" AND fl."role" = 'original'
               JOIN "MediaFile" f ON f."id" = fl."fileId"
              WHERE mine."mediaId" = ? AND f."state" = 'active'`
        )
        .all(mediaId) as KeepCandidate[];

/**
 * The same set, without the item itself -- the copies that could inherit from it (§10c).
 *
 * Derived rather than queried separately so a copy can never be a candidate heir in one place
 * and absent from the comparison in the other.
 */
export const activeSiblings = (mediaId: string): KeepCandidate[] =>
    activeCopies(mediaId).filter((copy) => copy.mediaId !== mediaId);

export interface IdenticalCopyRow {
    groupId: string;
    mediaId: string;
    width: number | null;
    height: number | null;
    bitrate: number | null;
    sizeBytes: number | null;
    durationMs: number | null;
    addedAt: string;
    writable: number | null;
    contentHash: string | null;
    clipCount: number;
}

/**
 * Every copy in every identical group still waiting for a decision, in one pass (§10e).
 *
 * What trashing every identical copy is planned from. One query over the whole queue rather
 * than one per group, because the plan has to count all of it -- the summary is the reason
 * nobody pages through the groups -- and only the columns the plan reads.
 */
export const pendingIdenticalCopies = (media?: MediaKind): IdenticalCopyRow[] =>
    db
        .prepare(
            `SELECT dm."groupId", m."id" AS "mediaId", m."width", m."height", m."bitrate",
                    f."size" AS "sizeBytes", m."durationMs", m."addedAt",
                    r."writable", f."contentHash",
                    (SELECT count(*) FROM "Clip" c WHERE c."mediaId" = m."id") AS "clipCount"
               FROM "DupeGroup" g
               JOIN "DupeMember" dm ON dm."groupId" = g."id"
               JOIN "Media" m ON m."id" = dm."mediaId"
               JOIN "MediaFileLink" fl ON fl."mediaId" = m."id" AND fl."role" = 'original'
               JOIN "MediaFile" f ON f."id" = fl."fileId"
               JOIN "MediaRoot" r ON r."id" = f."rootId"
              WHERE g."kind" = 'exact' AND g."reviewed" IS NULL AND f."state" = 'active'
                AND (? IS NULL OR m."kind" = ?)
              ORDER BY dm."groupId"`
        )
        .all(media ?? null, media ?? null) as IdenticalCopyRow[];

/**
 * Puts an item's groups back in the queue, because one of their copies has come back (§10e).
 *
 * "Reviewed" is a decision about the copies a group had when somebody looked -- usually "keep
 * the one that is left". When a copy that went returns, restored or simply obtained again at
 * its old path, that decision no longer describes the group: there are two copies again and
 * nobody has decided about them. Left reviewed, the returned duplicate sat on the Reviewed tab
 * where nobody looks, and the next clustering pass could not help, because the group it would
 * build is a subset of this one and is pruned as such.
 *
 * A group that *gains* a member needs none of this: its member set changes, so clustering makes
 * it a new group, and merging overlapping groups already drops the mark.
 */
export const reopenGroupsOf = (mediaId: string): number =>
    db
        .prepare(
            `UPDATE "DupeGroup" SET "reviewed" = NULL, "updatedAt" = CURRENT_TIMESTAMP
              WHERE "reviewed" = 1
                AND "id" IN (SELECT "groupId" FROM "DupeMember" WHERE "mediaId" = ?)`
        )
        .run(mediaId).changes;
