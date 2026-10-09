import { isBusyError, jobRepo, ocrTagMatchRepo } from "@private-stock/db";

/**
 * What the rest of tagging owes the OCR match queue (§5d "Tagging performers and sources from
 * what was read").
 *
 * Its own module, using repos only, because the services that change tags are the ones the
 * match service itself calls: importing the match service from them would go round in a circle.
 */

/** The facets OCR text is matched against. */
const MATCHED_KINDS = new Set(["performer", "source"]);

/**
 * How long a rematch waits after the vocabulary changes. Somebody working down the queue coins a
 * name every minute or two, and each used to start a full rematch at once; a window this long
 * folds a burst into one run, and the worker re-checks the vocabulary when a run ends, so a name
 * coined while one is running is never missed.
 */
const REMATCH_DELAY_SECONDS = 15;

const matters = (kind: string, ownerId: string | null): boolean =>
    ownerId === null && MATCHED_KINDS.has(kind);

/**
 * Store these pairs' pending counts, **after** the change that moved them has committed.
 *
 * A busy database is not the request's failure: the decision it followed has landed, and
 * answering 503 would invite somebody to make it twice. The count is left as it was until the
 * next recount of the pair or the worker's `ocrMatch` pass, which recounts every pair; until then
 * the review page, which draws rows from live counts, shows the truth anyway (§5d "Counts").
 */
export const recountAfterCommit = (matchIds: string[]): void => {
    if (matchIds.length === 0) {
        return;
    }

    try {
        ocrTagMatchRepo.recountPending(matchIds);
    } catch (error) {
        if (!isBusyError(error)) {
            throw error;
        }

        console.warn(
            `[ocrMatch] database busy: ${matchIds.length} pending count(s) left for the next recount`
        );
    }
};

/**
 * A performer or source name was coined, renamed, aliased, merged, published or unpublished:
 * every string may now name somebody it did not. The job does nothing when the vocabulary is the
 * one it last matched against, so asking is cheap, and asking again while one waits is free.
 */
export const vocabularyChanged = (kind: string, ownerId: string | null): void => {
    if (matters(kind, ownerId)) {
        jobRepo.enqueueKind("ocrMatch", 150, REMATCH_DELAY_SECONDS);
    }

    // Which tags every item's own text names (§5b "One rule for names") moves with any name, in
    // any facet and anybody's vocabulary: Find untagged asks it of every tag. Same job shape --
    // nothing happens when the vocabulary is the one last matched against.
    jobRepo.enqueueKind("mentionMatch", 150, REMATCH_DELAY_SECONDS);
};

/**
 * These items gained or lost performer or source tags, so the pairs of those tags for strings the
 * items show are owed a different number of them. `tagIds` null when the caller cannot say which
 * tags moved, which recounts every pair of the items' strings.
 *
 * A tag somebody took off is also declined for every rule that would apply it, so that reading
 * the item again does not put it back (§5d "An accepted pair is a rule"). A busy database leaves
 * that undone, as it leaves a count: the tag stays off until the item is read again.
 *
 * **Call it after the tagging transaction commits**: the recount reads outside the write lock.
 */
export const tagsChangedOn = (
    mediaIds: string[],
    kind: string,
    ownerId: string | null,
    tagIds: string[] | null
): void => {
    if (!matters(kind, ownerId) || mediaIds.length === 0) {
        return;
    }

    try {
        ocrTagMatchRepo.declineRules(mediaIds, tagIds, kind);
    } catch (error) {
        if (!isBusyError(error)) {
            throw error;
        }

        console.warn(`[ocrMatch] database busy: rules not declined for ${mediaIds.length} item(s)`);
    }

    recountAfterCommit(ocrTagMatchRepo.pairsTouching(mediaIds, tagIds));
};

/**
 * A bulk-tag batch was withdrawn. An OCR accept is one, so a pair it accepted goes back to
 * waiting for a decision, from whichever screen the undo came; and its items are owed its tags
 * again, whichever facet the batch was.
 */
export const batchUndone = (batchId: string, mediaIds: string[], tagIds: string[]): void => {
    const reopened = ocrTagMatchRepo.reopenForBatch(batchId);

    recountAfterCommit([...reopened, ...ocrTagMatchRepo.pairsTouching(mediaIds, tagIds)]);
};
