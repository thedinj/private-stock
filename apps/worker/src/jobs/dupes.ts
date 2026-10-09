import {
    clusterPairs,
    compareVideos,
    dupeSettingsSchema,
    hammingDistance,
    type DupeSettings,
    type Pair,
    SETTING_KEYS,
} from "@private-stock/core";
import { db, dupeRepo, phashRepo, settingRepo } from "@private-stock/db";

import { breathe } from "../eventLoop.js";
import { enqueue, type JobRow } from "../queue.js";

/**
 * The `dupes` job: turning hashes into review groups (§10).
 *
 * One job for the whole library rather than one per item, because a group is a property of a
 * *set* of files. Several workers each building groups from their own item's point of view
 * would write overlapping groups from half-written data, and the review queue would show the
 * same three files as two different groups.
 *
 * It is also why this job is coalescing and low priority: it is enqueued after every hash,
 * the queue's uniqueness constraint collapses those into one pending job, and it runs once
 * the burst has settled rather than once per file.
 */

export const loadDupeSettings = (): DupeSettings => {
    const parsed = dupeSettingsSchema.safeParse(settingRepo.get(SETTING_KEYS.dupes, {}));

    // A malformed setting must not stop duplicate detection: defaults are always valid, and
    // an admin who typed something impossible gets the default rather than a dead feature.
    return parsed.success ? parsed.data : dupeSettingsSchema.parse({});
};

/**
 * Near-duplicate image pairs.
 *
 * Every hashed image is compared against its band candidates rather than against the whole
 * table. Pairs are emitted in a canonical order so that A-B and B-A are the same pair and
 * the clustering step does not see each link twice.
 */
const imagePairs = async (settings: DupeSettings, seeds: string[]): Promise<Pair[]> => {
    if (seeds.length === 0) {
        return [];
    }

    // Only the seeds are read here; their *candidates* still come from the whole library,
    // which is what makes the pass incremental rather than partial (§10b).
    const placeholders = seeds.map(() => "?").join(", ");
    const rows = db
        .prepare(`SELECT "mediaId", "hash" FROM "PhashImage" WHERE "mediaId" IN (${placeholders})`)
        .all(...seeds) as {
        mediaId: string;
        hash: Buffer;
    }[];

    const pairs: Pair[] = [];
    const seen = new Set<string>();
    let since = Date.now();

    for (const row of rows) {
        since = await breathe(since);

        const hash = new Uint8Array(row.hash);

        for (const candidate of phashRepo.imageCandidates(row.mediaId, hash)) {
            const key =
                row.mediaId < candidate.mediaId
                    ? `${row.mediaId}|${candidate.mediaId}`
                    : `${candidate.mediaId}|${row.mediaId}`;

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);

            const distance = hammingDistance(hash, candidate.hash);

            if (distance <= settings.imageDistance) {
                pairs.push({ a: row.mediaId, b: candidate.mediaId, distance });
            }
        }
    }

    return pairs;
};

/**
 * Near-duplicate video pairs.
 *
 * Two stages on purpose. The band index narrows the library to a handful of candidates per
 * video, and only then are the candidate's frames loaded — most candidates are rejected, and
 * loading every frame of every one of them up front is the expensive half of the pass.
 */
const videoPairs = async (settings: DupeSettings, seeds: string[]): Promise<Pair[]> => {
    if (seeds.length === 0) {
        return [];
    }

    const placeholders = seeds.map(() => "?").join(", ");
    const videoIds = (
        db
            .prepare(
                `SELECT DISTINCT "mediaId" FROM "PhashVideo" WHERE "mediaId" IN (${placeholders})`
            )
            .all(...seeds) as {
            mediaId: string;
        }[]
    ).map((row) => row.mediaId);

    const pairs: Pair[] = [];
    const seen = new Set<string>();
    const frameCache = new Map<string, ReturnType<typeof phashRepo.listVideoHashes>>();

    const framesOf = (mediaId: string) => {
        let frames = frameCache.get(mediaId);

        if (!frames) {
            frames = phashRepo.listVideoHashes(mediaId);
            frameCache.set(mediaId, frames);
        }

        return frames;
    };

    let since = Date.now();

    for (const mediaId of videoIds) {
        // Per video rather than per pair: one video's candidates are a handful of
        // comparisons, and checking the clock inside that inner loop would cost more than
        // the yield saves.
        since = await breathe(since);

        const frames = framesOf(mediaId);

        for (const candidateId of phashRepo.videoCandidates(
            mediaId,
            frames.map((frame) => frame.hash)
        )) {
            const key =
                mediaId < candidateId ? `${mediaId}|${candidateId}` : `${candidateId}|${mediaId}`;

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);

            const match = compareVideos(frames, framesOf(candidateId), settings);

            if (match) {
                pairs.push({ a: mediaId, b: candidateId, distance: match.distance });
            }
        }
    }

    return pairs;
};

/**
 * How many items one pass seeds with.
 *
 * Bounded so a pass stays a few seconds whatever the library's size, and re-queued below
 * while a backlog remains -- so an import of 200k items is many short passes rather than one
 * that holds a claim for an hour and blocks every later hash from being clustered at all.
 */
const SEED_LIMIT = 500;

/**
 * Merge new links into whatever groups already exist (§10b).
 *
 * The step that makes an incremental pass correct rather than merely cheap. Clustering is
 * transitive, so an item that links two items which were in separate groups must merge those
 * groups -- and a pass that considered only its own new pairs would write a third group
 * overlapping both, leaving the review queue showing the same files two or three times.
 *
 * So every group the new pairs touch is pulled in and re-clustered alongside them, as edges
 * from each group's first member to the rest. The result is upserted; any group that was
 * absorbed rather than reproduced exactly is deleted.
 *
 * `upsertGroup` returns the existing id when the membership is unchanged, which is what keeps
 * a reviewed group reviewed through a pass that touched something next to it.
 */
const mergeIntoGroups = async (kind: "near" | "exact", pairs: Pair[]): Promise<void> => {
    if (pairs.length === 0) {
        return;
    }

    const touched = [...new Set(pairs.flatMap((pair) => [pair.a, pair.b]))];
    const existing = dupeRepo.groupsContaining(touched).filter((group) => group.kind === kind);
    const existingIds = existing.map((group) => group.id);

    const byGroup = new Map<string, string[]>();

    for (const row of dupeRepo.membersOf(existingIds)) {
        byGroup.set(row.groupId, [...(byGroup.get(row.groupId) ?? []), row.mediaId]);
    }

    /**
     * An existing group becomes a star of edges rather than a clique.
     *
     * n-1 edges instead of n(n-1)/2, and union-find only needs connectivity -- the members
     * end up in one component either way. A clique would make a fifty-file exact-duplicate
     * group cost twelve hundred edges to say what forty-nine say.
     */
    const edges: Pair[] = [...pairs];

    for (const members of byGroup.values()) {
        for (let i = 1; i < members.length; i += 1) {
            edges.push({ a: members[0], b: members[i], distance: 0 });
        }
    }

    const survivors = new Set<string>();
    let since = Date.now();

    for (const cluster of clusterPairs(edges)) {
        since = await breathe(since);

        survivors.add(
            dupeRepo.upsertGroup({
                kind,
                members: cluster.members.map((mediaId) => ({
                    mediaId,
                    // The group's looseness, recorded per member so the review UI can show
                    // how far apart the furthest linked pair is.
                    distance: kind === "exact" ? 0 : cluster.maxDistance,
                })),
            })
        );
    }

    dupeRepo.deleteGroups(existingIds.filter((id) => !survivors.has(id)));
};

/**
 * Not an admin setting: bookkeeping about what the last pass was configured with.
 *
 * Deliberately outside `SETTING_KEYS`, which is the contract for things a person edits
 * (§12b). Nothing renders this and nobody should be offered it.
 */
const CLUSTERED_WITH_KEY = "dupes.clusteredWith";

/**
 * Start again when the thresholds change.
 *
 * The thresholds decide which pairs count at all, so lowering `imageDistance` after a library
 * has been clustered would otherwise apply only to items hashed from that moment on. The
 * setting would appear to do nothing to the library it was changed for, which is all of it.
 *
 * Only the marks are cleared. `upsertGroup` returns the identical group rather than replacing
 * it, so everything that still clusters the same way keeps its id and its review state
 * through the re-pass -- the cost of a threshold change is CPU, not somebody's review work.
 */
const forgetIfSettingsChanged = (settings: DupeSettings): void => {
    const fingerprint = JSON.stringify(settings);

    if (settingRepo.get(CLUSTERED_WITH_KEY, "") === fingerprint) {
        return;
    }

    const cleared = dupeRepo.clearClustered();
    settingRepo.set(CLUSTERED_WITH_KEY, fingerprint);

    if (cleared > 0) {
        console.log(`Duplicate thresholds changed; re-examining ${cleared} item(s)`);
    }
};

export const runDupes = async (_job: JobRow): Promise<void> => {
    const settings = loadDupeSettings();

    forgetIfSettingsChanged(settings);

    const seeds = dupeRepo.seedsNeedingClustering(SEED_LIMIT);

    if (seeds.length === 0) {
        // Still worth pruning: the usual reason a group degenerates is that someone deleted
        // the extra copies, which happens without anything being hashed.
        dupeRepo.pruneDegenerate();
        dupeRepo.pruneSubsumed();
        dupeRepo.mergeOverlapping();
        return;
    }

    /**
     * Exact duplicates first, and separately.
     *
     * They come from `contentHash` and need no perceptual hashing at all, so they are found
     * whether or not anything has been hashed yet. Keeping them in their own groups matters
     * for review: with a byte-identical pair there is nothing to compare, only a choice of
     * which path to keep, and mixing them into near-duplicate groups would hide that.
     */
    const exactPairs: Pair[] = [];

    for (const members of dupeRepo.exactDuplicateSetsFor(seeds)) {
        for (let i = 1; i < members.length; i += 1) {
            exactPairs.push({ a: members[0], b: members[i], distance: 0 });
        }
    }

    await mergeIntoGroups("exact", exactPairs);

    const nearPairs = [
        ...(await imagePairs(settings, seeds)),
        ...(await videoPairs(settings, seeds)),
    ];

    await mergeIntoGroups("near", nearPairs);

    // Only once the pass has succeeded. A crash half way leaves the seeds unmarked, and the
    // next pass does them again -- which is the safe direction to fail in.
    dupeRepo.markClustered(seeds);

    // Groups whose extra copies have since been deleted are not duplicates any more; leaving
    // them behind shows a "duplicate group" containing one file.
    dupeRepo.pruneDegenerate();

    /**
     * The belt to the merge step's braces (§10b).
     *
     * `mergeIntoGroups` deletes the groups it absorbs, so this should find nothing. It runs
     * anyway because the failure it catches is silent -- a reviewer meeting the same file in
     * eight overlapping groups and concluding the feature is broken -- and because it is the
     * only thing that would catch the same accumulation arriving by a route nobody predicted.
     */
    const subsumed = dupeRepo.pruneSubsumed() + dupeRepo.mergeOverlapping();

    if (subsumed > 0) {
        console.log(`Tidied ${subsumed} duplicate group(s) that overlapped another`);
    }

    /**
     * Straight back in if there is more waiting.
     *
     * The two-minute settle window in the phash job is right for a trickle and wrong for a
     * backlog: at 500 seeds a pass, an import of 200k items would take days to cluster if
     * every pass waited. A full batch means there is more to do, so the next one is queued
     * without a delay and the unique index stops it piling up.
     */
    if (seeds.length === SEED_LIMIT) {
        enqueue(db, { kind: "dupes", priority: 200 });
    }
};
