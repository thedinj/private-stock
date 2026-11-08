import type { TagScope } from "@private-stock/core";

/**
 * The item viewer's keys, in one table (§14 "Hotkeys").
 *
 * Three handlers answer them -- the page (items, review, fields), the player (transport, clip
 * marks) and the still stage (space, f) -- and each grew its keys on its own, so nothing could
 * say whether a new key was free. This is the list they are checked against: the help view is
 * drawn from it, the fields' tooltips read their key from it, the page looks the field keys up
 * in it, and a test fails if one press is claimed twice.
 *
 * A press is named the way `keyPress` names an event: the character a printable key produces
 * (so `t` and `T` are two presses, Shift being part of the character), `Digit0`–`Digit9` and
 * `Numpad0`–`Numpad9` by physical key (the number row seeks and the numpad rates, and both give
 * the same `key`), `Space`, and anything else by its `key` with `Shift+` when Shift is held.
 */

type ViewerKeyGroup = "transport" | "items" | "clips" | "review" | "fields" | "page";

/**
 * The controls whose tooltips name their key, so a re-key in this table reaches the tooltip,
 * the help and the handler together.
 */
export type ViewerAction =
    | "play"
    | "speed"
    | "mute"
    | "fullscreen"
    | "capture"
    | "next"
    | "previous"
    | "markIn"
    | "markOut"
    | "saveClip"
    | "review"
    | "rate"
    | "favourite"
    | "trash";

/** The fields a key jumps into. A facet's are named by the facet, not by the room's word. */
export type ViewerField = "performer" | "source" | "tag" | "privateTag" | "note";

interface ViewerKey {
    group: ViewerKeyGroup;
    /** Every press that does it, as `keyPress` names them. */
    presses: readonly string[];
    /** How the help writes the key. */
    shown: string;
    /** What it does. A field's binding leaves this to `fieldTitle`, which knows the room. */
    does: string;
    field?: ViewerField;
    /** The control whose tooltip shows this key, and the keys it shows. */
    action?: ViewerAction;
    /** How a tooltip writes the keys; several are alternatives, not a chord. */
    tip?: readonly string[];
}

export const VIEWER_KEY_GROUPS: readonly { group: ViewerKeyGroup; title: string }[] = [
    { group: "transport", title: "Playing" },
    { group: "items", title: "Through the set" },
    { group: "clips", title: "Marking a clip" },
    { group: "review", title: "Judging it" },
    { group: "fields", title: "Writing about it" },
    { group: "page", title: "Anywhere" },
];

const digits = (prefix: "Digit" | "Numpad", from: number, to: number): string[] =>
    Array.from({ length: to - from + 1 }, (_, index) => `${prefix}${from + index}`);

export const VIEWER_KEYS: readonly ViewerKey[] = [
    // Transport: the player's, and the still stage's space and f.
    {
        group: "transport",
        presses: ["Space", "k"],
        shown: "Space / k",
        does: "Play or pause",
        action: "play",
        tip: ["Space", "k"],
    },
    {
        group: "transport",
        presses: ["ArrowLeft", "ArrowRight"],
        shown: "← →",
        does: "Back or on 5 seconds",
    },
    {
        group: "transport",
        presses: ["Shift+ArrowLeft", "Shift+ArrowRight"],
        shown: "Shift ← →",
        does: "Back or on 30 seconds",
    },
    {
        group: "transport",
        presses: ["j", "l"],
        shown: "j / l",
        does: "Back or on by the bar's jump lengths",
    },
    { group: "transport", presses: [",", "."], shown: ", .", does: "A frame back or on, paused" },
    {
        group: "transport",
        presses: digits("Digit", 0, 9),
        shown: "0–9",
        does: "Jump to 0–90% of the way through",
    },
    {
        group: "transport",
        presses: ["-", "_", "+", "="],
        shown: "- +",
        does: "Slower or faster",
        action: "speed",
        tip: ["−", "+"],
    },
    { group: "transport", presses: ["m"], shown: "m", does: "Mute", action: "mute", tip: ["m"] },
    {
        group: "transport",
        presses: ["f"],
        shown: "f",
        does: "Full screen",
        action: "fullscreen",
        tip: ["f"],
    },
    {
        group: "transport",
        presses: ["s"],
        shown: "s",
        does: "Capture this frame",
        action: "capture",
        tip: ["s"],
    },

    { group: "items", presses: ["n"], shown: "n", does: "Next item", action: "next", tip: ["n"] },
    {
        group: "items",
        presses: ["p"],
        shown: "p",
        does: "Previous item",
        action: "previous",
        tip: ["p"],
    },

    {
        group: "clips",
        presses: ["["],
        shown: "[",
        does: "Mark the in point",
        action: "markIn",
        tip: ["["],
    },
    {
        group: "clips",
        presses: ["]"],
        shown: "]",
        does: "Mark the out point. The clip's tag box takes the keys: Enter adds a tag; Shift+Tab, arrows and Tab choose where tags go",
        action: "markOut",
        tip: ["]"],
    },
    {
        group: "clips",
        presses: ["Enter"],
        shown: "Enter",
        does: "In the clip's empty tag box: save the clip (into the reel chosen)",
        action: "saveClip",
        tip: ["Enter"],
    },

    {
        group: "review",
        presses: ["d"],
        shown: "d",
        does: "Done: mark it reviewed, go to the next",
        action: "review",
        tip: ["d"],
    },
    {
        group: "review",
        presses: digits("Numpad", 1, 5),
        shown: "Numpad 1–5",
        does: "Rate it. The same number again clears it",
        action: "rate",
        tip: ["Numpad 1–5"],
    },
    {
        group: "review",
        presses: ["h"],
        shown: "h",
        does: "Favourite",
        action: "favourite",
        tip: ["h"],
    },
    {
        group: "review",
        presses: ["Delete", "Backspace"],
        shown: "Delete",
        does: "Move to trash, then Enter to confirm",
        action: "trash",
        tip: ["Delete"],
    },

    // One letter per field, by what the field is rather than what the room calls it: w for who,
    // o for origin, t for tag, r for remark. Shift+T is the private box under the shared one.
    { group: "fields", presses: ["w"], shown: "w", does: "", field: "performer" },
    { group: "fields", presses: ["o"], shown: "o", does: "", field: "source" },
    { group: "fields", presses: ["t"], shown: "t", does: "", field: "tag" },
    { group: "fields", presses: ["T"], shown: "Shift t", does: "", field: "privateTag" },
    { group: "fields", presses: ["r"], shown: "r", does: "", field: "note" },
    {
        group: "fields",
        presses: ["Escape"],
        shown: "Esc",
        does: "Leave the field: the keys go back to the player. Again, with a clip marked: drop the clip",
    },

    { group: "page", presses: ["/"], shown: "/", does: "Search" },
    { group: "page", presses: ["?"], shown: "?", does: "These keys" },
];

/** A control's keys, for its tooltip: alternatives, written as the tooltip should show them. */
export const actionKeys = (action: ViewerAction): string[] => [
    ...(VIEWER_KEYS.find((binding) => binding.action === action)?.tip ?? []),
];

/** The facts about a keystroke that name it. A `KeyboardEvent` has all three. */
interface KeyFacts {
    key: string;
    code: string;
    shiftKey: boolean;
}

/** A keystroke's name in the table: see the module's comment. */
export const keyPress = ({ key, code, shiftKey }: KeyFacts): string => {
    if (/^(Digit|Numpad)\d$/.test(code)) return code;
    if (key === " ") return "Space";
    if (key.length === 1) return key;

    return shiftKey ? `Shift+${key}` : key;
};

/** The field a press jumps into, if it is one of theirs. */
export const fieldForPress = (press: string): ViewerField | null =>
    VIEWER_KEYS.find((binding) => binding.field && binding.presses.includes(press))?.field ?? null;

/** A field's key as the keys pressed together, for its tooltip: `["Shift", "T"]`. */
export const fieldKey = (field: ViewerField): string[] => {
    const press = VIEWER_KEYS.find((binding) => binding.field === field)?.presses[0] ?? "";

    return /^[A-Z]$/.test(press) ? ["Shift", press] : [press];
};

/** Which field a facet's box is, or null for a facet with no key (one a scraper invented). */
export const facetField = (kind: string, scope: TagScope): ViewerField | null => {
    if (kind === "tag") return scope === "private" ? "privateTag" : "tag";
    if (scope === "private") return null;
    if (kind === "performer") return "performer";
    if (kind === "source") return "source";

    return null;
};

/**
 * A field's name, in the room's words: Players and Games in the Game Room, People or Performers
 * and Sources elsewhere (§21). The labeller is passed in so this stays a pure function.
 */
export const fieldTitle = (field: ViewerField, plural: (kind: string) => string): string => {
    switch (field) {
        case "performer":
            return plural("performer");
        case "source":
            return plural("source");
        case "tag":
            return plural("tag");
        case "privateTag":
            return `Private ${plural("tag").toLowerCase()}`;
        case "note":
            return "Note";
    }
};
