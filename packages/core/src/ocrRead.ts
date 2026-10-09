import {
    isWorthStoring,
    ocrFramePlan,
    reconcileText,
    type ReconciledText,
    type TextObservation,
} from "./ocr.js";
import type { OcrSettings } from "./ocrSettings.js";

/**
 * How a file is read, as pure logic (§5d).
 *
 * Three passes with early exits, and the arithmetic in §5d is why there are three. The probe
 * is the exit for most of a library; the burst looks where cards are; the sweep establishes
 * that a watermark persists and stops as soon as it has.
 *
 * Pure because of what reads through it. The `ocr` job and the bench's trials pass a reader
 * that extracts frames and runs Tesseract. The tuner (§5d "Tuning against expected text")
 * passes one that looks the frames up in a cache of what Tesseract said before — so a
 * simulated read is what the real job would have done with the same frames, by construction,
 * rather than by a second implementation kept in step by hand.
 */

/** What a reader reports for a batch of positions. */
export interface ReadBatch {
    /** Every observation, with `atMs` and fractional boxes. */
    observations: TextObservation[];
    /** Positions a frame could actually be taken at. A seek past the end yields none. */
    framesRead: number;
}

export type ReadPositions = (positions: number[]) => Promise<ReadBatch>;

export interface ReadPlanResult {
    /** What clears the storage floors: what the `ocr` job would store. */
    worth: ReconciledText[];
    framesRead: number;
}

/** How many sweep positions are read per batch, so the sweep can stop between batches. */
const SWEEP_BATCH = 8;

export const runReadPlan = async (
    durationMs: number | null,
    settings: OcrSettings,
    readPositions: ReadPositions
): Promise<ReadPlanResult> => {
    const plan = ocrFramePlan(durationMs, settings);
    const worthStoring = (finding: ReconciledText): boolean => isWorthStoring(finding, settings);
    const observations: TextObservation[] = [];
    let framesRead = 0;

    /**
     * Has anything here been seen more than once in the same place?
     *
     * The probe's question, and it is deliberately not "did one frame read something
     * confidently". Per-frame confidence is unreliable — that is the premise the whole
     * reconciler rests on — and a faint watermark read at 0.31 in every frame is exactly the
     * file this feature exists for. Measured: a floor alone discarded one, unexamined.
     */
    const foundSomething = (findings: ReconciledText[]): boolean =>
        findings.some((finding) => finding.occurrences >= 2 || worthStoring(finding));

    /** Read a pass, and fold what it said into everything said so far. */
    const runPass = async (positions: number[]): Promise<ReconciledText[]> => {
        if (positions.length > 0) {
            const batch = await readPositions(positions);

            observations.push(...batch.observations);
            framesRead += batch.framesRead;
        }

        return reconcileText(observations, Math.max(1, framesRead), {
            minLength: settings.minLength,
        });
    };

    let findings = await runPass(plan.probe);

    if (!foundSomething(findings)) {
        return { worth: [], framesRead };
    }

    findings = await runPass(plan.burst);

    // The sweep, abandoned as soon as a string is confirmed: more of the same frame after
    // that adds occurrences and no information. Batches are what make "as soon as" possible.
    for (let at = 0; at < plan.sweep.length; at += SWEEP_BATCH) {
        if (findings.some((finding) => finding.occurrences >= settings.confirmedOccurrences)) {
            break;
        }

        findings = await runPass(plan.sweep.slice(at, at + SWEEP_BATCH));
    }

    return { worth: findings.filter(worthStoring), framesRead };
};

/** Every position any pass of this plan could read, for filling a cache ahead of simulating. */
export const planPositions = (durationMs: number | null, settings: OcrSettings): number[] => {
    const plan = ocrFramePlan(durationMs, settings);

    return [...new Set([...plan.probe, ...plan.burst, ...plan.sweep])].sort((a, b) => a - b);
};
