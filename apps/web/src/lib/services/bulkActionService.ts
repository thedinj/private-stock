import type { BulkActionFailure, BulkActionInput, BulkActionResult } from "@private-stock/core";
import {
    changeLogRepo,
    db,
    mediaRepo,
    searchRepo,
    tagRepo,
    userMediaRepo,
} from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { notThem } from "./notThem";
import { writesTo } from "./tagService";
import { trashMedia } from "./trashService";

/**
 * Doing one thing to a set somebody ticked (§14b).
 *
 * The counterpart to bulk tagging (§5d) and deliberately not the same shape. That one takes
 * a filter, so it needs a preview, an exclusion list and a withdrawable batch — nobody can
 * see what a filter matches. This takes ids off a screen, so the preview *is* the screen and
 * none of that machinery applies.
 *
 * **Partial success is the normal outcome, not an error.** A selection can span a writable
 * root and a read-only one, or contain something already in the bin. Refusing the whole
 * action because one item could not be deleted would make the feature useless on exactly the
 * mixed libraries it is for; reporting "some of this failed" without saying which leaves the
 * person to find out by inspection. So every verb answers per item.
 */

/** Items this viewer may actually see, in the order they were asked about. */
const visible = (mediaIds: string[], auth: AuthContext): Set<string> =>
    new Set(
        mediaRepo.listByIds(mediaIds, auth.userId, auth.accessibleRootIds).map((row) => row.id)
    );

/**
 * Runs one item's work and records the outcome rather than letting it end the run.
 *
 * The message comes from the typed error's own text, which every service here writes for a
 * person to read (`ReadOnlyRootError`, `ConflictError`). An unrecognised throw is reported as
 * a plain failure rather than surfaced: a bulk action is not the place to leak a stack, and
 * the item is named regardless so nothing disappears silently.
 */
const attempt = async (
    mediaId: string,
    work: () => Promise<unknown> | unknown,
    failures: BulkActionFailure[]
): Promise<boolean> => {
    try {
        await work();

        return true;
    } catch (error) {
        failures.push({
            mediaId,
            reason: error instanceof Error && error.message ? error.message : "Could not be done",
        });

        return false;
    }
};

export const applyBulkAction = async (
    input: BulkActionInput,
    auth: AuthContext
): Promise<BulkActionResult> => {
    const allowed = visible(input.mediaIds, auth);
    const failed: BulkActionFailure[] = [];

    /**
     * An item the viewer cannot see is reported as missing, exactly as a single-item request
     * would report it — never skipped silently, and never distinguished from one that does
     * not exist. Both answers would tell somebody that an id is real in a library they were
     * not granted.
     */
    const targets = input.mediaIds.filter((mediaId) => {
        if (allowed.has(mediaId)) return true;

        failed.push({ mediaId, reason: "Media not found" });

        return false;
    });

    let succeeded = 0;

    if (input.action === "tag") {
        /**
         * Which of the two systems, from the request (§6). Resolved once for the whole
         * action rather than per item, so a selection cannot end up half in each.
         */
        const scope = writesTo(input.scope, auth);

        const tagIds = input.names.map((name) =>
            tagRepo.ensureTag(input.kind, name, scope, auth.userId)
        );

        // One transaction: a half-applied tagging is a set nobody can describe afterwards,
        // and unlike trashing there is no filesystem work to make that unavoidable.
        succeeded = db.transaction(() => {
            let changed = 0;

            for (const mediaId of targets) {
                for (const tagId of tagIds) {
                    tagRepo.assign({
                        mediaId,
                        tagId,
                        userId: scope,
                        createdById: auth.userId,
                        source: "user",
                    });
                }

                changed += 1;
                // In the same transaction as the change it describes (§13b): a change
                // that commits without its notification leaves every open grid stale.
                changeLogRepo.record({
                    entity: "media",
                    entityId: mediaId,
                    op: "update",
                    detail: `tags:${input.kind}`,
                });
            }

            return changed;
        })();

        searchRepo.requestReindex(targets);

        return { succeeded, failed };
    }

    if (input.action === "untag") {
        /**
         * Resolved to tags that already exist, and to nothing else.
         *
         * The removal used to take typed names, which it passed through `ensureTag` *before*
         * consulting the mode -- so untagging a name the library had never heard of coined it
         * and then removed nothing. Taking ids makes that unsayable rather than merely
         * unlikely: there is no name here to create.
         */
        const tags = input.tagIds
            .map((tagId) => tagRepo.findById(tagId))
            .filter((tag): tag is NonNullable<typeof tag> => tag !== undefined)
            /**
             * Somebody else's private tag is skipped, not refused.
             *
             * It cannot appear in the listing these ids come from, so reaching one means a
             * hand-written request — and the answer to that is the same as every other read of
             * a private tag: it is not there (§6).
             */
            .filter((tag) => tag.ownerId === null || tag.ownerId === auth.userId);

        succeeded = db.transaction(() => {
            let changed = 0;

            for (const mediaId of targets) {
                let touched = false;

                for (const tag of tags) {
                    /**
                     * `tag.ownerId` says which system to delete from, and the request does not
                     * get a say. A scope on the wire could take the library's assignment off an
                     * item while the person believed they were removing their own copy.
                     */
                    if (tagRepo.unassign(mediaId, tag.id, tag.ownerId) > 0) {
                        touched = true;
                        notThem([mediaId], tag.id, auth.userId);
                    }
                }

                if (touched) {
                    changed += 1;
                    changeLogRepo.record({
                        entity: "media",
                        entityId: mediaId,
                        op: "update",
                        // No facet: a removal can span them, and only artifact changes read
                        // this field for anything.
                        detail: "tags",
                    });
                }
            }

            return changed;
        })();

        searchRepo.requestReindex(targets);

        return { succeeded, failed };
    }

    if (input.action === "rate" || input.action === "favorite") {
        // No transaction and no ChangeLog: this is one viewer's private state, and
        // broadcasting it would push their rating into everybody else's open grid (§13b).
        for (const mediaId of targets) {
            if (input.action === "rate") {
                userMediaRepo.setRating(auth.userId, mediaId, input.rating);
            } else {
                userMediaRepo.setFavorite(auth.userId, mediaId, input.favorite);
            }

            succeeded += 1;
        }

        return { succeeded, failed };
    }

    /**
     * Trashing, one at a time and on purpose.
     *
     * Each one copies bytes to `/data`, fsyncs and unlinks (§10), so there is no transaction
     * that could cover the set — and batching them would only make a mid-run failure harder
     * to describe. Sequential rather than concurrent because the free-space check each
     * performs is only meaningful if the previous copy has already landed.
     */
    for (const mediaId of targets) {
        if (await attempt(mediaId, () => trashMedia(mediaId, auth), failed)) {
            succeeded += 1;
        }
    }

    return { succeeded, failed };
};
