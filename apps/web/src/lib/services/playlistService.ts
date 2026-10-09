import {
    AuthorizationError,
    resolvePin,
    BULK_SELECTION_LIMIT,
    NotFoundError,
    ValidationError,
    type AddPlaylistItemsInput,
    type CreatePlaylistInput,
    type MovePlaylistItemInput,
    type Playlist,
    type PlaylistItemsResponse,
    type UpdatePlaylistInput,
} from "@private-stock/core";
import { collectionPinRepo, db, mediaRepo, playlistRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { PAGE_SIZE } from "../libraryQuery";
import { STRIP_COUNT, coverCandidates, coverMosaics } from "./coverMosaic";
import { assertMayShare } from "./collectionAccess";
import { toListPage } from "./mediaService";
import { resolveSavedQuery } from "./savedFilterService";

/**
 * Playlists, and who may do what to them (§6).
 *
 * Two rules, and everything here is one of them:
 *
 * - A playlist is readable by its owner, or by anyone if it is shared.
 * - A playlist is writable **only** by its owner. Sharing grants reading and nothing else,
 *   including to an administrator: `admin` manages the library, not other people's
 *   collections, and there is no operational need to reorder someone's playlist.
 *
 * Item visibility is a separate question and is answered by `mediaRepo.listByIds`, which
 * applies the viewer's own accessible roots. A shared playlist therefore shows each viewer
 * only the items they could have found themselves.
 */

/**
 * The card faces for a set of playlists, sampled from across each one (§14b).
 *
 * Across rather than off the top, so the face is a glimpse of the whole playlist and not of its
 * first item. One sample per playlist and one shared lookup for all of them (`coverMosaics`).
 * A strip's worth, because a playlist can be shown as a row (§14c); its card takes four.
 */
const coversFor = (
    rows: playlistRepo.PlaylistSummaryRow[],
    auth: AuthContext
): Map<string, string[]> =>
    coverMosaics(
        rows.map(
            (row) =>
                [row.id, playlistRepo.sampleItemIds(row.id, coverCandidates(STRIP_COUNT))] as const
        ),
        auth,
        STRIP_COUNT
    );

/** A repo row turned into the shape `resolvePin` wants, or null when nobody has decided. */
const toViewerPin = (
    row: { pinned: 1 | null; position: number | null } | undefined
): { decided: boolean; pinned: boolean; position: number | null } | null =>
    row ? { decided: true, pinned: row.pinned === 1, position: row.position } : null;

const toPlaylist = (
    row: playlistRepo.PlaylistSummaryRow,
    auth: AuthContext,
    covers: string[],
    /**
     * This viewer's own pin, when the caller has already read them in bulk.
     *
     * Passed in rather than looked up here so that listing playlists is one extra query
     * instead of one per playlist — the same reason the covers are batched.
     */
    viewerPin?: { decided: boolean; pinned: boolean; position: number | null } | null
): Playlist => {
    const mine = row.ownerId === auth.userId;
    const pin = resolvePin({
        mine,
        shared: row.visibility === "shared",
        ownerPinned: row.pinned === 1,
        ownerPosition: row.position,
        viewer:
            viewerPin === undefined
                ? toViewerPin(collectionPinRepo.findPin(auth.userId, "playlist", row.id))
                : viewerPin,
    });

    return {
        id: row.id,
        name: row.name,
        description: row.description,
        visibility: row.visibility,
        itemCount: row.itemCount,
        ownerName: row.ownerName,
        covers,
        editable: mine,
        pinned: pin.pinned,
        curated: pin.curated,
        position: pin.position,
        sortMode: row.sortMode,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
};

/**
 * The playlist, if this viewer may see it at all.
 *
 * A playlist they may not see is reported as missing rather than forbidden — otherwise the
 * error itself confirms that a playlist with that id exists.
 */
const readable = (playlistId: string, auth: AuthContext): playlistRepo.PlaylistSummaryRow => {
    const row = playlistRepo.findSummary(playlistId);

    if (!row || (row.ownerId !== auth.userId && row.visibility !== "shared")) {
        throw new NotFoundError("Playlist not found");
    }

    return row;
};

const writable = (playlistId: string, auth: AuthContext): playlistRepo.PlaylistSummaryRow => {
    const row = readable(playlistId, auth);

    if (row.ownerId !== auth.userId) {
        throw new AuthorizationError("Only the owner can change this playlist");
    }

    return row;
};

export const listPlaylists = (auth: AuthContext): Playlist[] => {
    const rows = playlistRepo.listVisibleTo(auth.userId);
    const covers = coversFor(rows, auth);
    const pins = collectionPinRepo.pinsFor(auth.userId, "playlist");

    return (
        rows
            .map((row) =>
                toPlaylist(row, auth, covers.get(row.id) ?? [], toViewerPin(pins.get(row.id)))
            )
            // Re-sorted here, because the repo orders by the owner's pin and this viewer's pin
            // can disagree with it — a curated collection they took out, or a shared one they
            // pinned themselves. The repo's ordering survives as the tie-break.
            .sort(
                (left, right) =>
                    // Your own first, as the repo's own ORDER BY has always done -- a list of
                    // lists is yours before it is the household's. Then this viewer's pin,
                    // which is the part the repo could not know: it orders by the owner's.
                    Number(right.editable) - Number(left.editable) ||
                    Number(right.pinned) - Number(left.pinned) ||
                    left.position - right.position ||
                    left.name.localeCompare(right.name)
            )
    );
};

export const getPlaylist = (playlistId: string, auth: AuthContext): Playlist => {
    const row = readable(playlistId, auth);

    return toPlaylist(row, auth, coversFor([row], auth).get(row.id) ?? []);
};

/**
 * Creates a playlist, optionally with items already in it (§14b).
 *
 * One transaction when items come with it, so a playlist and its contents arrive together or
 * neither does. The alternative -- create, then add -- can half-fail, and what survives is an
 * empty playlist named after something it does not contain, which reads as the feature having
 * worked and then lost everything.
 *
 * The items go through `addPlaylistItems` rather than straight to the repo, so they get the
 * same visibility filter: ids the viewer cannot see are dropped before anything is written,
 * because accepting them would let a playlist confirm that an item exists in a library this
 * account cannot reach.
 */
export const createPlaylist = (input: CreatePlaylistInput, auth: AuthContext): Playlist => {
    assertMayShare(input.visibility, "private", auth);

    const id = db.transaction((): string => {
        const created = playlistRepo.create({
            ownerId: auth.userId,
            name: input.name,
            description: input.description ?? null,
            visibility: input.visibility,
            pinned: input.pinned,
        });

        if (input.mediaIds && input.mediaIds.length > 0) {
            addPlaylistItems(created, { mediaIds: input.mediaIds }, auth);
        }

        return created;
    })();

    return getPlaylist(id, auth);
};

export const updatePlaylist = (
    playlistId: string,
    input: UpdatePlaylistInput,
    auth: AuthContext
): Playlist => {
    const existing = writable(playlistId, auth);

    assertMayShare(input.visibility, existing.visibility, auth);

    playlistRepo.update(playlistId, input);

    return getPlaylist(playlistId, auth);
};

export const deletePlaylist = (playlistId: string, auth: AuthContext): void => {
    writable(playlistId, auth);
    playlistRepo.remove(playlistId);

    // Everybody's pin on it, not just the owner's. Nothing else would ever remove these, and
    // they are somebody's data rather than a cache.
    collectionPinRepo.clearPinsFor("playlist", playlistId);
};

/**
 * Where this viewer wants this playlist in their own sidebar.
 *
 * Readable rather than writable: the whole point is that somebody can take a curated collection
 * out of their sidebar, and they do not own it. `null` clears the decision, which is not the
 * same as unpinning — it puts the collection back on whatever the house offers.
 */
export const setPlaylistPin = (
    playlistId: string,
    pinned: boolean | null,
    auth: AuthContext
): Playlist => {
    readable(playlistId, auth);

    collectionPinRepo.setPin(auth.userId, "playlist", playlistId, pinned);

    return getPlaylist(playlistId, auth);
};

/**
 * One page of a playlist, in its stored order or in a shuffle of it (§14b).
 *
 * A seed selects the second. It is a permutation of the position space rather than a sort of
 * it, so the page is arithmetic and nothing is written — shuffling a playlist never touches
 * the order somebody arranged by hand.
 *
 * `total` counts entries while `items` counts what this viewer can see, and the two are
 * allowed to disagree. A playlist spanning two libraries, one of which this account cannot
 * reach, is a normal thing rather than an error to report. The total is reported for both
 * orders: the library's shuffle declines to count because an exact count there is a scan of
 * the matching set, which is a cost this is nowhere near (§20).
 */
export const listPlaylistItems = (
    playlistId: string,
    page: number,
    auth: AuthContext,
    seed: number | null = null
): PlaylistItemsResponse => {
    readable(playlistId, auth);

    const { ids, hasMore } =
        seed === null
            ? // One over the page, so "there is more" is a fact rather than an inference from
              // a full page. The shuffle cannot do this -- its pages are routinely short --
              // and reports the end of the permutation instead.
              (() => {
                  const page1 = playlistRepo.listItemIds(
                      playlistId,
                      PAGE_SIZE + 1,
                      page * PAGE_SIZE
                  );

                  return { ids: page1.slice(0, PAGE_SIZE), hasMore: page1.length > PAGE_SIZE };
              })()
            : playlistRepo.listItemIdsShuffled(playlistId, page, PAGE_SIZE, seed);

    const rows = mediaRepo.listByIds(ids, auth.userId, auth.accessibleRootIds);

    return {
        items: toListPage(rows, auth.userId),
        page,
        pageSize: PAGE_SIZE,
        hasMore,
        total: playlistRepo.countItems(playlistId),
        seed,
    };
};

/**
 * Everything a saved filter matches right now, as ids — the freeze.
 *
 * Run through `resolveSavedQuery`, so the freeze asks exactly what the filter asks — including
 * the owner's ratings, when that is what the owner chose to share. Library access and hidden
 * items are still this viewer's, so the result is their snapshot of a shared way of looking,
 * which is the honest meaning of copying a dynamic list into a fixed one.
 */
const idsMatchingFilter = (filterId: string, excludeIds: string[], auth: AuthContext): string[] => {
    const { query, overlayUserId } = resolveSavedQuery(filterId, 0, auth);

    // One over the limit, so "more than we will act on" is a fact rather than an inference
    // from a full page.
    const matched = mediaRepo.listMediaIds(
        query,
        auth.userId,
        auth.accessibleRootIds,
        BULK_SELECTION_LIMIT + 1,
        overlayUserId
    );

    if (matched.length > BULK_SELECTION_LIMIT) {
        throw new ValidationError(
            `That filter matches more than ${BULK_SELECTION_LIMIT.toLocaleString()} items. ` +
                `Narrow it before adding them to a playlist.`
        );
    }

    const excluded = new Set(excludeIds);

    return matched.filter((id) => !excluded.has(id));
};

/**
 * Adds items, and says how many were new.
 *
 * Either a list of ids or everything a saved filter matches. Ids the viewer cannot see are
 * dropped before anything is written: accepting them would let a shared playlist become a way
 * to confirm that an item exists in a library the adder has no access to, and would put a row
 * in the playlist that its own owner could never explain. The filter path needs no such check
 * because the query was already run as this viewer.
 */
export const addPlaylistItems = (
    playlistId: string,
    input: AddPlaylistItemsInput,
    auth: AuthContext
): { added: number; skipped: number } => {
    writable(playlistId, auth);

    const requested =
        "filterId" in input
            ? idsMatchingFilter(input.filterId, input.excludeIds, auth)
            : mediaRepo
                  .listByIds(input.mediaIds, auth.userId, auth.accessibleRootIds)
                  .map((row) => row.id);

    const asked = "filterId" in input ? requested.length : input.mediaIds.length;
    const added = playlistRepo.addItems(playlistId, requested);

    return { added, skipped: asked - added };
};

export const removePlaylistItem = (
    playlistId: string,
    mediaId: string,
    auth: AuthContext
): void => {
    writable(playlistId, auth);

    if (!playlistRepo.removeItem(playlistId, mediaId)) {
        throw new NotFoundError("That item is not in this playlist");
    }
};

export const movePlaylistItem = (
    playlistId: string,
    input: MovePlaylistItemInput,
    auth: AuthContext
): void => {
    writable(playlistId, auth);

    if (!playlistRepo.moveItem(playlistId, input.mediaId, input.toIndex)) {
        throw new NotFoundError("That item is not in this playlist");
    }
};
