import {
    ConflictError,
    NotFoundError,
    ValidationError,
    domainKindSchema,
    type ItemReview,
    type ReviewPass,
} from "@private-stock/core";
import { mediaRepo, reviewPassRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { clearLibraryCaches } from "./libraryService";
import { roomOf } from "./room";

/**
 * Review passes and their marks, and who may touch them (§14d "Reviewing recordings for a
 * reel").
 *
 * **Only the owner**, for reading as for writing: a pass is somebody's question about the
 * library, and its marks are their decisions. Somebody else's pass reads as missing rather than
 * forbidden, so an id does not confirm it exists -- the posture a private tag takes (§6).
 *
 * **A pass is one room's.** It is made in the request's room, and its marks go only on items of
 * that room: a Cellar pass on a Game Room recording is refused as tags across rooms are (§21).
 */

const toPass = (row: reviewPassRepo.ReviewPassListRow): ReviewPass => ({
    id: row.id,
    name: row.name,
    // Rows are written with the request's room, so this only fails on a hand-edited database.
    domain: domainKindSchema.parse(row.domain),
    marks: row.marks,
});

/** The caller's own pass, or not-found -- for somebody else's exactly as for none at all. */
const ownedPass = (passId: string, auth: AuthContext): reviewPassRepo.ReviewPassRow => {
    const pass = reviewPassRepo.findById(passId);

    if (!pass || pass.ownerId !== auth.userId) {
        throw new NotFoundError("Review pass not found");
    }

    return pass;
};

/**
 * Refuses marks across rooms (§21). An item whose original is gone has no room to compare and
 * is let through, as tags let it.
 */
const assertSameRoom = (pass: reviewPassRepo.ReviewPassRow, mediaIds: string[]): void => {
    const rooms = reviewPassRepo.itemDomains(mediaIds);

    if (mediaIds.some((mediaId) => (rooms.get(mediaId) ?? pass.domain) !== pass.domain)) {
        throw new ValidationError("That review pass belongs to another room");
    }
};

const assertNameFree = (auth: AuthContext, domain: string, name: string, except?: string): void => {
    const clash = reviewPassRepo.findByName(auth.userId, domain, name);

    if (clash && clash.id !== except) {
        throw new ConflictError(`You already have a review pass called ${clash.name} here`);
    }
};

const passOut = (passId: string, auth: AuthContext): ReviewPass => {
    const row = reviewPassRepo
        .listForOwner(auth.userId, null)
        .find((candidate) => candidate.id === passId);

    if (!row) {
        throw new NotFoundError("Review pass not found");
    }

    return toPass(row);
};

/**
 * The caller's passes in the request's room, or in every room for the Account page's card.
 * A handful each, so never paged.
 */
export const listPasses = (auth: AuthContext, rooms: "here" | "all"): ReviewPass[] =>
    reviewPassRepo.listForOwner(auth.userId, rooms === "all" ? null : roomOf(auth)).map(toPass);

export const createPass = (name: string, auth: AuthContext): ReviewPass => {
    const domain = roomOf(auth);

    assertNameFree(auth, domain, name);

    return passOut(reviewPassRepo.create(auth.userId, domain, name), auth);
};

export const renamePass = (passId: string, name: string, auth: AuthContext): ReviewPass => {
    const pass = ownedPass(passId, auth);

    assertNameFree(auth, pass.domain, name, pass.id);
    reviewPassRepo.rename(pass.id, name);

    return passOut(pass.id, auth);
};

/** Deletes a pass and every mark it holds, returning how many marks went. */
export const deletePass = (passId: string, auth: AuthContext): { marks: number } => {
    const marks = reviewPassRepo.remove(ownedPass(passId, auth).id);

    // A view filtered by the pass changes what it holds, and kept orders hold it (§20).
    if (marks > 0) clearLibraryCaches();

    return { marks };
};

/** The caller's passes an item has been through, for the item page's chips. */
export const itemReviews = (mediaId: string, auth: AuthContext): ItemReview[] =>
    reviewPassRepo.marksFor(auth.userId, mediaId);

/**
 * Marks one item for a pass, or takes the mark off, and answers with the item's marks.
 *
 * The item is looked for the way the library looks, so marking an id in a library this account
 * was never granted reports it missing rather than attaching a decision to it.
 */
export const setItemMark = (
    mediaId: string,
    input: { passId: string; reviewed: boolean },
    auth: AuthContext
): ItemReview[] => {
    if (!mediaRepo.findDetail(mediaId, auth.userId, auth.accessibleRootIds)) {
        throw new NotFoundError("Media not found");
    }

    markItems([mediaId], input.passId, input.reviewed, auth);

    return itemReviews(mediaId, auth);
};

/**
 * Marks items the caller has already been checked against, or takes the marks off, returning
 * how many changed. Shared by the item page and the selection bar (`bulkActionService`), which
 * does its own visibility check per item.
 */
export const markItems = (
    mediaIds: string[],
    passId: string,
    reviewed: boolean,
    auth: AuthContext
): number => {
    const pass = ownedPass(passId, auth);

    assertSameRoom(pass, mediaIds);

    const changed = reviewed
        ? reviewPassRepo.mark(pass.id, mediaIds)
        : reviewPassRepo.unmark(pass.id, mediaIds);

    // A "Not yet reviewed for" view is walked while it shrinks, and its count and order are
    // cached (§20).
    if (changed > 0) clearLibraryCaches();

    return changed;
};
