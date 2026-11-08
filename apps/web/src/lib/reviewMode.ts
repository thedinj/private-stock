import { roomKey } from "@/lib/activeDomain";

/**
 * Review mode (§14d "Reviewing recordings for a reel"): a way of going through a set, not a set.
 *
 * It changes how the viewer moves -- each item opens at the room's tail, the next one waits for
 * `d` rather than rolling on -- and nothing about which items are in it. A backlog is a view the
 * person makes ("Not yet reviewed for Wins", oldest first); the mode works through whatever set
 * it is given.
 *
 * **It carries a pass**: `?review=<passId>` is what `d` marks the item for. Carried on the
 * item's address, so a reload stays in it and stepping through the set keeps it, while an item
 * opened any other way opens as usual. `review=1` -- what Play ▸ Review sends, and every address
 * from before passes -- means "the pass last used in this room", which the viewer resolves and
 * writes back into the address.
 */

export const REVIEW_PARAM = "review";

/** The address's way of saying "whichever pass I used last here". */
export const LAST_USED_PASS = "1";

/** What the address asks review mode for -- a pass id, or `LAST_USED_PASS` -- or null when off. */
export const reviewParam = (params: Pick<URLSearchParams, "get">): string | null =>
    params.get(REVIEW_PARAM) || null;

/**
 * An item's address in review mode or out of it: `true` for the last-used pass, a pass id for
 * that one, `false` for off. Other parameters are kept as they are.
 */
export const withReview = (href: string, review: boolean | string): string => {
    const [path, query = ""] = href.split("?", 2);
    const params = new URLSearchParams(query);

    if (review === false) params.delete(REVIEW_PARAM);
    else params.set(REVIEW_PARAM, review === true ? LAST_USED_PASS : review);

    const rest = params.toString();

    return rest === "" ? path : `${path}?${rest}`;
};

/**
 * Which pass review mode is on, given the address and this room's passes.
 *
 * A pass the address names, while it is still one of them. Otherwise -- `review=1`, or a pass
 * deleted since the address was written -- the one last used here on this device, and failing
 * that the first: turning the mode on should not stop to ask which. Null only when there are
 * no passes at all, which is when the viewer offers to name one.
 */
export const resolveReviewPass = <Pass extends { id: string }>(
    asked: string,
    passes: readonly Pass[],
    lastUsed: string | null
): Pass | null =>
    passes.find((pass) => pass.id === asked) ??
    passes.find((pass) => pass.id === lastUsed) ??
    passes[0] ??
    null;

/** Per device and per room, like the clip bar's reel: which pass `Shift+D` turns on. */
const lastPassKey = (): string => roomKey("ps:reviewPass");

/** The pass last reviewed for in this room on this device, or null. */
export const readLastReviewPass = (): string | null => {
    try {
        return window.localStorage.getItem(lastPassKey());
    } catch {
        return null;
    }
};

export const rememberReviewPass = (passId: string): void => {
    try {
        window.localStorage.setItem(lastPassKey(), passId);
    } catch {
        // A private window or blocked storage: the mode still works, and starts on the first pass.
    }
};
