import { SHARE_SCOPE } from "@private-stock/core";

import { requireScope, type AuthContext } from "../auth/withAuth";

/**
 * The access rules shared by every piece of user-made work in the app (§14c, §14d).
 *
 * Both of these existed twice before this file did, and §14c had already recorded the cost of
 * that: the sidebar filtered views and playlists by different expressions, so the same gesture
 * on the same kind of object did two different things. A rule written twice is a rule that has
 * already begun to drift; these live here so that a third caller cannot restart it.
 *
 * They are here rather than in `packages/core/src/collections.ts` because both take an
 * `AuthContext`, which is a web-app type core cannot see. Core holds the parts that are pure
 * arithmetic over a collection -- `SHARE_SCOPE`, `resolvePin` -- and this holds the parts that
 * need to know who is asking.
 */

/**
 * Sharing is curation, and curation is an administrator's (§14c).
 *
 * A shared collection is one the house offers, so "shared" has to mean something an account can
 * rely on rather than whatever anybody happened to publish — and the owner's pin on a shared
 * collection becomes the default in everybody's sidebar, which is not authority to hand to
 * every account.
 *
 * **Unsharing is deliberately not privileged the same way.** Whoever owns a collection can
 * always make it private again; otherwise an administrator who lost the scope would leave
 * something shared that nobody could withdraw.
 *
 * Three callers: playlists, saved views and reels. A reel is not a collection in the sidebar
 * sense — it is not pinnable and has no `CollectionPin` row (§14d) — but it is shared by the
 * same gesture for the same reason, so it is shared by the same rule.
 */
export const assertMayShare = (
    next: "private" | "shared" | undefined,
    current: "private" | "shared",
    auth: AuthContext
): void => {
    if (next === "shared" && current !== "shared") {
        requireScope(auth, SHARE_SCOPE);
    }
};

/**
 * Whether this viewer may alter a piece of user work that other people can see (§9, §14d).
 *
 * The person who made it, or an administrator. Nothing else in the app permits a cross-user
 * write: sharing a playlist or a filter grants reading and never writing, administrators
 * included (§6). Captures and clips need their own rule because they are the two things that
 * are *visible* beyond their author — a capture to everyone, a clip to whoever can open a reel
 * carrying it — while still being somebody's work to destroy.
 *
 * **An unattributed one is admin-only.** Both columns are `ON DELETE SET NULL`, so the work
 * outlives the account that made it and loses only its attribution. Nobody can claim it, and
 * the alternative is that deleting an account quietly hands that person's work to everyone.
 */
export const mayAlterOwnWork = (ownerId: string | null, auth: AuthContext): boolean =>
    auth.scopes.includes("admin") || (ownerId !== null && ownerId === auth.userId);
