import { describe, expect, it } from "vitest";

import {
    OCR_CONFIDENCE_MIN,
    OCR_MAX_FRAMES,
    OCR_OCCURRENCES_MIN,
    isWorthStoring,
    ocrFramePlan,
    type ReconciledText,
} from "./ocr.js";
import { ocrRecipe, ocrSettingsRecordSchema, ocrSettingsSchema } from "./ocrSettings.js";

/**
 * OCR's settings (§5d "Settings and the test bench"). The promise that matters most is the
 * first one: a library where nobody has opened the settings reads exactly as it did before
 * they existed.
 */
describe("OCR settings", () => {
    const defaults = ocrSettingsSchema.parse({});

    it("defaults to the constants the feature was calibrated with", () => {
        expect(defaults.confidenceMin).toBe(OCR_CONFIDENCE_MIN);
        expect(defaults.occurrencesMin).toBe(OCR_OCCURRENCES_MIN);
        expect(defaults.maxFrames).toBe(OCR_MAX_FRAMES);
        expect(defaults.psm).toBe(6);
        expect(defaults.frameWidth).toBe(1600);
        expect(defaults.contrast).toBe(true);

        // The production calibration of 2026-10-02, as its settings page saved it (revision 1).
        // A change to any default is a recalibration, and belongs in §5d with its reason.
        expect(defaults).toEqual({
            confidenceMin: 0.5,
            occurrencesMin: 2,
            minLength: 4,
            probeFrames: 6,
            burstSeconds: 30,
            burstEverySeconds: 3,
            sweepEverySeconds: 300,
            maxFrames: 40,
            confirmedOccurrences: 6,
            psm: 6,
            frameWidth: 1600,
            contrast: true,
        });

        // The plan from the settings' defaults is the plan from no settings at all.
        for (const duration of [null, 5_000, 90_000, 2 * 60 * 60 * 1000]) {
            expect(ocrFramePlan(duration, defaults)).toEqual(ocrFramePlan(duration));
        }
    });

    it("changes the plan when the sampling changes", () => {
        const twoHours = 2 * 60 * 60 * 1000;
        const sparse = ocrFramePlan(twoHours, { ...defaults, sweepEverySeconds: 600 });
        const capped = ocrFramePlan(twoHours, { ...defaults, maxFrames: 10 });

        expect(sparse.sweep.length).toBeLessThan(ocrFramePlan(twoHours, defaults).sweep.length);
        expect(capped.probe.length + capped.burst.length + capped.sweep.length).toBeLessThanOrEqual(
            10
        );
    });

    it("applies the storage floors it is given", () => {
        const finding = { confidence: 0.5, occurrences: 3 } as ReconciledText;

        expect(isWorthStoring(finding)).toBe(true);
        expect(isWorthStoring(finding, { confidenceMin: 0.6, occurrencesMin: 1 })).toBe(false);
        expect(isWorthStoring(finding, { confidenceMin: 0.1, occurrencesMin: 4 })).toBe(false);
    });

    it("refuses a layout mode nobody offered, and clamps nothing silently", () => {
        expect(ocrSettingsSchema.safeParse({ psm: 3 }).success).toBe(false);
        expect(ocrSettingsSchema.safeParse({ confidenceMin: 1.5 }).success).toBe(false);
    });

    it("records which revision produced an outcome", () => {
        const stored = ocrSettingsRecordSchema.parse({ revision: 4 });

        expect(ocrRecipe(stored)).toBe("settings-4");
        expect(ocrRecipe(ocrSettingsRecordSchema.parse({}))).toBe("settings-0");
    });
});
