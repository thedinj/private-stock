import {
    AuthorizationError,
    NotFoundError,
    REEL_ITEM_LIMIT,
    ValidationError,
    reelNaturalDirection,
    type AddReelItemsInput,
    type Clip,
    type CreateClipInput,
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
import { inRoom, roomOf } from "./room";
import { coverUrl } from "./artService";
import { clipsByIds, assertReelNameFree, createClip } from "./clipService";
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

    if (
        !row ||
        !inRoom(row, auth) ||
        (row.ownerId !== auth.userId && row.visibility !== "shared")
    ) {
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
    const rows = reelRepo.listVisibleTo(query, auth.userId, roomOf(auth), direction);
    const covers = coversFor(rows, auth);

    return {
        items: rows.map((row) => toReel(row, auth, covers.get(row.id) ?? [])),
        page: query.page,
        pageSize: query.limit,
        hasMore: rows.length === query.limit,
        total: reelRepo.countVisibleTo(query, auth.userId, roomOf(auth)),
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
            domain: roomOf(auth),
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
    const items = playableEntries(
        entries.flatMap((entry) => {
            const clip = clips.get(entry.clipId);

            return clip ? [{ id: entry.id, position: entry.position, clip }] : [];
        }),
        auth
    );

    return {
        items,
        total: entries.length,
        runningMs: reelRepo.runningMs(reelId),
    };
};

/**
 * Spans as a player takes them: each with its video's title, cover and whether the browser can
 * play it as it stands -- the flag a player cannot pay a round trip per span to learn.
 *
 * A reel's entries and the library's Clips tab played from the top (§14e) both come through
 * here. A span whose video this viewer cannot reach is dropped.
 */
export const playableEntries = (
    spans: { id: string; position: number; clip: Clip }[],
    auth: AuthContext
): ReelEntry[] => {
    const media = new Map(
        mediaRepo
            .listByIds(
                [...new Set(spans.map((span) => span.clip.mediaId))],
                auth.userId,
                auth.accessibleRootIds
            )
            .map((row) => [row.id, row])
    );

    return spans.flatMap(({ id, position, clip }): ReelEntry[] => {
        const row = media.get(clip.mediaId);

        if (!row) return [];

        const detail = mediaRepo.findDetail(row.id, auth.userId, auth.accessibleRootIds);

        return [
            {
                id,
                position,
                clip,
                media: {
                    id: row.id,
                    title: row.title ?? "Untitled",
                    coverUrl: coverUrl(row.id, row.coverPath, row.coverGeneratedAt),
                    durationMs: row.durationMs,
                    directPlay: detail ? resolvePlaybackPlan(detail).directPlay : false,
                },
            },
        ];
    });
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

/**
 * A clip saved straight into a reel (§14d "Reviewing recordings for a reel").
 *
 * One transaction around both, so a reel that refuses it -- somebody else's, or full -- leaves
 * no clip behind that the person thinks went into it. The checks are `addReelItems`' own: the
 * reel is writable by this person, and holds only its owner's clips.
 */
export const createClipInReel = (
    mediaId: string,
    input: CreateClipInput,
    reelId: string,
    auth: AuthContext
): Clip =>
    db.transaction((): Clip => {
        const clip = createClip(mediaId, input, auth);

        addReelItems(reelId, { clipIds: [clip.id] }, auth);

        return clip;
    })();

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
