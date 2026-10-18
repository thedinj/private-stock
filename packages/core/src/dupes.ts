import { PHASH_DEFAULT_DISTANCE, PHASH_MAX_INDEXED_DISTANCE, hammingDistance } from "./phash.js";
import { z } from "zod";

/**
 * Turning pairwise similarity into groups a person can review (§10).
 *
 * Pure, and separated from the queries that feed it, because the interesting decisions here
 * are not about SQL. They are about what "the same" means when similarity is not transitive,
 * and about which file a person would want to keep — both of which are easy to get subtly
 * wrong and impossible to notice from a screenshot.
 */

export const dupeSettingsSchema = z.object({
    /**
     * Bits two images may differ by and still count as the same picture.
     *
     * Clamped to what the band index can actually find. Above that the index silently stops
     * returning some genuine pairs rather than slowing down, so a higher number would not
     * widen the net — it would only make the results depend on which pairs happened to share
     * a band.
     */
    imageDistance: z.coerce
        .number()
        .int()
        .min(0)
        .max(PHASH_MAX_INDEXED_DISTANCE)
        .default(PHASH_DEFAULT_DISTANCE),
    /** Same, for individual video frames. */
    frameDistance: z.coerce
        .number()
        .int()
        .min(0)
        .max(PHASH_MAX_INDEXED_DISTANCE)
        .default(PHASH_DEFAULT_DISTANCE),
    /**
     * Fraction of one video's sampled frames that must match for the videos to pair.
     *
     * Deliberately measured against the *shorter* video's frame count, so a two-minute clip
     * cut from a two-hour film still matches: against the longer one the fraction would be
     * about 2%, and no usable threshold distinguishes that from coincidence.
     */
    videoFrameRatio: z.coerce.number().min(0.1).max(1).default(0.6),
    /** Below this, a pair is not worth a person's attention whatever the frames say. */
    minMatchingFrames: z.coerce.number().int().min(1).default(3),
});
export type DupeSettings = z.infer<typeof dupeSettingsSchema>;

export interface FrameHash {
    frameIdx: number;
    hash: Uint8Array;
}

export interface VideoMatch {
    matchingFrames: number;
    comparedFrames: number;
    /** Mean distance over matching frames — the group's "how alike" number. */
    distance: number;
}

/**
 * Whether two videos are the same content.
 *
 * Greedy one-to-one frame pairing rather than "does any frame match": a single shared frame
 * is meaningless in a library where many videos open on black, close on a logo, or share a
 * stock establishing shot. Requiring a *fraction* of frames to pair is what separates the
 * same film at two resolutions from two films by the same studio.
 *
 * One-to-one matters too. Without it, a video whose frames are all near-identical — a static
 * camera on a locked-off shot — would match any other video containing one similar frame,
 * because that frame would pair with every frame on the other side.
 */
export const compareVideos = (
    a: FrameHash[],
    b: FrameHash[],
    settings: DupeSettings
): VideoMatch | null => {
    if (a.length === 0 || b.length === 0) {
        return null;
    }

    const used = new Set<number>();
    let matching = 0;
    let total = 0;

    for (const frame of a) {
        let bestIndex = -1;
        let bestDistance = settings.frameDistance + 1;

        for (let i = 0; i < b.length; i += 1) {
            if (used.has(i)) {
                continue;
            }

            const distance = hammingDistance(frame.hash, b[i].hash);

            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = i;
            }
        }

        if (bestIndex >= 0) {
            used.add(bestIndex);
            matching += 1;
            total += bestDistance;
        }
    }

    // Against the shorter side, so a clip contained in a longer file still qualifies.
    const comparable = Math.min(a.length, b.length);
    const ratio = matching / comparable;

    if (matching < settings.minMatchingFrames || ratio < settings.videoFrameRatio) {
        return null;
    }

    return {
        matchingFrames: matching,
        comparedFrames: comparable,
        distance: Math.round(total / matching),
    };
};

export interface Pair {
    a: string;
    b: string;
    distance: number;
}

export interface Cluster {
    members: string[];
    /** Worst distance between any *linked* pair in the cluster. */
    maxDistance: number;
}

/**
 * Groups pairs into clusters by connectivity.
 *
 * Union-find, which means similarity is treated as transitive even though it is not: if A
 * matches B and B matches C, all three land in one group even when A and C are far apart.
 * That is a deliberate choice and the alternative is worse. Requiring every member to match
 * every other splits an obvious family of re-encodes into overlapping pairs, and the person
 * reviewing then sees the same file in three groups and has to reason about which deletion
 * affects which — whereas a single slightly-loose group is one decision.
 *
 * The cost is chaining: a long enough chain of small differences can join two genuinely
 * different pictures. `maxDistance` is reported so the review UI can show how loose a group
 * is, and the thresholds are tight enough that chains stay short in practice.
 *
 * **Except where a person has said two items differ** (§10i). `apart` names those pairs, and
 * no join may put both in one cluster: links are taken closest first, and one that would is
 * refused. So an item that looks like both of two copies somebody kept apart joins the one it
 * is closer to, and does not tie them back together. Without `apart` the order changes nothing,
 * since connectivity does not depend on it.
 */
export const clusterPairs = (
    pairs: Pair[],
    apart?: ReadonlyMap<string, ReadonlySet<string>>
): Cluster[] => {
    const parent = new Map<string, string>();
    /** Each root's members, kept only when there is something to check them against. */
    const membersOf = new Map<string, Set<string>>();

    const find = (id: string): string => {
        let root = parent.get(id) ?? id;

        while (root !== parent.get(root)) {
            const next = parent.get(root);

            if (next === undefined || next === root) {
                break;
            }

            root = next;
        }

        // Path compression, so repeated lookups over a large library stay near-constant.
        let current = id;

        while (current !== root) {
            const next = parent.get(current) ?? current;

            parent.set(current, root);
            current = next;
        }

        return root;
    };

    /**
     * A link from an item to itself is not a link (§10b).
     *
     * Dropped here rather than at each of the four places pairs are built, because this is
     * the one point every pair passes through. A self-pair would otherwise produce a cluster
     * of one, which becomes a "duplicate group" containing a single file -- the exact thing
     * `pruneDegenerate` exists to clean up after.
     */
    const links = pairs.filter((pair) => pair.a !== pair.b);
    const constrained = apart !== undefined && apart.size > 0;

    for (const pair of links) {
        for (const id of [pair.a, pair.b]) {
            if (!parent.has(id)) {
                parent.set(id, id);
                if (constrained) membersOf.set(id, new Set([id]));
            }
        }
    }

    /** Whether any member of one set has been said to differ from any member of the other. */
    const kept = (one: Set<string>, other: Set<string>): boolean => {
        const [small, large] = one.size <= other.size ? [one, other] : [other, one];

        for (const id of small) {
            for (const differs of apart?.get(id) ?? []) {
                if (large.has(differs)) return true;
            }
        }

        return false;
    };

    // Closest first, so a refused link is the weaker of the two that compete. Stable, so pairs
    // at one distance keep the order they came in.
    const ordered = constrained
        ? links
              .map((pair, index) => ({ pair, index }))
              .sort((x, y) => x.pair.distance - y.pair.distance || x.index - y.index)
              .map(({ pair }) => pair)
        : links;
    const accepted: Pair[] = [];

    for (const pair of ordered) {
        const rootA = find(pair.a);
        const rootB = find(pair.b);

        if (rootA !== rootB) {
            if (constrained) {
                const setA = membersOf.get(rootA)!;
                const setB = membersOf.get(rootB)!;

                if (kept(setA, setB)) continue;

                for (const id of setA) setB.add(id);
                membersOf.delete(rootA);
            }

            parent.set(rootA, rootB);
        }

        accepted.push(pair);
    }

    const groups = new Map<string, { members: Set<string>; maxDistance: number }>();

    for (const pair of accepted) {
        const root = find(pair.a);
        let group = groups.get(root);

        if (!group) {
            group = { members: new Set(), maxDistance: 0 };
            groups.set(root, group);
        }

        group.members.add(pair.a);
        group.members.add(pair.b);
        group.maxDistance = Math.max(group.maxDistance, pair.distance);
    }

    return [...groups.values()]
        .map((group) => ({
            // Sorted so a group's identity does not depend on the order pairs arrived in,
            // which is what lets a re-run recognise a group it has already created.
            members: [...group.members].sort(),
            maxDistance: group.maxDistance,
        }))
        .filter((group) => group.members.length > 1);
};

/** What a person said about two items (§10i): the same thing, or different things. */
export type DupeVerdictKind = "same" | "different";

export interface VerdictPair {
    a: string;
    b: string;
    verdict: DupeVerdictKind;
}

/** The pairs said to differ, as `clusterPairs` reads them: each item's list, both ways round. */
export const apartFrom = (verdicts: VerdictPair[]): Map<string, Set<string>> => {
    const apart = new Map<string, Set<string>>();

    for (const { a, b, verdict } of verdicts) {
        if (verdict !== "different" || a === b) continue;

        apart.set(a, (apart.get(a) ?? new Set()).add(b));
        apart.set(b, (apart.get(b) ?? new Set()).add(a));
    }

    return apart;
};

/**
 * Everything a sorting of copies into sets says (§10i): every two in one set are the same, and
 * every two in different sets are not. A set of one is a copy on its own, unlike all the rest.
 *
 * Pairs come out with `a < b`, the order they are stored in, so saying it twice is one row.
 */
export const verdictsOfSets = (sets: string[][]): VerdictPair[] => {
    const pairs: VerdictPair[] = [];
    const flat = sets.flatMap((set, index) => set.map((id) => ({ id, index })));

    for (let i = 0; i < flat.length; i += 1) {
        for (let j = i + 1; j < flat.length; j += 1) {
            const [x, y] = [flat[i], flat[j]];

            if (x.id === y.id) continue;

            pairs.push({
                a: x.id < y.id ? x.id : y.id,
                b: x.id < y.id ? y.id : x.id,
                verdict: x.index === y.index ? "same" : "different",
            });
        }
    }

    return pairs;
};

/**
 * How the app would sort a group's copies, before anybody has (§10i).
 *
 * A group is a chain of links (above), so its ends need not look alike at all. Here each copy
 * joins the first set where it matches **every** copy already in it, and otherwise starts one
 * of its own -- a chain A–B–C–D where only neighbours match comes out as {A, B} and {C, D}.
 * Copies are taken in the order given, which is best first, so each set is led by its best copy.
 *
 * `same` is a person's word that two copies are alike, and counts as a match; `different` is
 * their word that they are not, and outweighs one. One set means the app sees nothing to sort.
 */
export const suggestSets = (
    ids: string[],
    matches: (a: string, b: string) => boolean,
    verdicts: VerdictPair[] = []
): string[][] => {
    const said = new Map<string, DupeVerdictKind>();

    for (const { a, b, verdict } of verdicts) {
        said.set(a < b ? `${a}|${b}` : `${b}|${a}`, verdict);
    }

    const alike = (a: string, b: string): boolean => {
        const verdict = said.get(a < b ? `${a}|${b}` : `${b}|${a}`);

        return verdict === undefined ? matches(a, b) : verdict === "same";
    };

    const sets: string[][] = [];

    for (const id of ids) {
        const home = sets.find((set) => set.every((other) => alike(id, other)));

        if (home) home.push(id);
        else sets.push([id]);
    }

    return sets;
};

export interface KeepCandidate {
    mediaId: string;
    width: number | null;
    height: number | null;
    bitrate: number | null;
    sizeBytes: number | null;
    durationMs: number | null;
    addedAt: string;
}

/** From this length up, a video counts as long and gets the wider tolerance below. */
const LONG_VIDEO_MS = 10 * 60_000;

/**
 * How far apart two lengths can be and still be the same video: an encoder's last frame,
 * container padding, an intro card or a bumper.
 *
 * Five seconds for a short video, thirty for one of ten minutes or more. A fixed five seconds
 * was too tight on a long video, where a studio card or a few seconds of black at either end is
 * ordinary and says nothing about completeness, and the review screen asked about every one of
 * them. Measured against the longer copy, which is the one whose length is in question.
 *
 * Also the gap at which the review screen starts asking whether the recommended copy is missing
 * something (§10c).
 */
export const lengthTolerance = (longestMs: number): number =>
    longestMs >= LONG_VIDEO_MS ? 30_000 : 5_000;

/** A copy missing more than this share of the longer one is a different cut, not a re-encode. */
const DIFFERENT_CUT_SHARE = 0.1;

/**
 * Whether one copy is missing real content from the other rather than a few seconds of padding.
 *
 * Both lengths have to be known. An unprobed copy's missing duration is not evidence that it
 * is short, and treating it as zero would hand every probed copy the win on "length".
 */
export const isDifferentCut = (a: number | null, b: number | null): boolean => {
    if (!a || !b) {
        return false;
    }

    const longest = Math.max(a, b);

    return (
        longest - Math.min(a, b) > Math.max(lengthTolerance(longest), longest * DIFFERENT_CUT_SHARE)
    );
};

/**
 * The one measure by which a copy outranks another.
 *
 * The ordering `preferredKeep` documents, made inspectable. A preselection that cannot say why it chose is a
 * preselection people override on a hunch, and the hunch is usually "the bigger file" --
 * which is the rule this ordering deliberately puts last. Naming the reason is what turns
 * the recommendation into an argument the reviewer can check in a second.
 *
 * `tie` means the two are indistinguishable on everything that indicates quality, so the
 * comparison fell through to the item id purely to keep the ordering stable.
 */
export type KeepDimension = "resolution" | "duration" | "bitrate" | "size" | "age" | "tie";

const pixels = (candidate: KeepCandidate): number =>
    (candidate.width ?? 0) * (candidate.height ?? 0);

/**
 * How two copies compare, and on what — the ordering `preferredKeep` documents.
 *
 * `order` is a comparator result with the better copy first, so sorting by it and reading the
 * dimension off it cannot drift apart -- which they would the moment they were written twice.
 */
const rank = (a: KeepCandidate, b: KeepCandidate): { order: number; dimension: KeepDimension } => {
    if (isDifferentCut(a.durationMs, b.durationMs)) {
        return { order: (b.durationMs ?? 0) - (a.durationMs ?? 0), dimension: "duration" };
    }

    const byPixels = pixels(b) - pixels(a);

    if (byPixels !== 0) {
        return { order: byPixels, dimension: "resolution" };
    }

    const byBitrate = (b.bitrate ?? 0) - (a.bitrate ?? 0);

    if (byBitrate !== 0) {
        return { order: byBitrate, dimension: "bitrate" };
    }

    const bySize = (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);

    if (bySize !== 0) {
        return { order: bySize, dimension: "size" };
    }

    const byAge = a.addedAt.localeCompare(b.addedAt);

    if (byAge !== 0) {
        return { order: byAge, dimension: "age" };
    }

    return { order: a.mediaId.localeCompare(b.mediaId), dimension: "tie" };
};

/**
 * The copies in the order a reviewer should read them, best first.
 *
 * Ordering is itself a recommendation. A group rendered in whatever order the rows came back
 * asks somebody to compare six numbers across four cards before they know which one the app
 * would keep; ordered, the answer is the card they are already looking at.
 */
export const rankCopies = (candidates: KeepCandidate[]): KeepCandidate[] =>
    [...candidates].sort((a, b) => rank(a, b).order);

/**
 * Why one copy beats another, for a sentence shown to a person.
 *
 * Always called with the better copy first. Passing them the other way round still names the
 * dimension that separates them, which is what makes it usable for "what keeping this one
 * would cost" as well as for "why this one wins".
 */
export const keepDimension = (better: KeepCandidate, worse: KeepCandidate): KeepDimension =>
    rank(better, worse).dimension;

/**
 * Which file to keep, as a *preselection* rather than a decision.
 *
 * Nothing here deletes anything — this only decides which radio button starts checked, which
 * matters because a review queue where the right answer is usually preselected gets worked
 * through, and one where it is not gets abandoned.
 *
 * Ordered by what actually indicates quality, most decisive first:
 *
 *  1. **Completeness.** Only when one copy is missing real content — more than a tenth of the
 *     longer one (`isDifferentCut`). A sharp two-minute clip is not a better copy of a
 *     two-hour film; it is a different, smaller thing, and keeping it would trash the film.
 *  2. **Pixels.** A 1080p copy beats a 720p one, and no amount of bitrate rescues discarded
 *     resolution.
 *  3. **Bitrate**, then **size**. At equal resolution, more data is more detail.
 *  4. **Age.** A tiebreaker rather than a signal: with everything else equal, the copy that
 *     has been in the library longest is the one other things may already reference.
 *
 * **A small length difference decides nothing.** It used to rank second, after pixels, for any
 * gap over five seconds, whatever the video's length — so at equal resolution a 12:08 copy at 3 Mbps beat a 12:00 copy at
 * 8 Mbps. Seconds are an intro card or a bumper far more often than content, and the goal is
 * the best-looking copy, not the one with the most frames. Where a gap might be content — a
 * truncated download — the review screen says so and leaves the group unticked (§10c), which
 * is a question for the reviewer rather than a guess the ranking makes silently.
 *
 * Size is deliberately *last* among the quality signals, and never a reason to prefer the
 * smaller file: saving space is not what this is for. It is the most tempting rule and the
 * worst one: an inefficiently encoded 720p file is routinely larger than an efficient 1080p one,
 * so ranking by size alone throws away the better copy surprisingly often.
 */
export const preferredKeep = (candidates: KeepCandidate[]): string | null =>
    rankCopies(candidates)[0]?.mediaId ?? null;

/** One copy in a group of identical files, with what deciding its fate needs (§10e). */
export interface IdenticalCopy extends KeepCandidate {
    /** On a writable root, so it could be removed at all (§18.1). */
    deletable: boolean;
    contentHash: string | null;
    /** Clips cut from it, which no merge carries (§10c). */
    clipCount: number;
}

/**
 * Which identical copy stays (§10e).
 *
 * **A copy on a read-only root, when there is one.** It cannot be removed whatever is decided,
 * so keeping it lets every writable copy go. Keeping a writable one instead leaves the
 * read-only copy stranded beside it and removes nothing -- which is what the review sheet used
 * to preselect, and why such groups sat in the queue.
 *
 * Otherwise the ranking's choice, which for byte-identical files falls through quality to age:
 * the copy catalogued first, most often the one in its intended place.
 */
export const identicalKeeper = (copies: IdenticalCopy[]): string | null => {
    const ranked = rankCopies(copies);
    const byId = new Map(copies.map((copy) => [copy.mediaId, copy]));

    return (
        ranked.find((copy) => byId.get(copy.mediaId)?.deletable === false)?.mediaId ??
        ranked[0]?.mediaId ??
        null
    );
};

/**
 * What trashing every identical copy would do to one group (§10e).
 *
 * - `routine` -- the keeper stays, every other writable copy goes, and nobody needs to look.
 * - `attention` -- a person should decide: the copies are not all provably the same bytes any
 *   more, or a copy that would go has clips on it.
 * - `nothing` -- there is nothing a decision could remove.
 */
export type IdenticalPlan =
    | { kind: "routine"; keepId: string; trashIds: string[]; bytes: number }
    | { kind: "attention"; reason: string }
    | { kind: "nothing" };

export const planIdentical = (copies: IdenticalCopy[]): IdenticalPlan => {
    if (copies.length < 2) {
        return { kind: "nothing" };
    }

    /**
     * Re-checked rather than trusted from the group's kind. Groups are stored (§10b), and a
     * file edited since has had its hash cleared by the scanner; a group cannot vouch for bytes
     * its members no longer provably share.
     */
    const hash = copies[0]?.contentHash ?? null;

    if (hash === null || copies.some((copy) => copy.contentHash !== hash)) {
        return { kind: "attention", reason: "Not every copy is known to be identical any more" };
    }

    const keepId = identicalKeeper(copies);
    const going = copies.filter((copy) => copy.mediaId !== keepId && copy.deletable);

    if (!keepId || going.length === 0) {
        return { kind: "nothing" };
    }

    const clips = going.reduce((total, copy) => total + copy.clipCount, 0);

    if (clips > 0) {
        return {
            kind: "attention",
            reason: `${clips} ${clips === 1 ? "clip is" : "clips are"} cut from a copy that would go`,
        };
    }

    return {
        kind: "routine",
        keepId,
        trashIds: going.map((copy) => copy.mediaId),
        bytes: going.reduce((total, copy) => total + (copy.sizeBytes ?? 0), 0),
    };
};
