import { z } from "zod";

import {
    AuthorizationError,
    ValidationError,
    describesUnreadableSource,
    failureReason,
    findStage,
    type EmptyTrashResponse,
    type PurgeUnreadableInput,
    type UnreadableItem,
    type UnreadablePage,
    type UnreadableQuery,
} from "@private-stock/core";
import { stageRepo, trashRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";

/**
 * Files the pipeline cannot read, and clearing them out (§10g).
 *
 * **Admin only.** The list spans libraries, and what it offers is a decision about which of the
 * library's files to destroy -- the same reason the duplicates review is an administrator's.
 * Moving to the trash goes through the bulk action, so it also needs the `delete` permission
 * and a writable library, decided where every other deletion is decided.
 */

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can review unreadable files");
    }
};

/** The stage whose settled failure means "cannot be read". */
const probeStage = () => {
    const stage = findStage("probe");

    if (!stage) {
        throw new Error("The probe stage is missing from the registry");
    }

    return stage;
};

const cursorSchema = z.object({ bytes: z.number(), mediaId: z.string() });

const encodeCursor = (value: stageRepo.SettledFailureCursor): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/** A cursor that does not decode is refused rather than read as "start again" (page one twice). */
const decodeCursor = (cursor: string | undefined): stageRepo.SettledFailureCursor | null => {
    if (cursor === undefined) {
        return null;
    }

    try {
        const parsed = cursorSchema.safeParse(
            JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
        );

        if (parsed.success) {
            return parsed.data;
        }
    } catch {
        // Falls through to the refusal below.
    }

    throw new ValidationError("That page of results is no longer valid; reload the list");
};

const toItem = (row: stageRepo.SettledFailureRow): UnreadableItem => ({
    mediaId: row.mediaId,
    title: row.title,
    rootLabel: row.rootLabel,
    relPath: row.relPath,
    bytes: row.bytes,
    reason: failureReason(row.detail),
    corrupt: row.detail !== null && describesUnreadableSource(row.detail),
    failedAt: row.at,
    writable: row.writable === 1,
    moving: row.moving === 1,
});

export const listUnreadable = (query: UnreadableQuery, auth: AuthContext): UnreadablePage => {
    requireAdmin(auth);

    const stage = probeStage();
    const filter = { place: query.tab, rootIds: auth.accessibleRootIds };
    const page = stageRepo.listSettledFailures(
        stage,
        filter,
        decodeCursor(query.after),
        query.limit
    );

    return {
        items: page.rows.map(toItem),
        next: page.next ? encodeCursor(page.next) : null,
        summary: stageRepo.summarizeSettledFailures(stage, filter),
    };
};

/**
 * Purges unreadable files already in the trash, ahead of the bin's retention window (§10g).
 *
 * Only those -- the selection is re-read with the list's own rules, so an id for an item that
 * was restored, purged, or never unreadable is passed over rather than trusted. The rest of
 * the bin keeps its window; this is not a second "empty trash".
 *
 * **An entry whose move has not finished is left**, as `emptyTrash` leaves one: its original is
 * still in the media root, and purging it would delete the catalogue row and leave the file
 * for the next scan to adopt as something new. Those are counted as waiting.
 */
export const purgeUnreadable = (
    input: PurgeUnreadableInput,
    auth: AuthContext
): EmptyTrashResponse => {
    requireAdmin(auth);

    const { rows } = stageRepo.listSettledFailures(
        probeStage(),
        { place: "trash", rootIds: auth.accessibleRootIds, mediaIds: input.mediaIds },
        null,
        input.mediaIds.length
    );

    let queued = 0;
    let waiting = 0;
    let freedBytes = 0;

    for (const row of rows) {
        if (row.moving === 1 || !row.entryId) {
            waiting += 1;
            continue;
        }

        trashRepo.enqueueMove("purge", row.entryId, row.mediaId, row.fileId);
        queued += 1;
        freedBytes += row.bytes;
    }

    return { queued, waiting, freedBytes };
};
