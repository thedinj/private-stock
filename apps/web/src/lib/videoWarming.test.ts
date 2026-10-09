import { describe, expect, it } from "vitest";

import { warmingAllowed, warmingRefusal, type DeviceSignals } from "./videoWarming";

/**
 * Who pays for the preload (§8b).
 *
 * The rule is a cost decision, not a capability one: every device here *could* fetch the next
 * video, and the question is whether doing it uninvited is defensible.
 */

const desktop: DeviceSignals = {
    saveData: false,
    effectiveType: "4g",
    coarsePointer: false,
    narrow: false,
};

describe("who gets the next item warmed", () => {
    it("allows a desktop on a real connection", () => {
        expect(warmingAllowed(desktop)).toBe(true);
    });

    /** No Network Information API at all, which is Safari. Absence is not evidence of slow. */
    it("allows a browser that will not say what the connection is", () => {
        expect(warmingAllowed({ ...desktop, effectiveType: null })).toBe(true);
    });
});

describe("who does not", () => {
    /** The only signal that is a request rather than an inference, so it settles it alone. */
    it("refuses when the viewer has asked for less data", () => {
        expect(warmingAllowed({ ...desktop, saveData: true })).toBe(false);
    });

    it("refuses a slow connection", () => {
        for (const effectiveType of ["slow-2g", "2g", "3g"]) {
            expect(warmingAllowed({ ...desktop, effectiveType })).toBe(false);
        }
    });

    it("refuses a phone", () => {
        expect(warmingAllowed({ ...desktop, coarsePointer: true, narrow: true })).toBe(false);
    });
});

describe("the pair of signals a phone is recognised by", () => {
    /**
     * Either signal alone is somebody else. A narrow window is a resized desktop browser; a
     * coarse pointer on a wide screen is a touchscreen laptop or a television on a LAN — which
     * is the device that benefits most, not the one to protect.
     */
    it("allows a resized desktop window", () => {
        expect(warmingAllowed({ ...desktop, narrow: true })).toBe(true);
    });

    it("allows a touchscreen on a wide screen", () => {
        expect(warmingAllowed({ ...desktop, coarsePointer: true })).toBe(true);
    });
});

describe("saying why", () => {
    /** The admin tools and the warming overlay show this, so it has to name the signal. */
    it("names the signal that refused", () => {
        expect(warmingRefusal({ ...desktop, saveData: true })).toBe("Save-Data is on");
        expect(warmingRefusal({ ...desktop, effectiveType: "3g" })).toBe("connection is 3g");
        expect(warmingRefusal({ ...desktop, coarsePointer: true, narrow: true })).toBe(
            "phone-sized touch device"
        );
    });

    it("has nothing to say about a device that may warm", () => {
        expect(warmingRefusal(desktop)).toBeNull();
    });
});
