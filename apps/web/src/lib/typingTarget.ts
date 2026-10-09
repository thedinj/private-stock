/**
 * Whether a keystroke belongs to what it landed on (§14).
 *
 * Every hotkey on the viewer has to step aside for typing: pressing `n` in the search box must
 * not walk the library, and digits in a note must not re-rate the item. The guard for that was
 * `["INPUT", "TEXTAREA", "SELECT"].includes(tagName)`, written out in three places, and it was
 * too broad in exactly the way that matters.
 *
 * **Most inputs are not typing.** Mantine renders a star rating as `<input type="radio">`, so
 * clicking a star to rate something focused a radio and every hotkey on the page went quiet —
 * including the numpad that rates. Reaching for the keyboard straight after the mouse is the
 * ordinary way to work through a library, and the one control it failed on was the one the keys
 * exist to duplicate.
 *
 * So the question is not "is this a form control" but "would this key have been a character
 * somebody meant to type". A radio, a checkbox, a range or a button swallow no text. Neither
 * does the scrubber, which is a `div` with a slider role.
 */

/**
 * The input types that take no characters.
 *
 * A deny-list rather than a list of text types, so anything unrecognised counts as typing. That
 * is the safe side: swallowing a keystroke inside a field loses what somebody wrote, while a
 * hotkey that does not fire is obvious at once and fixed by clicking elsewhere. Browsers do
 * normalise an unknown `type` to `text`, so this mostly guards the case where these facts did
 * not come from a real element.
 */
const NON_TEXT_INPUT = new Set([
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
]);

/**
 * The three facts the decision needs.
 *
 * Separated from the element so the rule is testable without a DOM — the same split
 * `videoSlots.ts` and `viewerSequence.ts` make, and the reason this repo's fast suite needs no
 * browser at all.
 */
export interface KeyTarget {
    /** Upper case, as `Element.tagName` gives it. */
    tagName: string;
    /** The input's resolved type, or null for anything that is not an input. */
    inputType: string | null;
    contentEditable: boolean;
}

export const isTypingElement = (target: KeyTarget): boolean => {
    // A rich-text field is a `div`, so tag names alone would let typing a note move to the next
    // item.
    if (target.contentEditable) return true;

    if (target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true;

    if (target.tagName === "INPUT") return !NON_TEXT_INPUT.has(target.inputType ?? "text");

    return false;
};

/** The same question, asked of a real event target. */
export const isTypingTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;

    return isTypingElement({
        tagName: target.tagName,
        // `type` on an input is already resolved and lower case, and defaults to "text".
        inputType: target instanceof HTMLInputElement ? target.type : null,
        contentEditable: target.isContentEditable,
    });
};
