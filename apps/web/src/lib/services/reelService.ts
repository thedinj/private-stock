import {
    AuthorizationError,
    NotFoundError,
    REEL_ITEM_LIMIT,
    ValidationError,
    reelNaturalDirection,
    type AddReelItemsInput,
    type CreateReelInput,
    type MoveReelItemInput,
    type Reel,
    type ReelEntry,
    type ReelItemsResponse,
    type ReelListResponse,
    type ReelQuery,
    type UpdateReelInput,
} from "@private-stock/core";
import { db, mediaRepo, reelRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { coverUrl } from "./artService";
import { clipsByIds, assertReelNameFree } from "./clipService";
import { coverCandidates, coverMosaics } from "./coverMosaic";
import { assertMayShare } from "./collectionAccess";
import { resolvePlaybackPlan } from "./mediaService";

/**
 * Reels, and who may do what to them (§14d).
 *
 * The same two rules as playlists and saved views, deliberately — readable by the owner or by
 * anybody once shared, writable **only** by the owner, `admin` included — because a reel is
 * shared by the same gesture and for the same reason (§14c). What a reel does not take is the
 * pin machinery: there is no `CollectionPin` row for one, no `resolvePin`, and no place in the
 * sidebar. Reels are numerous enough that a sidebar is the wrong container, so they have an
 * index of their own instead.
 *
 * The one rule that is this file's alone is the owner invariant: **a reel holds nothing but its
 * owner's clips.** `addReelItems` is where that is enforced, and almost everything that would
 * otherwise be difficult follows from it — a retime can name every reel it will reach, a
 * discard cannot shorten a stranger's work, and a span needs no author of its own because they
 * all belong to the person already named on the reel.
 */

/**
 * The card faces for a set of reels, sampled from across each one (§14b).
 *
 * Across rather than off the top, so the face is a glimpse of the whole reel and not of its
 * first item. One sample per reel and one shared lookup for all of them (`coverMosaics`).
 */
const coversFor = (rows: reelRepo.ReelSummaryRow[], auth: AuthContext): Map<string, string[]> =>
    coverMosaics(
        rows.map((row) => [row.id, reelRepo.sampleMediaIds(row.id, coverCandidates())] as const),
        auth
    );

const toReel = (row: reelRepo.ReelSummaryRow, auth: AuthContext, covers: string[]): Reel => ({
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    itemCount: row.itemCount,
    runningMs: row.runningMs,
    ownerName: row.ownerName,
    covers,
    editable: row.ownerId === auth.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

/**
 * A reel this viewer may see: their own, or one shared with the household.
 *
 * Reported as missing rather than forbidden, so the error cannot confirm that a reel with this
 * id exists — the house convention, and the same line `playlistService` draws.
 */
const readable = (reelId: string, auth: AuthContext): reelRepo.ReelRow => {
    const row = reelRepo.findById(reelId);

    if (!row || (row.ownerId !== auth.userId && row.visibility !== "shared")) {
        throw new NotFoundError("Reel not found");
    }

    return row;
};

/**
 * A reel this viewer may change, which is its owner and nobody else.
 *
 * **Not an administrator.** Sharing grants reading and never writing (§6): `admin` manages the
 * library, not other people's work, and there is no operational need to rearrange somebody's
 * cut.
 */
const writable = (reelId: string, auth: AuthContext): reelRepo.ReelRow => {
    const row = readable(reelId, auth);

    if (row.ownerId !== auth.userId) {
        throw new AuthorizationError("Only the owner can change this reel");
    }

    return row;
};

export const listReels = (query: ReelQuery, auth: AuthContext): ReelListResponse => {
    const direction = query.direction ?? reelNaturalDirection(query.sort);
    const rows = reelRepo.listVisibleTo(query, auth.userId, direction);
    const covers = coversFor(rows, auth);

    return {
        items: rows.map((row) => toReel(row, auth, covers.get(row.id) ?? [])),
        page: query.page,
        pageSize: query.limit,
        hasMore: rows.length === query.limit,
        total: reelRepo.countVisibleTo(query, auth.userId),
    };
};

export const getReel = (reelId: string, auth: AuthContext): Reel => {
    readable(reelId, auth);

    const row = reelRepo.findSummary(reelId)!;

    return toReel(row, auth, coversFor([row], auth).get(reelId) ?? []);
};

export const createReel = (input: CreateReelInput, auth: AuthContext): Reel => {
    assertReelNameFree(input.name, auth.userId);
    assertMayShare(input.visibility, "private", auth);

    const id = db.transaction((): string => {
        const created = reelRepo.create({
            ownerId: auth.userId,
            name: input.name,
            description: input.description ?? null,
            visibility: input.visibility,
        });

        if (input.clipIds?.length) {
            reelRepo.addItems(created, auth.userId, input.clipIds);
        }

        return created;
    })();

    return getReel(id, auth);
};

export const updateReel = (reelId: string, input: UpdateReelInput, auth: AuthContext): Reel => {
    const existing = writable(reelId, auth);

    if (input.name !== undefined) {
        assertReelNameFree(input.name, auth.userId, reelId);
    }

    assertMayShare(input.visibility, existing.visibility, auth);
    reelRepo.update(reelId, input);

    return getReel(reelId, auth);
};

export const deleteReel = (reelId: string, auth: AuthContext): void => {
    writable(reelId, auth);
    // No CollectionPin rows to clear: a reel is not pinnable (§14d).
    reelRepo.remove(reelId);
};

/**
 * The whole reel, in order, with everything the player needs to open each span.
 *
 * **Not paged.** A reel is played in one pass, and paging it would make the player ask a second
 * question part way through — the one moment it must not. `REEL_ITEM_LIMIT` is what makes that
 * promise affordable.
 *
 * `directPlay` is computed here rather than left to the client, and it is the reason this
 * returns entries rather than clip ids. §8b notes the verdict lives on an item's detail and not
 * on a list row, which is why stepping through the library fetches the next item's details
 * before warming anything; a reel cannot pay a round trip per span, and without the flag the
 * player has no way to know which span it may warm and which it must skip.
 *
 * Entries whose item this viewer cannot reach are dropped from `items` but stay in `total`, so
 * a shared reel cannot be used to probe for items in an inaccessible library and the page can
 * still say how much it is not showing.
 */
export const listReelEntries = (reelId: string, auth: AuthContext): ReelItemsResponse => {
    readable(reelId, auth);

    const entries = reelRepo.listEntries(reelId);
    const clips = clipsByIds(
        entries.map((entry) => entry.clipId),
        auth
    );

    const media = new Map(
        mediaRepo
            .listByIds(
                [...new Set(entries.map((entry) => entry.mediaId))],
                auth.userId,
                auth.accessibleRootIds
            )
            .map((row) => [row.id, row])
    );

    const items: ReelEntry[] = [];

    for (const entry of entries) {
        const clip = clips.get(entry.clipId);
        const row = media.get(entry.mediaId);

        if (!clip || !row) {
            continue;
        }

        const detail = mediaRepo.findDetail(row.id, auth.userId, auth.accessibleRootIds);

        items.push({
            id: entry.id,
            position: entry.position,
            clip,
            media: {
                id: row.id,
                title: row.title ?? "Untitled",
                coverUrl: coverUrl(row.id, row.coverPath, row.coverGeneratedAt),
                durationMs: row.durationMs,
                directPlay: detail ? resolvePlaybackPlan(detail).directPlay : false,
            },
        });
    }

    return {
        items,
        total: entries.length,
        runningMs: reelRepo.runningMs(reelId),
    };
};

/**
 * Adds spans to a reel, refusing any that are not the owner's.
 *
 * The owner invariant (§14d), stated where somebody would try to break it. Nothing in the UI
 * can reach this — `/clips` lists only your own — so it is a guard on the API surface rather
 * than a behaviour anyone meets. The repo filters on it too, in the insert itself, so the
 * invariant survives a second write path arriving later without this check.
 */
export const addReelItems = (
    reelId: string,
    input: AddReelItemsInput,
    auth: AuthContext
): ReelItemsResponse => {
    const reel = writable(reelId, auth);

    if (reelRepo.countItems(reelId) + input.clipIds.length > REEL_ITEM_LIMIT) {
        throw new ValidationError(`A reel holds at most ${REEL_ITEM_LIMIT} clips`);
    }

    const added = reelRepo.addItems(reelId, reel.ownerId, input.clipIds);

    if (added !== input.clipIds.length) {
        throw new AuthorizationError("A reel can only hold its owner's clips");
    }

    return listReelEntries(reelId, auth);
};

export const removeReelItem = (
    reelId: string,
    itemId: string,
    auth: AuthContext
): ReelItemsResponse => {
    writable(reelId, auth);

    if (!reelRepo.removeItem(reelId, itemId)) {
        throw new NotFoundError("That clip is not in this reel");
    }

    return listReelEntries(reelId, auth);
};

export const moveReelItem = (
    reelId: string,
    input: MoveReelItemInput,
    auth: AuthContext
): ReelItemsResponse => {
    writable(reelId, auth);

    if (!reelRepo.moveItem(reelId, input.itemId, input.toIndex)) {
        throw new NotFoundError("That clip is not in this reel");
    }

    return listReelEntries(reelId, auth);
};

/** The reels this person could add a clip to, newest first — what "Add to reel" offers. */
export const listOwnReels = (auth: AuthContext): Reel[] =>
    listReels({ ownership: "mine", sort: "updated", limit: 50, page: 0 }, auth).items;

/** Left here so `clipRepo`'s risk figures reach the duplicate reviewer (§10c). */
export const clipsAtRiskFor = (mediaId: string, auth: AuthContext) =>
    reelRepo.clipsAtRiskFor(mediaId, auth.userId);
