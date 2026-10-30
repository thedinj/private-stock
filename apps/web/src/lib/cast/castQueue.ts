/**
 * The decisions behind continuous play on a TV (§11), kept apart from the SDK so they can be
 * tested without one.
 *
 * Two things hold the same truth while casting -- the page, which shows an item, and the TV,
 * which plays one -- and either can move first. The phone moves when somebody presses Next; the
 * TV moves when an item ends and its queue rolls on, which is the whole point of the queue and
 * usually happens while the phone is asleep in a pocket. `agreedId` is the item both last
 * agreed on, and it is what tells the two cases apart.
 */

/** What to do to bring the page and the TV back into step. */
export type CastSync = { kind: "none" } | { kind: "load" } | { kind: "follow"; mediaId: string };

/**
 * @param pageId  the item the page is showing
 * @param tvId    the item the TV has loaded, or null when it has nothing (a queue run out)
 * @param agreedId the item the two last agreed on, or null at the start of a session
 */
export const castSync = (
    pageId: string,
    tvId: string | null,
    agreedId: string | null
): CastSync => {
    // The page moved -- Next, Prev, a link -- and the TV is still where they agreed, or has
    // nothing. The TV is sent to the page.
    if (pageId !== agreedId && (tvId === null || tvId === agreedId)) {
        return { kind: "load" };
    }

    // The TV moved on by itself. The page follows it, so the phone shows what is on the TV when
    // it wakes. Also the answer when both moved: the TV is what everyone is looking at.
    if (tvId !== null && tvId !== pageId) {
        return { kind: "follow", mediaId: tvId };
    }

    // In step -- or the queue ran out on the item they agreed on, which is the end of the show
    // and not a reason to start it again.
    return { kind: "none" };
};

/** Below this many items after the one playing, the queue is topped up. */
export const QUEUE_LOW_WATER = 3;

/**
 * Which upcoming items to add to the TV's queue, in order -- none while it still has enough.
 *
 * `queuedIds` is the queue as this tab built it, in order. `refused` is what the server has
 * already declined to cast (not playable yet, or not visible), so it is not asked again on every
 * check.
 */
export const idsToQueue = (
    upcomingIds: readonly string[],
    queuedIds: readonly string[],
    currentId: string,
    refused: ReadonlySet<string>
): string[] => {
    const at = queuedIds.indexOf(currentId);
    const remaining = at === -1 ? 0 : queuedIds.length - at - 1;

    if (remaining >= QUEUE_LOW_WATER) {
        return [];
    }

    const queued = new Set(queuedIds);

    return upcomingIds.filter((id) => id !== currentId && !queued.has(id) && !refused.has(id));
};

/**
 * The items the TV played to the end on its way from `agreedId` to `tvId`, in queue order.
 *
 * A queue only advances when an item ends, so everything from the item the two last agreed on
 * up to -- not including -- the one the TV is on now was played through. That is how the views
 * of a run the phone slept through are still counted when it wakes. Nothing when either end is
 * not in the queue this tab built: the TV is playing something it was not sent from here.
 */
export const playedThrough = (
    queuedIds: readonly string[],
    agreedId: string | null,
    tvId: string | null
): string[] => {
    const from = agreedId === null ? -1 : queuedIds.indexOf(agreedId);
    const to = tvId === null ? -1 : queuedIds.indexOf(tvId);

    return from !== -1 && to > from ? queuedIds.slice(from, to) : [];
};
