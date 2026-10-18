import { readFile } from "node:fs/promises";
import * as path from "node:path";

import {
    alignTilePrints,
    apartFrom,
    assertSafeRelativePath,
    clusterPairs,
    compareVideos,
    decodeTilePrints,
    dupeSettingsSchema,
    durationsComparable,
    hammingDistance,
    prepareTilePrints,
    tilePrintRelPath,
    tilesMatch,
    type DupeSettings,
    type Pair,
    type PreparedTilePrints,
    SETTING_KEYS,
} from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";
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

/**
 * How long the clustering pass waits for more evidence before running.
 *
 * Two minutes is long enough to swallow a bulk import's worth of hashes into one
 * pass, and short enough that someone who drops in a handful of files sees duplicate
 * groups while they are still looking at them.
 */
const DUPE_SETTLE_MS = 2 * 60 * 1000;

/**
 * Ask for a clustering pass once the current burst of hashes and prints has settled.
 *
 * Not before the settle window is up, which is what makes the coalescing real. The queue's
 * unique index collapses duplicate *pending* jobs, so this used to read as "one pass after the
 * burst". It was not: each pass finished in about ten seconds, the next hash queued another
 * immediately, and the pass ran again. Over one import that was **3,599 whole-library passes**
 * -- the same comparison of the same library, over and over, for a handful of new rows each time.
 *
 * Deferring the job leaves it pending for the whole window, so every hash finishing in that
 * window hits the unique index and adds nothing. The effect is a rate limit rather than a
 * debounce, and deliberately so: pushing the deadline out on each hash would mean a library that
 * is importing for ten hours has no duplicate detection at all until it stops.
 */
export const queueDupePass = (): void => {
    enqueue(db, {
        kind: "dupes",
        priority: 200,
        availableAt: new Date(Date.now() + DUPE_SETTLE_MS),
    });
};

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

        for (const candidate of phashRepo.imageCandidates(
            row.mediaId,
            hash,
            settings.imageDistance
        )) {
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
 * Two stages on purpose. The band index narrows the library to the videos that could match, and only then are the candidate's frames loaded — most candidates are rejected, and
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
            frames.map((frame) => frame.hash),
            settings.frameDistance,
            settings.minMatchingFrames
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
 * Video pairs the perceptual hash missed because the copies start at different moments (§10h).
 *
 * The second leg, run on the pairs the first did not confirm. Candidates are every video close
 * enough in length -- the only gate that does not depend on one sampled frame lining up by
 * luck -- found by binary search into the list sorted by length. Each pair then costs a few
 * hundred dot products, so the number of candidates hardly matters; what costs is reading each
 * video's prints, which is done once per pass and kept.
 *
 * A confirmed pair joins the group at the frame threshold as its distance: the tiles say the
 * videos are the same, not how many bits apart their pictures are, and the loosest distance the
 * hash would have accepted is the honest stand-in.
 */
const tilePairs = async (
    settings: DupeSettings,
    seeds: string[],
    found: Set<string>
): Promise<Pair[]> => {
    const videos = dupeRepo.tilePrintedVideos();

    if (videos.length < 2) {
        return [];
    }

    const byId = new Map(videos.map((video, index) => [video.mediaId, index]));
    const { dataDir } = loadConfig();
    const prints = new Map<string, PreparedTilePrints | null>();

    const printsOf = async (mediaId: string): Promise<PreparedTilePrints | null> => {
        if (!prints.has(mediaId)) {
            try {
                const bytes = await readFile(
                    path.resolve(dataDir, assertSafeRelativePath(tilePrintRelPath(mediaId)))
                );

                prints.set(mediaId, prepareTilePrints(decodeTilePrints(new Uint8Array(bytes))));
            } catch {
                // Missing or unreadable: the orphan sweep reconciles the stage, and this pair
                // waits for the next pass.
                prints.set(mediaId, null);
            }
        }

        return prints.get(mediaId)!;
    };

    const pairs: Pair[] = [];
    let since = Date.now();

    for (const seed of seeds) {
        const at = byId.get(seed);

        if (at === undefined) {
            continue;
        }

        since = await breathe(since);

        const mine = await printsOf(seed);

        if (!mine) {
            continue;
        }

        const { durationMs } = videos[at];

        // Outwards from the seed in both directions until the lengths stop being comparable;
        // the list is sorted, so nothing further out can be.
        for (const step of [-1, 1]) {
            for (let i = at + step; i >= 0 && i < videos.length; i += step) {
                const other = videos[i];

                if (!durationsComparable(durationMs, other.durationMs)) {
                    break;
                }

                const key =
                    seed < other.mediaId ? `${seed}|${other.mediaId}` : `${other.mediaId}|${seed}`;

                if (found.has(key)) {
                    continue;
                }

                found.add(key);

                const theirs = await printsOf(other.mediaId);

                if (
                    theirs &&
                    tilesMatch(alignTilePrints(mine, theirs), settings.minMatchingFrames)
                ) {
                    pairs.push({ a: seed, b: other.mediaId, distance: settings.frameDistance });
                }
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

    /**
     * What people said about these items (§10i). A pair said to differ is never joined, so a
     * group somebody sorted apart stays apart however the chain links it; one said to be the
     * same is a link of its own, taken first. Identical files are the same bytes, and nothing a
     * person says changes that.
     */
    const verdicts =
        kind === "near"
            ? dupeRepo.verdictsAmong([...new Set([...touched, ...[...byGroup.values()].flat()])])
            : [];

    for (const verdict of verdicts) {
        if (verdict.verdict === "same") {
            edges.unshift({ a: verdict.aId, b: verdict.bId, distance: 0 });
        }
    }

    const apart = apartFrom(
        verdicts.map((verdict) => ({ a: verdict.aId, b: verdict.bId, verdict: verdict.verdict }))
    );
    const survivors = new Set<string>();
    let since = Date.now();

    for (const cluster of clusterPairs(edges, apart)) {
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
 * Which way of finding candidates the marks were earned under.
 *
 * Part of the fingerprint for the same reason the thresholds are: a mark says "compared, and
 * found what there was to find", and a pass that could not find some pairs did not earn it.
 * Bump it whenever a change lets a pass find pairs an earlier one could not, and the next
 * pass re-examines the library once, keeping every group and its review state.
 *
 * 2: candidates are exact rather than an unordered `LIMIT 200` of almost every video, and a
 *    mark no longer survives the hashes arriving after it (§10b).
 * 3: videos of similar length are also lined up by their tile prints (§10h).
 */
const CANDIDATE_RECIPE = 3;

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
    const fingerprint = JSON.stringify({ recipe: CANDIDATE_RECIPE, ...settings });

    if (settingRepo.get(CLUSTERED_WITH_KEY, "") === fingerprint) {
        return;
    }

    const cleared = dupeRepo.clearClustered();
    settingRepo.set(CLUSTERED_WITH_KEY, fingerprint);

    if (cleared > 0) {
        console.log(`Duplicate detection changed; re-examining ${cleared} item(s)`);
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
    const found = new Set(
        nearPairs.map((pair) => (pair.a < pair.b ? `${pair.a}|${pair.b}` : `${pair.b}|${pair.a}`))
    );

    nearPairs.push(...(await tilePairs(settings, seeds, found)));

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
