import {
    EMPTY_OVERLAY,
    mergeOverlay,
    overlayEquals,
    preferredKeep,
    type UserOverlay,
} from "@private-stock/core";
import {
    changeLogRepo,
    db,
    dupeRepo,
    playlistRepo,
    searchRepo,
    tagRepo,
    userMediaRepo,
    type OverlayRow,
} from "@private-stock/db";

/**
 * What a departing copy leaves to the copy that outlives it (§10c).
 *
 * §10 settled that a *file* can be deleted without losing the catalog entry. This settles the
 * other half: that eliminating a duplicate does not lose what people recorded about it. The
 * rating, the note, the tags and the playlist slot belong to the content, not to the
 * particular file somebody happened to delete, so they follow the content.
 *
 * **Nobody is asked anything.** Every conflict resolves by rule (`mergeOverlay` in
 * `@private-stock/core` argues each one), and the rules are chosen so that removing a copy
 * can only ever add to what is left. A dialogue asking which of two view counts is the real
 * one would be a question with no informative answer, asked at the moment somebody is
 * thinking about disk space.
 *
 * **It runs on the way to the trash, not at purge.** Waiting for the retention window would
 * mean a rating vanishing at the delete and reappearing a week later on a different item,
 * which is indistinguishable from a bug. Running now costs nothing: everything but the
 * playlist slot is copied rather than moved, so the departing item keeps its own record and a
 * restore still returns it intact (§10).
 */

/** The heir, and how much actually moved. Nothing moved is reported as a merge of zeroes. */
export interface MergeOutcome {
    heirId: string;
    /** Viewers whose record of the surviving copy changed — usually one, sometimes nobody. */
    overlays: number;
    tags: number;
    /** Playlists in which the survivor took the departing copy's place. */
    playlists: number;
}

const overlayOf = (rows: OverlayRow[], userId: string): UserOverlay =>
    rows.find((row) => row.userId === userId) ?? EMPTY_OVERLAY;

/**
 * Folds one item's user data into the best of its surviving duplicates.
 *
 * Returns null when the item is not a duplicate of anything that still has a file — the
 * ordinary case for most deletions, and the reason this is cheap enough to sit on the delete
 * path unconditionally.
 *
 * The heir is `preferredKeep` over the surviving copies: the same function that marks "Best
 * copy" on the review screen, so what inherits is what the app already told the reviewer to
 * keep. Picking one heir rather than spraying the data across every survivor is what makes a
 * chain work — eliminate the heir later and its inheritance, now its own, moves on again.
 */
export const mergeIntoSurvivingCopy = (mediaId: string): MergeOutcome | null => {
    const siblings = dupeRepo.activeSiblings(mediaId);
    const heirId = preferredKeep(siblings);

    if (!heirId || heirId === mediaId) {
        return null;
    }

    // `immediate`: it reads both overlays before writing, and a deferred transaction's upgrade to
    // a write lock is refused outright if the worker committed in between (see `trashRepo`).
    const outcome = db
        .transaction((): MergeOutcome => {
            const departing = userMediaRepo.listOverlays(mediaId);
            const heirRows = userMediaRepo.listOverlays(heirId);

            let overlays = 0;

            for (const row of departing) {
                const merged = mergeOverlay(overlayOf(heirRows, row.userId), row);

                // A viewer who rated both copies the same leaves nothing behind, and writing the
                // row anyway would move its `updatedAt` for no reason anybody could point at.
                if (overlayEquals(merged, overlayOf(heirRows, row.userId))) {
                    continue;
                }

                userMediaRepo.writeOverlay(row.userId, heirId, merged);
                overlays += 1;
            }

            const tags = tagRepo.copyAssignments(mediaId, heirId);
            const playlists = playlistRepo.repointItems(mediaId, heirId);

            if (overlays > 0 || tags > 0 || playlists > 0) {
                // In the same transaction as the change it describes (§13b): the heir's tile now
                // carries a rating and tags it did not have, and an open grid has no other way to
                // learn that.
                changeLogRepo.record({
                    entity: "media",
                    entityId: heirId,
                    op: "update",
                    detail: "merge:duplicate",
                });
            }

            return { heirId, overlays, tags, playlists };
        })
        .immediate();

    if (outcome.tags > 0) {
        // Outside the transaction, like every other tag write: the document is rebuilt by the
        // worker, and only library-wide tags reach it (§5c).
        searchRepo.requestReindex([heirId]);
    }

    return outcome;
};
