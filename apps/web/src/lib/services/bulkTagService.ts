import {
    BULK_SELECTION_LIMIT,
    ConflictError,
    NotFoundError,
    ValidationError,
    type BulkTagApplyInput,
    type BulkTagPreviewInput,
    type BulkTagPreviewResult,
    type BulkTagResult,
    type SavedQuery,
    type TagBatch,
} from "@private-stock/core";
import { mediaRepo, searchRepo, tagBatchRepo, tagRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { batchUndone, tagsChangedOn, vocabularyChanged } from "./ocrMatchHooks";
import { overlayForRequest } from "./savedFilterService";
import { writesTo } from "./tagService";

/**
 * Tagging a filtered set, and taking it back (§5d).
 *
 * On a library whose filenames are unreliable this is the fastest route from 200k untagged
 * items to a usable collection, and it is also the only action in the app that can be wrong
 * about tens of thousands of items at once. Everything below is one of the three properties
 * that makes it safe to attempt:
 *
 * - **A preview before committing** — the count is answered by the same query that will do
 *   the work, not estimated.
 * - **Per-item exclusion** — the filter approximates intent; the exclusions correct it.
 * - **Scoped undo** — a batch withdraws exactly the rows it wrote.
 *
 * No `ChangeLog` entries are recorded. Tags are not shown on a grid tile, so there is nothing
 * for an open grid to patch, and ten thousand entries in a table that is read every second
 * would cost every other client far more than the update is worth (§13b).
 */

/**
 * Ids the filter matches, minus the ones the caller struck out.
 *
 * The stored query carries no page — a filter is a way of looking, not a position — so one is
 * supplied here. It is always the first: this walks the whole matching set at once rather than
 * paging through it.
 */
const targetIds = (
    query: SavedQuery,
    excludeIds: string[],
    auth: AuthContext,
    filterId?: string | null
): { matched: string[]; kept: string[] } => {
    // One over the limit, so "more than we will act on" is a fact rather than a guess about
    // whether a full page means there is more behind it.
    const matched = mediaRepo.listMediaIds(
        { ...query, page: 0 },
        auth.userId,
        auth.accessibleRootIds,
        BULK_SELECTION_LIMIT + 1,
        // Whose ratings, decided exactly as it was for the grid the person is looking at.
        overlayForRequest(filterId ?? null, query, auth)
    );

    const excluded = new Set(excludeIds);

    return { matched, kept: matched.filter((id) => !excluded.has(id)) };
};

/**
 * How many items would be affected.
 *
 * `countMedia` would answer the first half more cheaply, but not the second: exclusions are
 * ids, and subtracting `excludeIds.length` would over-count the moment one of them no longer
 * matches the filter. The preview has to be the number that will actually be written, or it
 * is not a preview.
 */
export const previewBulkTag = (
    input: BulkTagPreviewInput,
    auth: AuthContext
): BulkTagPreviewResult => {
    const { matched, kept } = targetIds(input.query, input.excludeIds, auth, input.filterId);
    const overLimit = matched.length > BULK_SELECTION_LIMIT;

    return {
        matched: matched.length,
        affected: overLimit ? 0 : kept.length,
        overLimit,
        limit: BULK_SELECTION_LIMIT,
    };
};

const describe = (kind: string, names: string[], count: number): string =>
    `Tagged ${count} item${count === 1 ? "" : "s"} ${kind}: ${names.join(", ")}`;

export const toTagBatch = (row: tagBatchRepo.TagBatchRow): TagBatch => ({
    id: row.id,
    summary: row.summary,
    mediaCount: row.mediaCount,
    clipCount: row.clipCount,
    createdAt: row.createdAt,
    undoneAt: row.undoneAt,
});

export const applyBulkTag = (input: BulkTagApplyInput, auth: AuthContext): BulkTagResult => {
    const { matched, kept } = targetIds(input.query, input.excludeIds, auth, input.filterId);

    if (matched.length > BULK_SELECTION_LIMIT) {
        throw new ValidationError(
            `That filter matches more than ${BULK_SELECTION_LIMIT.toLocaleString()} items. ` +
                `Narrow it before tagging.`
        );
    }

    /**
     * The library moved between the preview and the apply.
     *
     * Refused rather than reconciled. "Added this week" means something different ten minutes
     * later, and tagging more items than the number a person agreed to is the exact accident
     * the preview exists to prevent — so the correct answer is to show them the new number
     * and let them agree to that one instead.
     */
    if (kept.length !== input.expectedCount) {
        throw new ConflictError(
            `This filter now matches ${kept.length} items rather than ${input.expectedCount}. ` +
                `Check the preview and try again.`
        );
    }

    if (kept.length === 0) {
        throw new ValidationError("Nothing to tag");
    }

    /**
     * Same rule as tagging one item: an administrator writes the library's vocabulary, and
     * anybody else's bulk apply is theirs alone (§6). A bulk operation is the one where
     * getting this wrong is worst -- it is thousands of rows, and the undo is the only way
     * back.
     */
    const scope = writesTo(input.scope, auth);
    const coins = input.names.some((name) => !tagRepo.resolveName(input.kind, name, scope));

    const tagIds = input.names.map((name) =>
        tagRepo.ensureTag(input.kind, name, scope, auth.userId)
    );

    const { batchId, assigned } = tagBatchRepo.apply({
        userId: auth.userId,
        scope,
        summary: describe(input.kind, input.names, kept.length),
        mediaIds: kept,
        tagIds,
    });

    searchRepo.requestReindex(kept);
    tagsChangedOn(kept, input.kind, scope, tagIds);

    if (coins) {
        vocabularyChanged(input.kind, scope);
    }

    const batch = tagBatchRepo.findById(batchId, auth.userId);

    if (!batch) {
        throw new NotFoundError("Batch not found");
    }

    return { batch: toTagBatch(batch), assigned };
};

/**
 * Batches this caller can withdraw (§6).
 *
 * Yours, plus every **public** batch when you are an administrator — which is exactly the set
 * `undoBulkTag` already accepts. Until now it accepted more than it listed: an administrator
 * could withdraw somebody else's public apply and had no way to find one, so the capability
 * existed only for whoever could guess an id.
 *
 * Private batches stay absent whoever is asking. A summary reading "Tagged 4,000 items tag:
 * therapy" is itself the disclosure the private system exists to prevent.
 */
/**
 * One row per batch, newest kept.
 *
 * An administrator's own public batch appears in both halves of the union above, and a list
 * offering the same withdrawal twice reads as two different things having happened.
 */
const dedupeById = (batches: tagBatchRepo.TagBatchRow[]): tagBatchRepo.TagBatchRow[] =>
    [...new Map(batches.map((batch) => [batch.id, batch])).values()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt)
    );

export const listTagBatches = (auth: AuthContext, limit = 20): TagBatch[] =>
    dedupeById([
        ...tagBatchRepo.listForUser(auth.userId, limit),
        ...(auth.scopes.includes("admin") ? tagBatchRepo.listPublic(limit) : []),
    ]).map(toTagBatch);

/**
 * Withdraws a bulk apply.
 *
 * Yours always; anybody's **public** batch if you are an administrator (§6). A private batch
 * stays its owner's alone, administrators included, exactly as a private tag does.
 *
 * The widening is new and is not tidiness. While a non-admin's bulk apply was necessarily
 * private, an owner-only undo was sufficient -- nobody else could see the damage. Now that
 * anyone can publish `BULK_SELECTION_LIMIT` assignments in one gesture, an administrator who
 * cannot withdraw them is the one accident in the app with no remedy at all.
 */
export const undoBulkTag = (batchId: string, auth: AuthContext): { removed: number } => {
    const batch = tagBatchRepo.findById(batchId, auth.userId, auth.scopes.includes("admin"));

    if (!batch) {
        throw new NotFoundError("Batch not found");
    }

    if (batch.undoneAt) {
        throw new ConflictError("That batch has already been withdrawn");
    }

    // Collected before the delete, because afterwards there is nothing left to say which
    // items need their search document rebuilding.
    const affected = tagBatchRepo.affectedMediaIds(batchId);
    const tagIds = tagBatchRepo.affectedTagIds(batchId);
    const removed = tagBatchRepo.undo(batchId);

    searchRepo.requestReindex(affected);
    batchUndone(batchId, affected, tagIds);

    return { removed };
};
