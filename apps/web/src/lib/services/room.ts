import { ValidationError, type DomainKind } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * The room a request is in, for anything that belongs to one (§21): the tag vocabulary,
 * playlists, reels, saved views and the home page.
 *
 * Every read or write of those names a room, and a context with none -- a media byte
 * request, or work done on somebody's behalf -- has no vocabulary to address. Refused rather than
 * defaulted, for the reason `requireAuth` refuses a request that does not say: a guess puts one
 * room's names in front of another.
 */
export const roomOf = (auth: Pick<AuthContext, "domain">): DomainKind => {
    if (!auth.domain) {
        throw new ValidationError("This request does not say which room it is for");
    }

    return auth.domain;
};

/**
 * Whether a tag, playlist, reel or saved view is in the request's room. One of another room
 * reports not-found, as somebody else's private tag does: from inside one room the other's vocabulary does not exist.
 */
export const inRoom = (row: { domain: string }, auth: Pick<AuthContext, "domain">): boolean =>
    auth.domain !== null && row.domain === auth.domain;
