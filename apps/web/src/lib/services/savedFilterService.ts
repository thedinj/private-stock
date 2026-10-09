import {
    AuthorizationError,
    resolvePin,
    ConflictError,
    NotFoundError,
    ValidationError,
    isViewerRelative,
    personalRulesIn,
    savedQuerySchema,
    type CreateSavedFilterInput,
    type SavedFilter,
    type SavedQuery,
    type UpdateSavedFilterInput,
} from "@private-stock/core";
import { collectionPinRepo, savedFilterRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { assertMayShare } from "./collectionAccess";

/**
 * Saved filters — dynamic playlists — and who may do what to them (§6).
 *
 * The same two rules as playlists, deliberately: readable by the owner or by anyone when
 * shared, writable only by the owner, `admin` included. A filter you may not see reads as
 * missing rather than forbidden, so the error does not confirm it exists.
 *
 * The one thing sharing a filter does that sharing a playlist cannot is name a different set
 * of items per viewer, because the query may test the viewer's own ratings. Whose ratings is
 * the owner's choice: `resolveAs` is `viewer` by default, and `owner` makes the filter mean
 * the same thing for everyone — their five stars, not yours.
 */

/**
 * Reads a stored query back.
 *
 * `safeParse` rather than `parse`: the JSON in the column was valid when it was written, and
 * the only way it stops being valid is the query schema changing under it. That is a reason
 * to show the filter as broken, not to fail the whole list and leave the user with no filters
 * at all and nothing to click.
 */
export const parseQuery = (queryJson: string): SavedFilter["query"] => {
    try {
        const result = savedQuerySchema.safeParse(JSON.parse(queryJson));

        return result.success ? result.data : null;
    } catch {
        return null;
    }
};

/**
 * What actually gets stored.
 *
 * Re-parsed here rather than trusted from the caller, even though the route has already
 * validated it. The invariant being protected is that a stored query contains no page — a
 * filter is a way of looking at the library, not a position in it — and an invariant that
 * holds only because one route happens to strip the field is one that a second caller
 * quietly breaks.
 */
const serializeQuery = (query: unknown): string => JSON.stringify(savedQuerySchema.parse(query));

/**
 * Whose overlay this viewer's copy of the filter reads, or nobody's in particular.
 *
 * `undefined` for the ordinary case, which is most of them: a filter that resolves against
 * the viewer, or one whose owner *is* the viewer, or one that never asks about ratings. The
 * repo turns `undefined` into exactly the query it ran before any of this existed.
 */
const overlayFor = (
    row: savedFilterRepo.SavedFilterSummaryRow,
    query: SavedQuery | null,
    auth: AuthContext
): string | undefined =>
    row.resolveAs === "owner" && row.userId !== auth.userId && query && isViewerRelative(query)
        ? row.userId
        : undefined;

/**
 * A saved view as somebody other than its page runs it: a home shelf, a card's face (§6, §14c).
 *
 * Null when this viewer may not see it -- reported by callers exactly as a deleted one, since
 * from there the two are the same fact. `query` is null when it can no longer be read, which a
 * caller shows as broken rather than failing on. The overlay comes with it so nobody holding a
 * view can run a shared one against the wrong person's ratings by forgetting a step.
 */
export const findSavedQuery = (
    id: string,
    auth: AuthContext
): {
    row: savedFilterRepo.SavedFilterSummaryRow;
    query: SavedQuery | null;
    overlayUserId?: string;
} | null => {
    const row = savedFilterRepo.findVisibleTo(id, auth.userId);

    if (!row) {
        return null;
    }

    const query = parseQuery(row.queryJson);

    return { row, query, overlayUserId: overlayFor(row, query, auth) };
};

/**
 * Whose ratings a library request opened from a saved filter asks about (§6).
 *
 * The grid opens a saved filter by expanding it into ordinary parameters, so without this
 * the grid, its count, the facets and a bulk action all ran a shared "their five stars"
 * filter against the *viewer's* ratings -- while the same filter on a home shelf used the
 * owner's. One filter, two different sets, depending on where it was opened.
 *
 * The request names the filter it came from, and this decides. The overlay holds only while
 * the rating half of the request is still the saved one: favourite, unrated, the rating band,
 * and whether it is ordered by rating. Narrowing it by anything else -- a kind, a tag, a
 * page -- keeps it, because that only shows less of what the owner chose to share. Changing
 * the rating half falls back to the viewer's own ratings, or an edited view could read any
 * of the owner's ratings one probe at a time.
 *
 * A filter that has gone or was never visible is simply no overlay: the answer is then what
 * it would have been without the parameter, which discloses nothing.
 */
export const overlayForRequest = (
    filterId: string | null,
    query: SavedQuery,
    auth: AuthContext
): string | undefined => {
    if (!filterId) {
        return undefined;
    }

    const row = savedFilterRepo.findVisibleTo(filterId, auth.userId);
    const saved = row ? parseQuery(row.queryJson) : null;

    if (!row || !saved) {
        return undefined;
    }

    const ratingHalf = (value: SavedQuery) => [
        value.favorite ?? false,
        value.unrated ?? false,
        value.minRating ?? null,
        value.maxRating ?? null,
        value.sort === "rating",
        // A rating, favourite or favourite-tags rule inside a group is the same half (§14e):
        // changing one of those is asking about the owner's judgements in a new way.
        personalRulesIn(value.groups),
    ];

    if (JSON.stringify(ratingHalf(query)) !== JSON.stringify(ratingHalf(saved))) {
        return undefined;
    }

    return overlayFor(row, query, auth);
};

const toSavedFilter = (
    row: savedFilterRepo.SavedFilterSummaryRow,
    auth: AuthContext,
    /**
     * This viewer's own pin, when the caller has already read them in bulk.
     *
     * Passed in rather than looked up here so that listing a hundred filters is one query
     * instead of a hundred — the same reason the covers on a playlist list are batched.
     */
    viewerPin?: { decided: boolean; pinned: boolean; position: number | null } | null
): SavedFilter => {
    const query = parseQuery(row.queryJson);
    const mine = row.userId === auth.userId;
    const pin = resolvePin({
        mine,
        shared: row.visibility === "shared",
        ownerPinned: row.pinned === 1,
        ownerPosition: row.position,
        viewer:
            viewerPin === undefined
                ? toViewerPin(collectionPinRepo.findPin(auth.userId, "filter", row.id))
                : viewerPin,
    });

    return {
        id: row.id,
        name: row.name,
        query,
        description: row.description,
        visibility: row.visibility,
        editable: mine,
        ownerName: row.ownerName,
        viewerRelative: query ? isViewerRelative(query) : null,
        resolveAs: row.resolveAs,
        showsOwnerRatings: overlayFor(row, query, auth) !== undefined,
        pinned: pin.pinned,
        position: pin.position,
        curated: pin.curated,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
};

/** A repo row turned into the shape `resolvePin` wants, or null when nobody has decided. */
const toViewerPin = (
    row: { pinned: 1 | null; position: number | null } | undefined
): { decided: boolean; pinned: boolean; position: number | null } | null =>
    row ? { decided: true, pinned: row.pinned === 1, position: row.position } : null;

export const listSavedFilters = (auth: AuthContext): SavedFilter[] => {
    const pins = collectionPinRepo.pinsFor(auth.userId, "filter");

    return (
        savedFilterRepo
            .listVisibleTo(auth.userId)
            .map((row) => toSavedFilter(row, auth, toViewerPin(pins.get(row.id))))
            // Re-sorted here, because the repo orders by the owner's pin and this viewer's pin can
            // disagree with it — a curated collection they took out, or a shared one they pinned
            // themselves. The repo's ordering is still the tie-break that survives.
            .sort(
                (left, right) =>
                    // Your own first, as the repo's own ORDER BY has always done -- a list of lists
                    // is yours before it is the household's. Then this viewer's pin, which is the
                    // part the repo could not know: it orders by the owner's.
                    Number(right.editable) - Number(left.editable) ||
                    Number(right.pinned) - Number(left.pinned) ||
                    left.position - right.position ||
                    left.name.localeCompare(right.name)
            )
    );
};

/** A filter this viewer may read: their own, or one someone shared. */
const readable = (id: string, auth: AuthContext): savedFilterRepo.SavedFilterSummaryRow => {
    const row = savedFilterRepo.findVisibleTo(id, auth.userId);

    if (!row) {
        throw new NotFoundError("Saved filter not found");
    }

    return row;
};

/**
 * A filter this viewer may change, which is only ever their own.
 *
 * Sharing grants reading and nothing else, including to an administrator — the same rule as
 * playlists, for the same reason: `admin` manages the library, not other people's ways of
 * looking at it.
 */
const requireOwn = (id: string, auth: AuthContext): savedFilterRepo.SavedFilterSummaryRow => {
    const row = readable(id, auth);

    if (row.userId !== auth.userId) {
        throw new AuthorizationError("Only the owner can change this filter");
    }

    return row;
};

/**
 * Names are unique per user, so a clash is refused rather than resolved.
 *
 * Silently overwriting would destroy a filter someone built; silently keeping both would
 * leave two identically named entries in the sidebar with no way to tell them apart.
 */
const assertNameFree = (name: string, auth: AuthContext, exceptId?: string): void => {
    const clash = savedFilterRepo.findByName(auth.userId, name);

    if (clash && clash.id !== exceptId) {
        throw new ConflictError(`A saved filter named "${name}" already exists`);
    }
};

export const createSavedFilter = (
    input: CreateSavedFilterInput,
    auth: AuthContext
): SavedFilter => {
    assertNameFree(input.name, auth);
    assertMayShare(input.visibility, "private", auth);

    const id = savedFilterRepo.create({
        userId: auth.userId,
        name: input.name,
        queryJson: serializeQuery(input.query),
        description: input.description ?? null,
        pinned: input.pinned,
        visibility: input.visibility,
        resolveAs: input.resolveAs,
    });

    return toSavedFilter(readable(id, auth), auth);
};

export const updateSavedFilter = (
    id: string,
    input: UpdateSavedFilterInput,
    auth: AuthContext
): SavedFilter => {
    const existing = requireOwn(id, auth);

    if (input.name) {
        assertNameFree(input.name, auth, id);
    }

    assertMayShare(input.visibility, existing.visibility, auth);

    savedFilterRepo.update(id, auth.userId, {
        name: input.name,
        queryJson: input.query ? serializeQuery(input.query) : undefined,
        description: input.description,
        pinned: input.pinned,
        position: input.position,
        visibility: input.visibility,
        resolveAs: input.resolveAs,
    });

    return toSavedFilter(readable(id, auth), auth);
};

export const deleteSavedFilter = (id: string, auth: AuthContext): void => {
    // Through the same gate as every other write, so a filter somebody shared reports "not
    // yours" here as well rather than "not found" — the repo's own scoping would answer the
    // question correctly and describe it wrongly.
    requireOwn(id, auth);

    if (!savedFilterRepo.remove(id, auth.userId)) {
        throw new NotFoundError("Saved filter not found");
    }

    // Everybody's pin on it, not just the owner's. Nothing else would ever remove these, and
    // they are somebody's data rather than a cache.
    collectionPinRepo.clearPinsFor("filter", id);
};

/**
 * Where this viewer wants this filter in their own sidebar.
 *
 * Readable rather than ownable: the whole point is that somebody can take a curated collection
 * out of their sidebar, and they do not own it. `null` clears the decision, which is not the
 * same as unpinning — it puts the collection back on whatever the house offers.
 */
export const setSavedFilterPin = (
    id: string,
    pinned: boolean | null,
    auth: AuthContext
): SavedFilter => {
    readable(id, auth);

    collectionPinRepo.setPin(auth.userId, "filter", id, pinned);

    return toSavedFilter(readable(id, auth), auth);
};

/**
 * The query to run for a saved filter, at a given page.
 *
 * Here rather than in the client, so that opening a saved filter cannot drift from what was
 * saved: the client asks for the filter by id and gets the library back, instead of
 * reconstructing a query and hoping it matches.
 *
 * Readable rather than owned, so a shared filter can be opened. It is then always run with
 * the viewer's own library access and their own hidden items — that is what makes sharing
 * safe, and neither is negotiable.
 *
 * `overlayUserId` is the one thing the owner gets to decide: whose ratings the query asks
 * about. It is returned separately rather than folded into the query because the query is a
 * URL-shaped object a client could construct, and an account that could name the user whose
 * ratings to filter by could read anyone's ratings one probe at a time. Only this function
 * can produce it, and only from a filter whose owner chose to share it that way.
 */
export interface ResolvedSavedQuery {
    query: ReturnType<typeof savedQuerySchema.parse> & { page: number };
    overlayUserId?: string;
}

export const resolveSavedQuery = (
    id: string,
    page: number,
    auth: AuthContext
): ResolvedSavedQuery => {
    const row = readable(id, auth);
    const query = parseQuery(row.queryJson);

    if (!query) {
        throw new ValidationError("This saved filter can no longer be read");
    }

    return { query: { ...query, page }, overlayUserId: overlayFor(row, query, auth) };
};
