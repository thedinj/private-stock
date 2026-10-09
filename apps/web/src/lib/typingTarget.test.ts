import { describe, expect, it } from "vitest";

import { isTypingElement, type KeyTarget } from "./typingTarget";

/**
 * Which keystrokes the viewer's hotkeys stand aside for.
 *
 * Wrong in either direction it fails silently: too broad and the numpad stops rating the moment
 * somebody clicks a star, too narrow and a letter typed into a note walks the library instead of
 * appearing in the note.
 */

const target = (tagName: string, inputType: string | null = null): KeyTarget => ({
    tagName,
    inputType,
    contentEditable: false,
});

describe("standing aside for typing", () => {
    it("stands aside for a text field", () => {
        for (const type of [null, "text", "search", "number", "email", "password", "url"]) {
            expect(isTypingElement(target("INPUT", type))).toBe(true);
        }
    });

    it("stands aside for a textarea and a select", () => {
        expect(isTypingElement(target("TEXTAREA"))).toBe(true);
        expect(isTypingElement(target("SELECT"))).toBe(true);
    });

    it("stands aside for a rich-text field, which is a div", () => {
        expect(isTypingElement({ ...target("DIV"), contentEditable: true })).toBe(true);
    });

    it("does not stand aside for a star rating, which is a radio", () => {
        // The whole reason this exists: Mantine renders a rating as radios, so a guard on the
        // tag name silenced every hotkey as soon as anybody rated with the mouse.
        expect(isTypingElement(target("INPUT", "radio"))).toBe(false);
    });

    it("does not stand aside for the other inputs that swallow no text", () => {
        for (const type of ["checkbox", "range", "button", "submit", "reset", "color", "file"]) {
            expect(isTypingElement(target("INPUT", type))).toBe(false);
        }
    });

    it("does not stand aside for the scrubber, a div with a slider role", () => {
        expect(isTypingElement(target("DIV"))).toBe(false);
    });

    it("does not stand aside for the video or a button", () => {
        expect(isTypingElement(target("VIDEO"))).toBe(false);
        expect(isTypingElement(target("BUTTON"))).toBe(false);
    });

    it("treats an input type nobody listed as typing", () => {
        // The safe side, and the reason this is a deny-list: a field that takes characters and
        // is not named here must not have its keystrokes stolen. A hotkey that does not fire is
        // visible immediately; a lost character is not.
        expect(isTypingElement(target("INPUT", "some-future-text-type"))).toBe(true);
    });
});
