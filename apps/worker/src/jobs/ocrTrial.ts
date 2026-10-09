import { ocrSettingsSchema, type OcrTrialFinding } from "@private-stock/core";
import { mediaRepo, ocrTrialRepo } from "@private-stock/db";

import { readText } from "../media/readText.js";
import { resolveSource } from "../media/sourcePath.js";
import type { JobRow } from "../queue.js";

/**
 * The `ocrTrial` job: read one video under each set of settings on the test bench (§5d
 * "Settings and the test bench").
 *
 * Through `readText`, the code the `ocr` job reads with, so the comparison measures the
 * settings and nothing else. What it reads goes to the trial rows and nowhere else: a trial is
 * what a candidate *would* store, and nothing anybody searches changes until the candidate is
 * made the settings.
 *
 * One job per video runs every pending trial it has, and keeps going until none are left, so a
 * comparison started again while this one runs is picked up rather than dropped by the queue.
 * A trial that fails is recorded as failed and the job moves on: the bench shows the error,
 * and retrying the whole job would read the other side again for nothing.
 */
export const runOcrTrial = async (job: JobRow, signal: AbortSignal): Promise<void> => {
    if (!job.mediaId || !job.fileId) {
        throw new Error("ocrTrial job requires both mediaId and fileId");
    }

    const media = mediaRepo.findBasic(job.mediaId);
    const source = resolveSource(job.fileId);

    for (
        let trial = ocrTrialRepo.nextPending(job.mediaId);
        trial;
        trial = ocrTrialRepo.nextPending(job.mediaId)
    ) {
        if (!ocrTrialRepo.markRunning(trial.id)) {
            continue;
        }

        if (!media || !source) {
            ocrTrialRepo.fail(trial.id, "The file is no longer in the library");
            continue;
        }

        try {
            const settings = ocrSettingsSchema.parse(JSON.parse(trial.settingsJson));
            const hasTimeline = media.kind === "video";
            const started = Date.now();
            const result = await readText(
                source.absolutePath,
                hasTimeline,
                media.durationMs,
                settings,
                signal
            );

            const findings: OcrTrialFinding[] = result.worth.map((finding) => ({
                text: finding.text,
                textNorm: finding.textNorm,
                confidence: finding.confidence,
                occurrences: finding.occurrences,
                stability: finding.stability,
                firstAtMs: hasTimeline ? finding.firstAtMs : null,
            }));

            ocrTrialRepo.complete(trial.id, {
                findingsJson: JSON.stringify(findings),
                framesRead: result.framesRead,
                elapsedMs: Date.now() - started,
            });
        } catch (error) {
            // A cancelled job is stopping, not failing; leave the trial for whoever runs next.
            if (signal.aborted) {
                throw error;
            }

            ocrTrialRepo.fail(trial.id, error instanceof Error ? error.message : String(error));
        }
    }
};
