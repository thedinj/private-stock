import { isDifferentCut, lengthTolerance, type DupeKind } from "@private-stock/core";

/**
 * Why a duplicate group deserves more than a glance (§10c).
 *
 * The triage sheet ticks every group by default, so a page of recommendations is accepted in
 * one press. That is only safe if the groups a glance would get wrong start unticked — and they
 * are few enough to name, so each is a rule rather than a score:
 *
 * - **A different cut.** Video matching is measured against the *shorter* video (§10), so a
 *   two-minute clip clusters with the film it was cut from. The ranking keeps the whole film,
 *   but the clip may be something somebody made on purpose, and the thumbnails cannot show it.
 * - **A recommended copy that is shorter than another.** The ranking lets picture quality beat
 *   a few seconds of length, because seconds are usually an intro card. Usually is not always —
 *   a truncated download looks the same — so the reviewer is asked rather than the ranking
 *   guessing silently.
 * - **Copies with no picture.** The sheet is judged by eye; a copy with nothing to look at has
 *   not been judged.
 *
 * Exact groups get none of these. Byte-identical files have the same length and the same
 * frames, so there is nothing a closer look could find.
 *
 * The length rules come from `@private-stock/core`, the same ones `rankCopies` uses, so what
 * counts as "a different cut" here and in the ranking cannot drift apart.
 *
 * Clips at risk are a caution too, but they depend on which copy is kept — the reviewer can
 * change that — so the client draws that one from each copy's `clipCount`.
 */

export interface CautionMember {
    id: string;
    kind: "image" | "video";
    durationMs: number | null;
    coverUrl: string | null;
}

const clock = (ms: number): string => {
    const total = Math.round(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, "0");

    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
        : `${minutes}:${seconds}`;
};

export const groupCautions = (
    kind: DupeKind,
    members: CautionMember[],
    suggestedKeepId: string | null
): string[] => {
    if (kind === "exact") {
        return [];
    }

    const cautions: string[] = [];

    const timed = members.filter(
        (member): member is CautionMember & { durationMs: number } =>
            member.kind === "video" && member.durationMs !== null && member.durationMs > 0
    );

    if (timed.length >= 2) {
        const shortest = Math.min(...timed.map((member) => member.durationMs));
        const longest = Math.max(...timed.map((member) => member.durationMs));
        const keeper = timed.find((member) => member.id === suggestedKeepId);

        if (isDifferentCut(shortest, longest)) {
            cautions.push(
                `Lengths differ — ${clock(shortest)} to ${clock(longest)}. One may be cut from another.`
            );
        }

        if (keeper && longest - keeper.durationMs > lengthTolerance(longest)) {
            cautions.push(
                `The recommended copy runs ${clock(keeper.durationMs)}, another ${clock(longest)} — check nothing is missing.`
            );
        }
    }

    const unseen = members.filter((member) => member.coverUrl === null).length;

    if (unseen > 0) {
        cautions.push(
            unseen === members.length
                ? "No picture yet for any of these copies"
                : `No picture yet for ${unseen === 1 ? "one" : unseen} of these copies`
        );
    }

    return cautions;
};

/**
 * Why one of an item's copies deserves a look before it goes to the bin with the item (§10d).
 *
 * The same rules as the group's, asked from where the delete confirmation stands: not "do these
 * copies differ" but "is this one only a copy of what I am deleting". A copy that runs much
 * longer may hold more than the item -- a film the clip was cut from -- and one that runs much
 * shorter may be an excerpt somebody made on purpose. The length rule is `isDifferentCut`, the
 * one the ranking and the group cautions use.
 *
 * Nothing for a byte-identical copy, which cannot differ; the caller knows that and asks only
 * about the others.
 */
export const copyCaution = (item: CautionMember, copy: CautionMember): string | null => {
    if (
        item.kind === "video" &&
        copy.kind === "video" &&
        item.durationMs &&
        copy.durationMs &&
        isDifferentCut(item.durationMs, copy.durationMs)
    ) {
        const lengths = `Runs ${clock(copy.durationMs)} to this one's ${clock(item.durationMs)}`;

        return copy.durationMs > item.durationMs
            ? `${lengths} — it may hold more than this.`
            : `${lengths} — it may be a part cut from this.`;
    }

    if (copy.coverUrl === null) {
        return "No picture yet to judge it by.";
    }

    return null;
};
