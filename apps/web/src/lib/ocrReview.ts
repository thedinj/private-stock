import type { OcrQueueItem, OcrReviewState } from "@private-stock/core";

/**
 * OCR's bookkeeping on the client (§5d): what a list looks like after an action, worked out
 * locally so the rows on screen change at once instead of waiting for the list to come back.
 *
 * Each rule mirrors what the server does, and says where.
 */

/** What a finding line in the details drawer reports after it changed. */
export type FindingChange =
    | { kind: "state"; reviewState: OcrReviewState | null; text: string }
    | { kind: "edit"; text: string; reviewState: OcrReviewState };

export type QueueDecision =
    | { kind: "accept"; mediaId: string; matchIds: string[]; excluded: string[] }
    | { kind: "reject"; mediaId: string; matchIds: string[] }
    | { kind: "skip"; mediaId: string; matchIds: string[] };

/**
 * The queue after a decision about some pairs, as `ocrMatchService` leaves it.
 *
 * - **Accept** decides the pairs everywhere, and tags their tags on every item that showed one
 *   and was not left out, which settles every other pair of those tags on those items.
 * - **Reject** decides the pairs everywhere and tags nothing.
 * - **Skip** leaves this one item out; the pairs stay open elsewhere, each owed one item fewer.
 *
 * An item with nothing left to decide leaves the list. Counts on pairs this cannot see the effect
 * on (another string, same tag, items in common) are left as they were; the list is fetched
 * again behind this, and an accept against a stale count is refused and says so.
 */
export const applyQueueDecision = (
    items: OcrQueueItem[],
    decision: QueueDecision
): OcrQueueItem[] => {
    const decided = new Set(decision.matchIds);
    const excluded = new Set(decision.kind === "accept" ? decision.excluded : []);

    return items.flatMap((item) => {
        const candidates = item.strings.flatMap((string) => string.candidates);
        const own = item.mediaId === decision.mediaId;

        // The tags this decision put on this item.
        const tagged = new Set(
            decision.kind === "accept" && (own || !excluded.has(item.mediaId))
                ? candidates
                      .filter((candidate) => decided.has(candidate.matchId))
                      .map((candidate) => candidate.tagId)
                : []
        );

        const strings = item.strings.flatMap((string) => {
            const left = string.candidates.flatMap((candidate) => {
                if (decision.kind === "skip") {
                    if (!decided.has(candidate.matchId)) {
                        return [candidate];
                    }

                    return own ? [] : [{ ...candidate, untagged: candidate.untagged - 1 }];
                }

                return decided.has(candidate.matchId) || tagged.has(candidate.tagId)
                    ? []
                    : [candidate];
            });

            return left.length === 0 ? [] : [{ ...string, candidates: left }];
        });

        return strings.length === 0 ? [] : [{ ...item, strings }];
    });
};
