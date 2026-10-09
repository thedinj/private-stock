/**
 * How many hover previews may play at once.
 *
 * Gallery mode fills the screen with tiles that all want to play video. Browsers do not
 * allow that: each `<video>` holds a hardware decoder, and mobile browsers cap the number
 * sharply — Safari on iOS historically allowed **one**, and exceeding the limit does not
 * queue, it silently fails to play or stalls the ones already running. So the number of
 * concurrent previews is budgeted rather than left to chance (§14).
 *
 * The budget is a module-level singleton because the constraint is per browser tab, not per
 * component: forty tiles each deciding for themselves is exactly the situation that breaks.
 */

/**
 * Priorities. A hovered tile always displaces an autoplaying one, and the showcase's voice —
 * the one tile playing with sound (§14f) — displaces either: it is what the wall is for while
 * it is switched on, and a silent montage is what gives way.
 */
export const PREVIEW_PRIORITY_GALLERY = 0;
export const PREVIEW_PRIORITY_HOVER = 1;
export const PREVIEW_PRIORITY_VOICE = 2;

type Listener = (granted: boolean) => void;

interface Holder {
    listener: Listener;
    priority: number;
    /** Monotonic counter, so ties break towards evicting whichever started first. */
    sequence: number;
}

let sequenceCounter = 0;

const holders = new Map<object, Holder>();
const waiting = new Map<object, Holder>();

let cachedLimit: number | null = null;

/**
 * Concurrent previews this device can sustain.
 *
 * Deliberately conservative and based on coarse signals. There is no API that reports the
 * decoder limit, and guessing high fails in the worst way: previews that never start, on the
 * devices least able to tell you why.
 */
export const previewLimit = (): number => {
    if (cachedLimit !== null) {
        return cachedLimit;
    }

    if (typeof window === "undefined") {
        return 1;
    }

    const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    const narrow = window.innerWidth < 900;
    const cores = navigator.hardwareConcurrency ?? 4;
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;

    if (coarsePointer && narrow) {
        // Phones. Two is already optimistic on older iOS.
        cachedLimit = 2;
    } else if (coarsePointer || narrow || cores <= 4 || memory <= 4) {
        cachedLimit = 4;
    } else {
        cachedLimit = 8;
    }

    return cachedLimit;
};

export const previewsAllowed = (): boolean => {
    if (typeof window === "undefined") {
        return false;
    }

    return !(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
};

const grant = (token: object, holder: Holder): void => {
    waiting.delete(token);
    holders.set(token, holder);
    holder.listener(true);
};

/**
 * Pick the holder to displace: lowest priority first, then whichever started earliest.
 *
 * **Only a strictly lower priority may be displaced.** Allowing equal priorities to evict
 * each other means two tiles of the same rank take turns stopping one another for as long as
 * both want to play — each grant immediately provoking the next eviction — which on a screen
 * of gallery tiles is a permanent flicker rather than a preview.
 *
 * Returns null when no holder ranks below the request, in which case the requester waits: a
 * hovered tile must never be stopped by a tile that merely scrolled into view.
 */
const evictionCandidate = (priority: number): object | null => {
    let candidate: object | null = null;
    let candidateHolder: Holder | null = null;

    for (const [token, holder] of holders) {
        if (holder.priority >= priority) {
            continue;
        }

        const better =
            !candidateHolder ||
            holder.priority < candidateHolder.priority ||
            (holder.priority === candidateHolder.priority &&
                holder.sequence < candidateHolder.sequence);

        if (better) {
            candidate = token;
            candidateHolder = holder;
        }
    }

    return candidate;
};

/**
 * Ask for a slot. The listener is called with `true` when granted and `false` when displaced.
 *
 * Asynchronous by design: a tile that cannot play right now may be granted a slot later when
 * another releases, without having to poll or re-request.
 */
export const requestPreviewSlot = (token: object, priority: number, listener: Listener): void => {
    if (holders.has(token) || waiting.has(token)) {
        return;
    }

    const holder: Holder = { listener, priority, sequence: sequenceCounter++ };

    if (holders.size < previewLimit()) {
        grant(token, holder);
        return;
    }

    const displaced = evictionCandidate(priority);

    if (displaced) {
        const evicted = holders.get(displaced)!;
        holders.delete(displaced);
        evicted.listener(false);
        waiting.set(displaced, evicted);

        grant(token, holder);
        return;
    }

    waiting.set(token, holder);
};

/** Give up a slot, handing it to the highest-priority waiter. */
export const releasePreviewSlot = (token: object): void => {
    const held = holders.delete(token);
    waiting.delete(token);

    if (!held || waiting.size === 0 || holders.size >= previewLimit()) {
        return;
    }

    let best: [object, Holder] | null = null;

    for (const entry of waiting) {
        // Highest priority wins; ties go to whoever has been waiting longest. Written as
        // nested conditions rather than a chain of `||`, which reads the same and is not —
        // an older low-priority waiter would beat a newer high-priority one.
        const better =
            !best ||
            entry[1].priority > best[1].priority ||
            (entry[1].priority === best[1].priority && entry[1].sequence < best[1].sequence);

        if (better) {
            best = entry;
        }
    }

    if (best) {
        grant(best[0], best[1]);
    }
};

/** Test seam: the budget is global state, and a test that leaks it corrupts the next one. */
export const resetPreviewBudget = (limit?: number): void => {
    holders.clear();
    waiting.clear();
    sequenceCounter = 0;
    cachedLimit = limit ?? null;
};

/** Current holders, for tests and debugging. */
export const activePreviewCount = (): number => holders.size;
