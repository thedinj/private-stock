import type { MediaDetail } from "@private-stock/core";

/**
 * Why an item cannot be sent to a TV, in words for the person holding the phone -- or null when
 * it can (§11).
 *
 * The same line the server draws (`requireCastReady`): a TV has no page to explain a refusal
 * and no fallback to offer, so an item with nothing playable is said to be uncastable before a
 * session is started for it, rather than discovered by a black screen. Nothing is offered in
 * its place; the item page already says what is being done about it.
 */
export const castBlocked = (source: MediaDetail["playbackSource"] | undefined): string | null => {
    switch (source) {
        case "pending":
            return "Can't cast yet: a playable version is still being made.";
        case "unavailable":
            return "Can't cast: the file can't be reached right now.";
        default:
            return null;
    }
};
