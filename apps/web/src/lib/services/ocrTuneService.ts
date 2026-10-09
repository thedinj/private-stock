import {
    AuthorizationError,
    ConflictError,
    SETTING_KEYS,
    ValidationError,
    ocrSettingsOf,
    ocrSettingsRecordSchema,
    planPositions,
    recognitionAxes,
    recognitionGrid,
    recognitionKey,
    samplingGrid,
    tuneResultSchema,
    type OcrSettings,
    type RecognitionConfig,
    type TuneEstimate,
    type TuneEstimates,
    type TuneMode,
    type TuneRun,
    type TuneStartInput,
    type TuneView,
} from "@private-stock/core";
import { loadConfig, loadTuneCache, missingPositions } from "@private-stock/core/server";
import { ocrTuneRepo, settingRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { loadTestSet } from "./ocrBenchService";

/**
 * Tuning OCR against expected text (§5d "Tuning against expected text").
 *
 * The search itself runs in the worker (`jobs/ocrTune.ts`); this starts and stops it, and says
 * before it starts how much reading it will take — an estimate from the same plans and the same
 * cache the worker uses, so "nothing to read" here means the run will read nothing.
 */

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can tune OCR");
    }
};

/** Frames per second when no run has measured it yet: deliberately on the slow side. */
const ASSUMED_FRAMES_PER_SECOND = 1.5;

const currentSettings = (): OcrSettings => {
    const stored = ocrSettingsRecordSchema.safeParse(settingRepo.get(SETTING_KEYS.ocr, {}));

    return ocrSettingsOf(stored.success ? stored.data : ocrSettingsRecordSchema.parse({}));
};

const toRun = (row: ocrTuneRepo.OcrTuneRunRow): TuneRun => {
    const parsed = row.resultJson ? tuneResultSchema.safeParse(JSON.parse(row.resultJson)) : null;

    return {
        id: row.id,
        state: row.state,
        mode: row.mode,
        costWeight: row.costWeight,
        stage: row.stage,
        progress: row.progress,
        result: parsed?.success ? parsed.data : null,
        error: row.error,
        createdAt: row.createdAt,
        finishedAt: row.finishedAt,
    };
};

/**
 * The recognition configs a run will read with, as far as can be known in advance.
 *
 * Exact for "Thorough". For "Quick" the walk depends on what it finds, so this takes every
 * single-axis change from the current settings — what the first step tries for certain, and a
 * fair stand-in for the rest.
 */
const configsFor = (mode: TuneMode, current: OcrSettings): RecognitionConfig[] => {
    const base: RecognitionConfig = {
        psm: current.psm,
        frameWidth: current.frameWidth,
        contrast: current.contrast,
    };
    const configs =
        mode === "thorough"
            ? [base, ...recognitionGrid()]
            : [
                  base,
                  ...recognitionAxes.psm.map((psm) => ({ ...base, psm })),
                  ...recognitionAxes.contrast.map((contrast) => ({ ...base, contrast })),
                  ...recognitionAxes.frameWidth.map((frameWidth) => ({ ...base, frameWidth })),
              ];

    return [...new Map(configs.map((config) => [recognitionKey(config), config])).values()];
};

const estimateFor = async (
    mode: TuneMode,
    current: OcrSettings,
    rate: number
): Promise<TuneEstimate> => {
    const config = loadConfig();
    const entries = loadTestSet().filter((entry) => entry.expected.length > 0);
    const sources = ocrTuneRepo.listSources(entries.map((entry) => entry.mediaId));
    const configs = configsFor(mode, current);
    const grid = samplingGrid();
    let framesToRead = 0;

    for (const source of sources) {
        const duration = source.kind === "video" ? source.durationMs : null;
        const plan = planPositions(duration, current);

        for (const recognition of configs) {
            const cache = await loadTuneCache(
                config,
                source.mediaId,
                recognitionKey(recognition),
                source
            );

            framesToRead += missingPositions(cache, plan).length;
        }

        // The sampling stage reads the frames every sampling in the grid could want, for the
        // best one way of reading ("Quick") or two ("Thorough"). Estimated against the current
        // way of reading, which is the likeliest winner.
        const union = new Set<number>();

        for (const sampling of grid) {
            for (const atMs of planPositions(duration, { ...current, ...sampling })) {
                union.add(atMs);
            }
        }

        const cache = await loadTuneCache(config, source.mediaId, recognitionKey(current), source);
        const extra = missingPositions(
            cache,
            [...union].filter((atMs) => !plan.includes(atMs))
        ).length;

        framesToRead += extra * (mode === "thorough" ? 2 : 1);
    }

    return {
        videos: sources.length,
        framesToRead,
        minutes: Math.ceil(framesToRead / rate / 60),
    };
};

const latestRun = (): TuneRun | null => {
    const latest = ocrTuneRepo.findLatest();

    return latest ? toRun(latest) : null;
};

export const getTune = (auth: AuthContext): TuneView => {
    requireAdmin(auth);

    return { latest: latestRun() };
};

/**
 * What each mode would read that the cache does not hold yet.
 *
 * Its own request because it opens every cache file, which is too much to repeat on every
 * poll of a running search. The rate is what the last run measured, when it read enough
 * frames to say.
 */
export const estimateTune = async (auth: AuthContext): Promise<TuneEstimates> => {
    requireAdmin(auth);

    const measured = latestRun()?.result;
    const rate =
        measured && measured.framesExtracted >= 20 && measured.elapsedMs > 0
            ? measured.framesExtracted / (measured.elapsedMs / 1000)
            : ASSUMED_FRAMES_PER_SECOND;
    const current = currentSettings();

    return {
        quick: await estimateFor("quick", current, rate),
        thorough: await estimateFor("thorough", current, rate),
    };
};

export const startTune = (input: TuneStartInput, auth: AuthContext): TuneView => {
    requireAdmin(auth);

    if (ocrTuneRepo.findActive()) {
        throw new ConflictError("A tuning run is already going; stop it or wait for it to finish");
    }

    const usable = loadTestSet().filter((entry) => entry.expected.length > 0);

    if (usable.length === 0) {
        throw new ValidationError(
            "Say what at least one video on the bench should read before tuning"
        );
    }

    ocrTuneRepo.start(input.mode, input.costWeight, auth.userId);

    return getTune(auth);
};

export const stopTune = (auth: AuthContext): TuneView => {
    requireAdmin(auth);

    ocrTuneRepo.cancelActive();

    return getTune(auth);
};
