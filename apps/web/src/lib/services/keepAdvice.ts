import { keepDimension, rankCopies, type KeepCandidate } from "@private-stock/core";

/**
 * Saying which copy to keep, in words (§10c).
 *
 * The comparison itself is pure and lives in `@private-stock/core`; this is the sentence it
 * turns into. Both surfaces that talk about duplicates use it — the review screen, where
 * somebody is choosing, and the delete confirmation, where somebody is about to act — so the
 * recommendation cannot say one thing in the queue and another at the moment it matters.
 *
 * **Phrased on the server**, for the same reason the numbers are: a group is rendered from one
 * response, and a client that re-derived the reason would be a second implementation of the
 * ordering kept in step by nothing.
 *
 * The tone is deliberately not neutral. A preselection nobody is given a reason for is one
 * people override on instinct, and the instinct is almost always "keep the bigger file" —
 * which is the rule the ordering puts last, and the one that throws away the better copy most
 * often. Naming the actual difference is the whole intervention.
 */

const pixels = (candidate: KeepCandidate): number =>
    (candidate.width ?? 0) * (candidate.height ?? 0);

const resolutionOf = (candidate: KeepCandidate): string =>
    candidate.width && candidate.height ? `${candidate.width}×${candidate.height}` : "unknown size";

/** A duration gap as a person would say it: "12 seconds", "3 minutes". */
const gapInWords = (ms: number): string => {
    const seconds = Math.round(Math.abs(ms) / 1000);

    if (seconds < 90) {
        return `${seconds} seconds`;
    }

    return `${Math.round(seconds / 60)} minutes`;
};

/**
 * Why the recommended copy is the recommended one.
 *
 * Measured against the runner-up rather than against the field, because that is the
 * comparison the reviewer is actually about to make — with four copies on screen, "highest
 * resolution" is only useful if the next-best one is lower.
 */
export const keepReason = (best: KeepCandidate, runnerUp: KeepCandidate | undefined): string => {
    if (!runnerUp) {
        return "The only copy with a file";
    }

    switch (keepDimension(best, runnerUp)) {
        case "resolution":
            return `Highest resolution — ${resolutionOf(best)}`;
        case "duration":
            return `Longest by ${gapInWords((best.durationMs ?? 0) - (runnerUp.durationMs ?? 0))}`;
        case "bitrate":
            return "Same resolution, highest bitrate";
        case "size":
            return "Same resolution and bitrate, most data";
        case "age":
            return "Alike on every measure — in the library longest";
        default:
            return "Alike on every measure";
    }
};

/**
 * What keeping this copy instead would cost.
 *
 * Null for the recommended copy itself, and for one that is genuinely indistinguishable from
 * it — a card claiming a disadvantage that does not exist would undermine every card that
 * names a real one.
 *
 * Quantified where the number means something on its own. "Fewer pixels" invites an argument;
 * "44% of the pixels" ends one, and it is the figure people underestimate most — halving each
 * side quarters the picture.
 */
export const costOfKeeping = (best: KeepCandidate, other: KeepCandidate): string | null => {
    if (best.mediaId === other.mediaId) {
        return null;
    }

    switch (keepDimension(best, other)) {
        case "resolution": {
            const share = pixels(best) > 0 ? Math.round((pixels(other) / pixels(best)) * 100) : 0;

            return `${resolutionOf(other)} — ${share}% of the pixels`;
        }
        case "duration":
            return `${gapInWords((best.durationMs ?? 0) - (other.durationMs ?? 0))} shorter`;
        case "bitrate":
            return "Lower bitrate at the same resolution";
        case "size":
            return "Less data at the same resolution and bitrate";
        case "age":
            return "Added later";
        default:
            return null;
    }
};

export interface ClipsAtRisk {
    mine: number;
    total: number;
    reels: { id: string; name: string }[];
}

export interface DuplicateStanding {
    /** Copies that still have a file, this one included. */
    copies: number;
    /** Whether this is the copy the app would keep. */
    best: boolean;
    /** One sentence: why to keep it, or what stays if it goes. */
    advice: string;
    /**
     * What purging this copy would destroy that nothing inherits (§10c).
     *
     * Clips are the one thing a merge does not move, and after this feature they are the one
     * thing a merge can silently destroy. The reviewer is told here, where §10c says the warning
     * belongs — at the deletion rather than on the review screen.
     */
    clipsAtRisk: ClipsAtRisk;
}

/**
 * Where one item stands among its copies, for the moment somebody is about to delete it.
 *
 * The review screen is where duplicates are compared; this is where one is actually removed,
 * and until now the two said nothing to each other. Deleting the best copy of a group was as
 * quiet as deleting the worst.
 *
 * Both directions are worth saying. A warning on the best copy is the one that prevents a
 * mistake; the reassurance on every other copy is what stops the warning reading as a general
 * discouragement from tidying up, which would be the more expensive failure across a library
 * this size.
 */
export const duplicateStanding = (
    mediaId: string,
    copies: KeepCandidate[],
    clipsAtRisk: ClipsAtRisk
): DuplicateStanding | null => {
    if (copies.length < 2) {
        return null;
    }

    const ranked = rankCopies(copies);
    const best = ranked[0];
    const mine = ranked.find((copy) => copy.mediaId === mediaId);

    if (!mine) {
        return null;
    }

    if (best.mediaId === mediaId) {
        const runnerUp = ranked[1];

        return {
            copies: ranked.length,
            clipsAtRisk,
            best: true,
            advice: `This is the best of ${ranked.length} copies — ${keepReason(best, runnerUp).toLowerCase()}. Deleting it leaves ${resolutionOf(runnerUp)}.`,
        };
    }

    const cost = costOfKeeping(best, mine);

    return {
        copies: ranked.length,
        clipsAtRisk,
        best: false,
        advice: cost
            ? `One of ${ranked.length} copies, and not the best one — ${cost}. The better copy stays.`
            : `One of ${ranked.length} copies, all alike. Another stays.`,
    };
};
