/**
 * Review mode (§14d "Reviewing recordings for a reel"): a way of going through a set, not a set.
 *
 * It changes how the viewer moves -- each item opens at the room's tail, the next one waits for
 * `d` rather than rolling on -- and nothing about which items are in it. A backlog is a view the
 * person makes (Not reviewed, oldest first); the mode works through whatever set it is given.
 *
 * Carried on the item's address, so a reload stays in it and stepping through the set keeps it,
 * while an item opened any other way opens as usual.
 */

export const REVIEW_PARAM = "review";

/** Whether an item's address asks for review mode. */
export const isReviewing = (params: Pick<URLSearchParams, "get">): boolean =>
    params.get(REVIEW_PARAM) === "1";

/** An item's address, in review mode or out of it. Other parameters are kept as they are. */
export const withReview = (href: string, reviewing: boolean): string => {
    const [path, query = ""] = href.split("?", 2);
    const params = new URLSearchParams(query);

    if (reviewing) params.set(REVIEW_PARAM, "1");
    else params.delete(REVIEW_PARAM);

    const rest = params.toString();

    return rest === "" ? path : `${path}?${rest}`;
};
