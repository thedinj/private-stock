import { ValidationError, type DomainKind } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * The room a request is in, for something that belongs to one (§21).
 *
 * Null only for a context that is not in any room — a per-item media request, or work done on
 * somebody's behalf. Those never create or list a room's things, so meeting one here is a bug
 * worth a loud refusal rather than a guess at which room was meant.
 */
export const requestDomain = (auth: AuthContext): DomainKind => {
    if (auth.domain === null) {
        throw new ValidationError("This request does not say which room it is for");
    }

    return auth.domain;
};

/**
 * Whether something stored in a room may be read from this request.
 *
 * A context in no room reads everything, as it does for items. One in a room reads only that
 * room's, and a caller reports the rest as not found — the same as a private tag, because a
 * refusal that names the reason confirms the thing exists.
 */
export const inRequestDomain = (domain: string, auth: AuthContext): boolean =>
    auth.domain === null || auth.domain === domain;
