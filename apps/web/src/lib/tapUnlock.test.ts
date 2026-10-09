import { describe, expect, it } from "vitest";

import { recordTap, tapsRemaining, TAP_GAP_MS, TAPS_TO_UNLOCK } from "./tapUnlock";

const tapRun = (count: number, gap = 200): number[] => {
    let run: number[] = [];

    for (let index = 0; index < count; index++) {
        run = recordTap(run, index * gap);
    }

    return run;
};

describe("seven taps on the build line", () => {
    it("opens after seven quick taps", () => {
        expect(tapsRemaining(tapRun(TAPS_TO_UNLOCK))).toBe(0);
    });

    it("counts down before that", () => {
        expect(tapsRemaining(tapRun(4))).toBe(3);
    });

    /** Somebody who taps the line twice today and five times tomorrow has not asked for it. */
    it("starts again after a pause", () => {
        const run = recordTap(tapRun(6), 5 * 200 + TAP_GAP_MS + 1);

        expect(tapsRemaining(run)).toBe(TAPS_TO_UNLOCK - 1);
    });

    it("never holds more than it needs", () => {
        expect(tapRun(20)).toHaveLength(TAPS_TO_UNLOCK);
    });
});
