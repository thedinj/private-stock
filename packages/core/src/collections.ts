/**
 * Collections: the rules a saved view and a playlist share (§14b).
 *
 * The two are the same idea with different mechanics — a view is a query, a playlist is a list,
 * and both exist to put a subset of the library in front of somebody. Everything about *who may
 * see one*, *who may change one* and *where it sits in a sidebar* is therefore deliberately
 * identical, and lives here rather than being written twice and drifting.
 *
 * It had drifted. The sidebar showed a shared view's owner-pin to every account and a shared
 * playlist's to nobody, so the same gesture on the same kind of object did two different things
 * depending on which one you had made.
 */

export type CollectionKind = "filter" | "playlist";

/**
 * Who may share a collection with the household.
 *
 * **Administrators only.** Sharing is the curation gesture: a shared collection is one the
 * house offers, so "shared" has to mean something an account can rely on rather than whatever
 * anybody happened to publish. Ordinary accounts keep as many private views and playlists as
 * they like — what they lose is the ability to put one in everybody else's list.
 *
 * Unsharing is not privileged the same way, deliberately: whoever owns a collection can always
 * make it private again. Otherwise an administrator who lost the scope would leave something
 * shared that nobody could withdraw.
 */
export const SHARE_SCOPE = "admin" as const;

/** The three states a viewer's own pin can be in. See `CollectionPin` in the schema. */
export interface ViewerPin {
    /** Whether a row exists — whether this person has expressed any opinion at all. */
    decided: boolean;
    /** What they decided, meaningful only when `decided`. */
    pinned: boolean;
    position: number | null;
}

export interface CollectionPinInputs {
    /** Whether the viewer owns it. */
    mine: boolean;
    /** Whether it is shared with the household. */
    shared: boolean;
    /** The owner's pin: their own sidebar when private, the household default when shared. */
    ownerPinned: boolean;
    ownerPosition: number;
    /** This viewer's override, if they have one. */
    viewer: ViewerPin | null;
}

export interface ResolvedPin {
    pinned: boolean;
    position: number;
    /**
     * Whether this is in the sidebar because the house put it there rather than because the
     * viewer did.
     *
     * The UI says so: "in your sidebar because it is shared with everyone" is the difference
     * between a pin somebody chose and one they inherited, and without it an unpin control
     * reads as removing the collection rather than removing it from one sidebar.
     */
    curated: boolean;
}

/**
 * Where a collection sits for one viewer.
 *
 * The order of the branches is the whole rule:
 *
 *  1. **The viewer's own decision wins.** Whatever the house says, somebody who has pinned or
 *     unpinned a collection has said where they want it, and nothing should move it again.
 *  2. **Otherwise a shared collection follows the owner's pin**, which on a shared collection
 *     is the household default — that is what makes a curated baseline possible at all.
 *  3. **Otherwise it is the viewer's own collection or nothing**, and the owner's pin means
 *     only what it has always meant: their own sidebar.
 */
export const resolvePin = ({
    mine,
    shared,
    ownerPinned,
    ownerPosition,
    viewer,
}: CollectionPinInputs): ResolvedPin => {
    if (viewer?.decided) {
        return {
            pinned: viewer.pinned,
            position: viewer.position ?? ownerPosition,
            // Not curated even when the house also pins it: the viewer chose this, and telling
            // them the house did would offer to undo something they did themselves.
            curated: false,
        };
    }

    if (shared && !mine) {
        return { pinned: ownerPinned, position: ownerPosition, curated: ownerPinned };
    }

    return { pinned: mine && ownerPinned, position: ownerPosition, curated: false };
};
