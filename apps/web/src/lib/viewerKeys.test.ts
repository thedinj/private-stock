import { describe, expect, it } from "vitest";

import {
    VIEWER_KEY_GROUPS,
    VIEWER_KEYS,
    facetField,
    fieldForPress,
    fieldKey,
    fieldTitle,
    keyPress,
    type ViewerField,
} from "./viewerKeys";

/**
 * The viewer's one key map (§14 "Hotkeys"). Three handlers answer it, so the only place a clash
 * can be seen before somebody presses the key is here.
 */

const FIELDS: ViewerField[] = ["performer", "source", "tag", "privateTag", "note"];

describe("the viewer's keys", () => {
    it("claims no press twice", () => {
        const presses = VIEWER_KEYS.flatMap((binding) => binding.presses);
        const repeated = presses.filter((press, index) => presses.indexOf(press) !== index);

        expect(repeated).toEqual([]);
    });

    it("gives every field exactly one key", () => {
        for (const field of FIELDS) {
            expect(VIEWER_KEYS.filter((binding) => binding.field === field)).toHaveLength(1);
        }
    });

    it("puts every binding in a group the help draws", () => {
        const groups = new Set(VIEWER_KEY_GROUPS.map(({ group }) => group));

        for (const binding of VIEWER_KEYS) expect(groups.has(binding.group)).toBe(true);
    });

    it("keeps the keys fingers already know", () => {
        const owner = (press: string) =>
            VIEWER_KEYS.find((binding) => binding.presses.includes(press))?.does;

        expect(owner("n")).toBe("Next item");
        expect(owner("d")).toMatch(/reviewed/);
        expect(owner("[")).toMatch(/in point/);
        expect(owner("Space")).toMatch(/Play/);
    });
});

describe("naming a keystroke", () => {
    it("tells the number row from the numpad", () => {
        expect(keyPress({ key: "3", code: "Digit3", shiftKey: false })).toBe("Digit3");
        expect(keyPress({ key: "3", code: "Numpad3", shiftKey: false })).toBe("Numpad3");
    });

    it("carries Shift in the character for a printable key", () => {
        expect(keyPress({ key: "t", code: "KeyT", shiftKey: false })).toBe("t");
        expect(keyPress({ key: "T", code: "KeyT", shiftKey: true })).toBe("T");
        expect(keyPress({ key: "?", code: "Slash", shiftKey: true })).toBe("?");
    });

    it("names space and the named keys", () => {
        expect(keyPress({ key: " ", code: "Space", shiftKey: false })).toBe("Space");
        expect(keyPress({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true })).toBe(
            "Shift+ArrowLeft"
        );
    });
});

describe("jumping to a field", () => {
    it("finds the field a press belongs to", () => {
        expect(fieldForPress("w")).toBe("performer");
        expect(fieldForPress("T")).toBe("privateTag");
        expect(fieldForPress("n")).toBeNull();
    });

    it("knows each facet box's field", () => {
        expect(facetField("performer", "public")).toBe("performer");
        expect(facetField("source", "public")).toBe("source");
        expect(facetField("tag", "public")).toBe("tag");
        expect(facetField("tag", "private")).toBe("privateTag");
        expect(facetField("studio", "public")).toBeNull();
        expect(fieldKey("privateTag")).toEqual(["Shift", "T"]);
        expect(fieldKey("note")).toEqual(["r"]);
    });

    it("names a field in the room's words", () => {
        const gameRoom = (kind: string) =>
            ({ performer: "Players", source: "Games", tag: "Keywords" })[kind] ?? kind;

        expect(fieldTitle("performer", gameRoom)).toBe("Players");
        expect(fieldTitle("source", gameRoom)).toBe("Games");
        expect(fieldTitle("privateTag", gameRoom)).toBe("Private keywords");
        expect(fieldTitle("note", gameRoom)).toBe("Note");
    });
});
