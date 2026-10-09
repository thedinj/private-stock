import {
    OCR_RECIPE_UNRECORDED,
    SETTING_KEYS,
    ocrRecipe,
    ocrSettingsRecordSchema,
    type OcrSettingsRecord,
    type StageOutcome,
} from "@private-stock/core";
import {
    mediaRepo,
    mediaTextRepo,
    ocrTagMatchRepo,
    searchRepo,
    settingRepo,
} from "@private-stock/db";

import { readText } from "../media/readText.js";
import { resolveSource } from "../media/sourcePath.js";
import { settledTwin } from "../media/twin.js";
import type { JobRow } from "../queue.js";

/**
 * The `ocr` job: text burned into the picture (§5d).
 *
 * Burned-in text is frequently the only trustworthy metadata a file carries — a studio name,
 * a site watermark, a name card — because the filename is often noise and there is no
 * sidecar. This reads it.
 *
 * `optIn` (§7b): nothing sweeps it until an administrator switches it on. Library-wide
 * recognition is expensive enough that asking for it has to be a decision somebody makes,
 * rather than something the pipeline starts doing to two hundred thousand files by itself.
 *
 * A run replaces only the findings nobody has reviewed (§5d "Reviewing what was read"):
 * confirmed, corrected and dismissed text survives it, and the run does not read back a string
 * somebody already decided about.
 *
 * The reading itself is `readText`, shared with the test bench so a comparison there measures
 * the settings and nothing else.
 */

const stringsOf = (mediaId: string): string[] =>
    mediaTextRepo.listForMedia(mediaId, { includeDismissed: true }).map((row) => row.textNorm);

/**
 * Match the item's strings against the performers and sources (§5d "Tagging performers and
 * sources from what was read"), and recount the ones it no longer shows: the strings it read
 * last time are owed one item fewer.
 */
const rematch = (mediaId: string, before: string[]): void => {
    ocrTagMatchRepo.rematchStrings([...before, ...stringsOf(mediaId)]);
};

/**
 * The settings, read once at the start of each job (§5d "What happens when OCR settings
 * change").
 *
 * Once, so a save part-way through cannot leave one file read under two sets of settings; at
 * the start rather than when queued, so a job waiting in the queue uses whatever is current
 * when it runs. A malformed stored value falls back to the defaults rather than stopping OCR.
 */
export const loadOcrSettings = (): OcrSettingsRecord => {
    const parsed = ocrSettingsRecordSchema.safeParse(settingRepo.get(SETTING_KEYS.ocr, {}));

    return parsed.success ? parsed.data : ocrSettingsRecordSchema.parse({});
};

export const runOcr = async (job: JobRow, signal: AbortSignal): Promise<StageOutcome | void> => {
    if (!job.mediaId || !job.fileId) {
        throw new Error("ocr job requires both mediaId and fileId");
    }

    const mediaId = job.mediaId;
    const media = mediaRepo.findBasic(mediaId);

    if (!media) {
        return "skipped";
    }

    /**
     * The original, never a rendition.
     *
     * The same rule a captured frame follows (§13). A web-safe transcode is exactly where
     * faint text dies: it is encoded for motion at a bitrate that treats a thin white
     * watermark as noise to be smoothed away, and reading it would be reading our own
     * compression artefacts back.
     */
    const source = resolveSource(job.fileId);

    if (!source) {
        return "skipped";
    }

    const settings = loadOcrSettings();
    const recipe = ocrRecipe(settings);
    const hasTimeline = media.kind === "video";

    /**
     * An identical copy has been read already (§10f), and this is the most expensive stage
     * there is. Its findings, including finding nothing, are this item's too — but only if it
     * was read under the current settings. Borrowing from a copy read under older ones would
     * hide a settings change behind an old answer.
     */
    const twin = settledTwin(job.fileId, "ocr", {
        current: recipe,
        unrecordedAs: OCR_RECIPE_UNRECORDED,
    });

    if (twin) {
        // Decisions included: a string dismissed or corrected on one copy is the same string
        // on the other (§5d "Reviewing what was read").
        const before = stringsOf(mediaId);

        mediaTextRepo.adoptFindings(
            mediaId,
            mediaTextRepo.listForMedia(twin.mediaId, { includeDismissed: true }),
            hasTimeline
        );
        searchRepo.requestReindex([mediaId]);
        rematch(mediaId, before);

        return { state: twin.state, recipe };
    }

    const { worth } = await readText(
        source.absolutePath,
        hasTimeline,
        media.durationMs,
        settings,
        signal
    );

    /**
     * `empty` when nothing cleared the floors — not `failed`.
     *
     * Most files carry no burned-in text, and that is an answer rather than a problem. The
     * distinction is what stops the stage being retried forever on the majority of a library
     * (§7b). The machine findings are still replaced: an item that had text under the old
     * settings and has none under these should say so.
     */
    const before = stringsOf(mediaId);

    mediaTextRepo.replaceMachineFindings(mediaId, worth, hasTimeline);

    // Text is part of what an item matches on, so the document is now out of date.
    searchRepo.requestReindex([mediaId]);
    rematch(mediaId, before);

    return { state: worth.length === 0 ? "empty" : "done", recipe };
};
