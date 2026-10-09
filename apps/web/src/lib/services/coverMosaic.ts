import { mediaRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { coverUrl } from "./artService";

/**
 * The face on a collection's card: a playlist, a reel or a saved view (§14b, §14c, §14d).
 *
 * All three draw a few candidate ids each and keep the first that this viewer may see and that
 * have artwork. Written once because it had been written twice already, word for word, and a
 * third copy for views was the point at which the reasoning below would start to drift.
 */

/** Thumbnails on a card. Four reads as a mosaic; more reads as a grid. */
export const COVER_COUNT = 4;

/**
 * Thumbnails in a row's strip (§14c) -- as many as a wide screen shows whole. A collection that
 * can be shown as a row asks for these, and its card uses the first `COVER_COUNT`.
 */
export const STRIP_COUNT = 8;

/**
 * How many candidates to draw for every cover wanted.
 *
 * A candidate can fail to produce a cover twice over -- it sits in a library this viewer cannot
 * reach, or its artwork has not been generated yet -- and a card with one thumbnail and three
 * gaps looks broken rather than sparse. Drawing wider costs one indexed lookup and is the
 * difference between a full mosaic and a ragged one on a freshly scanned library.
 */
const COVER_OVERSAMPLE = 3;

/** How many candidate ids a caller should draw for `count` covers. */
export const coverCandidates = (count: number = COVER_COUNT): number => count * COVER_OVERSAMPLE;

/**
 * Up to `count` cover URLs per card, from each card's candidate ids, in the order they came.
 *
 * One media query for every card rather than one per card, so the cost of a page of cards is
 * not the number of cards on it.
 *
 * Access is applied by `listByIds`, exactly as it is for the items themselves -- listable,
 * accessible, not hidden. A thumbnail is a disclosure, so a shared collection reaching into a
 * library this account cannot see shows that viewer nothing of it: not a placeholder, not a
 * blurred one.
 */
export const coverMosaics = (
    candidates: ReadonlyArray<readonly [cardId: string, mediaIds: string[]]>,
    auth: AuthContext,
    count: number = COVER_COUNT
): Map<string, string[]> => {
    const visible = new Map(
        mediaRepo
            .listByIds(
                [...new Set(candidates.flatMap(([, ids]) => ids))],
                auth.userId,
                auth.accessibleRootIds
            )
            .map((row) => [row.id, coverUrl(row.id, row.coverPath, row.coverGeneratedAt)])
    );

    return new Map(
        candidates.map(([cardId, ids]) => [
            cardId,
            ids
                .map((id) => visible.get(id))
                .filter((url): url is string => Boolean(url))
                .slice(0, count),
        ])
    );
};
