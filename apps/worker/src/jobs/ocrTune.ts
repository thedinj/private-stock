import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
    SETTING_KEYS,
    floorsGrid,
    ocrSettingsOf,
    ocrTestSetSchema,
    pickCandidates,
    planPositions,
    recognitionAxes,
    recognitionGrid,
    recognitionKey,
    runReadPlan,
    samplingGrid,
    scoreVideo,
    totalScore,
    type ExpectedText,
    type OcrSettings,
    type RecognitionConfig,
    type TuneCandidate,
    type TuneCostWeight,
    type TuneResult,
} from "@private-stock/core";
import {
    cachedReader,
    loadConfig,
    loadTuneCache,
    missingPositions,
    recordFrames,
    saveTuneCache,
    type TuneCache,
} from "@private-stock/core/server";
import { ocrTuneRepo, settingRepo } from "@private-stock/db";

import { breathe } from "../eventLoop.js";
import { readFramesAt } from "../media/readText.js";
import { resolveSource } from "../media/sourcePath.js";
import type { JobRow } from "../queue.js";
import { loadOcrSettings } from "./ocr.js";

/**
 * The `ocrTune` job: search for the settings that best read what the bench's videos are
 * expected to say (§5d "Tuning against expected text").
 *
 * The economy that makes it affordable: Tesseract runs once per video, recognition config and
 * frame position, into an on-disk cache, and every candidate is then *replayed* from the cache
 * through `runReadPlan` — the same driver the real job reads with. Only recognition (layout
 * mode, frame width, contrast) changes what is read, so only it costs reads; sampling and
 * floors choose among frames already read, which is pure arithmetic.
 *
 * Three stages, each narrowing the next:
 *
 *  1. **Recognition** — every config ("Thorough"), or one axis at a time keeping the best of
 *     each ("Quick"), at the current sampling and floors.
 *  2. **Sampling** — the grid, for the best one or two configs. Their frames for the whole grid
 *     are read in one batch per video first, then every combination is replayed.
 *  3. **Floors** — the grid, for the best five so far. Replay only.
 *
 * A failure finishes the run as failed and is not retried: the cache keeps whatever was read,
 * so starting again resumes rather than repeats.
 */

interface Video {
    mediaId: string;
    sourcePath: string;
    hasTimeline: boolean;
    durationMs: number | null;
    size: number;
    mtime: number;
    truth: ExpectedText;
}

const payloadRunId = (job: JobRow): string | null => {
    try {
        const parsed: unknown = job.payloadJson ? JSON.parse(job.payloadJson) : null;

        return parsed && typeof parsed === "object" && "runId" in parsed
            ? String(parsed.runId)
            : null;
    } catch {
        return null;
    }
};

const recognitionOf = (settings: OcrSettings): RecognitionConfig => ({
    psm: settings.psm,
    frameWidth: settings.frameWidth,
    contrast: settings.contrast,
});

export const runOcrTune = async (job: JobRow, signal: AbortSignal): Promise<void> => {
    const runId = payloadRunId(job);
    const run = runId ? ocrTuneRepo.findById(runId) : undefined;

    if (!run || !ocrTuneRepo.markRunning(run.id)) {
        // Cancelled before it started, or already handled.
        return;
    }

    const config = loadConfig();
    const workDir = await mkdtemp(path.join(tmpdir(), "ps-ocr-tune-"));
    const started = Date.now();
    let framesExtracted = 0;
    let since = Date.now();

    try {
        const current = ocrSettingsOf(loadOcrSettings());
        const videos = loadVideos();

        if (videos.length === 0) {
            throw new Error("No video on the bench has expected text to tune against");
        }

        const caches = new Map<string, TuneCache>();

        /** The cache for a video and config, read in from disk the first time it is asked for. */
        const cacheFor = async (video: Video, key: string): Promise<TuneCache> => {
            const id = `${video.mediaId}:${key}`;
            let cache = caches.get(id);

            if (!cache) {
                cache = await loadTuneCache(config, video.mediaId, key, video);
                caches.set(id, cache);
            }

            return cache;
        };

        /** Make sure these positions are in the cache, reading only the ones that are not. */
        const ensure = async (
            video: Video,
            recognition: RecognitionConfig,
            positions: number[]
        ): Promise<TuneCache> => {
            const key = recognitionKey(recognition);
            const cache = await cacheFor(video, key);
            const missing = missingPositions(cache, positions);

            if (missing.length > 0) {
                const read = await readFramesAt(
                    video.sourcePath,
                    video.hasTimeline,
                    missing,
                    recognition,
                    workDir,
                    signal
                );

                recordFrames(cache, missing, read);
                await saveTuneCache(config, video.mediaId, key, cache);
                framesExtracted += missing.length;
            }

            return cache;
        };

        let baselineFrames = 0;
        const evaluated = new Map<string, TuneCandidate>();

        /** Score one set of settings across every video, reading only what the cache lacks. */
        const evaluate = async (
            settings: OcrSettings,
            costWeight: TuneCostWeight
        ): Promise<TuneCandidate> => {
            const id = JSON.stringify(settings);
            const known = evaluated.get(id);

            if (known) {
                return known;
            }

            const results = [];

            for (const video of videos) {
                if (signal.aborted) {
                    throw new Error("Cancelled");
                }

                const duration = video.hasTimeline ? video.durationMs : null;
                const cache = await ensure(
                    video,
                    recognitionOf(settings),
                    planPositions(duration, settings)
                );
                const read = await runReadPlan(duration, settings, cachedReader(cache));
                const found = read.worth.map((finding) => finding.text);

                results.push({
                    mediaId: video.mediaId,
                    found,
                    framesRead: read.framesRead,
                    truth: video.truth,
                    score: scoreVideo(found, video.truth),
                });

                since = await breathe(since);
            }

            const frames = results.reduce((sum, result) => sum + result.framesRead, 0);
            const totals = totalScore(
                results.map((result) => ({ ...result, foundCount: result.found.length })),
                baselineFrames || frames,
                costWeight
            );

            const candidate: TuneCandidate = {
                settings,
                ...totals,
                videos: results.map((result) => ({
                    mediaId: result.mediaId,
                    found: result.found,
                    hits: result.score.hits,
                    misses: result.score.misses,
                    unexpected: result.score.unexpected,
                    junk: result.score.junk,
                    framesRead: result.framesRead,
                })),
            };

            evaluated.set(id, candidate);

            return candidate;
        };

        const byScore = (a: TuneCandidate, b: TuneCandidate): number =>
            b.score - a.score || a.frameRatio - b.frameRatio;

        // ─── The current settings, which everything is measured against ───
        ocrTuneRepo.setProgress(run.id, "Reading with the current settings", 0.02);

        // Scored against its own frames, which is what makes its frame ratio exactly 1.
        const baseline = await evaluate(current, run.costWeight);
        baselineFrames = baseline.videos.reduce((sum, video) => sum + video.framesRead, 0);

        // ─── Stage 1: recognition ───
        const stageOne = async (): Promise<TuneCandidate[]> => {
            if (run.mode === "thorough") {
                const grid = recognitionGrid();
                const scored: TuneCandidate[] = [];

                for (const [index, recognition] of grid.entries()) {
                    ocrTuneRepo.setProgress(
                        run.id,
                        `Trying how frames are read (${index + 1} of ${grid.length})`,
                        0.05 + (0.45 * index) / grid.length
                    );
                    scored.push(await evaluate({ ...current, ...recognition }, run.costWeight));
                }

                return scored;
            }

            // Coordinate descent: one axis at a time, keeping the best of each.
            let best = baseline;
            const axes = Object.entries(recognitionAxes) as [
                keyof RecognitionConfig,
                RecognitionConfig[keyof RecognitionConfig][],
            ][];

            for (const [axisIndex, [axis, values]] of axes.entries()) {
                ocrTuneRepo.setProgress(
                    run.id,
                    `Trying how frames are read: ${axis === "psm" ? "layout mode" : axis === "contrast" ? "contrast" : "frame width"}`,
                    0.05 + (0.45 * axisIndex) / axes.length
                );

                for (const value of values) {
                    const candidate = await evaluate(
                        { ...best.settings, [axis]: value },
                        run.costWeight
                    );

                    if (byScore(candidate, best) < 0) {
                        best = candidate;
                    }
                }
            }

            return [...evaluated.values()];
        };

        const recognised = (await stageOne()).sort(byScore);

        // ─── Stage 2: sampling, for the best one or two ways of reading ───
        const configs = [
            ...new Map(
                recognised.map((candidate) => [
                    recognitionKey(recognitionOf(candidate.settings)),
                    candidate.settings,
                ])
            ).values(),
        ].slice(0, run.mode === "thorough" ? 2 : 1);

        const grid = samplingGrid();
        const sampled: TuneCandidate[] = [];

        for (const [configIndex, base] of configs.entries()) {
            // Every frame any sampling in the grid could want, read in one batch per video, so
            // the replays below never stop to read.
            for (const video of videos) {
                const duration = video.hasTimeline ? video.durationMs : null;
                const union = new Set<number>();

                for (const sampling of grid) {
                    for (const atMs of planPositions(duration, { ...base, ...sampling })) {
                        union.add(atMs);
                    }
                }

                ocrTuneRepo.setProgress(
                    run.id,
                    "Reading the frames other samplings would use",
                    0.5 + (0.1 * configIndex) / configs.length
                );
                await ensure(
                    video,
                    recognitionOf(base),
                    [...union].sort((a, b) => a - b)
                );
            }

            for (const [index, sampling] of grid.entries()) {
                if (index % 50 === 0) {
                    ocrTuneRepo.setProgress(
                        run.id,
                        "Trying which frames are read",
                        0.6 + (0.25 * (configIndex + index / grid.length)) / configs.length
                    );
                }

                sampled.push(await evaluate({ ...base, ...sampling }, run.costWeight));
            }
        }

        // ─── Stage 3: floors, for the best five so far ───
        const leaders = [...recognised, ...sampled].sort(byScore).slice(0, 5);
        const floors = floorsGrid();

        for (const [leaderIndex, leader] of leaders.entries()) {
            ocrTuneRepo.setProgress(
                run.id,
                "Trying what is kept",
                0.85 + (0.14 * leaderIndex) / leaders.length
            );

            for (const floor of floors) {
                await evaluate({ ...leader.settings, ...floor }, run.costWeight);
            }
        }

        const candidates = [...evaluated.values()];
        const result: TuneResult = {
            baseline,
            picks: pickCandidates(candidates, baseline),
            evaluated: candidates.length,
            framesExtracted,
            elapsedMs: Date.now() - started,
        };

        ocrTuneRepo.complete(run.id, JSON.stringify(result));
    } catch (error) {
        if (signal.aborted) {
            ocrTuneRepo.finish(run.id, "cancelled", null);
            throw error;
        }

        ocrTuneRepo.finish(
            run.id,
            "failed",
            error instanceof Error ? error.message : String(error)
        );
    } finally {
        await rm(workDir, { recursive: true, force: true });
    }
};

/** The bench's videos that have expected text, with what the tuner needs about each. */
const loadVideos = (): Video[] => {
    const parsed = ocrTestSetSchema.safeParse(settingRepo.get(SETTING_KEYS.ocrTestSet, []));
    const entries = (parsed.success ? parsed.data : []).filter(
        (entry) => entry.expected.length > 0
    );
    const sources = new Map(
        ocrTuneRepo
            .listSources(entries.map((entry) => entry.mediaId))
            .map((source) => [source.mediaId, source])
    );

    return entries.flatMap((entry): Video[] => {
        const source = sources.get(entry.mediaId);
        const resolved = source ? resolveSource(source.fileId) : null;

        if (!source || !resolved) {
            return [];
        }

        return [
            {
                mediaId: entry.mediaId,
                sourcePath: resolved.absolutePath,
                hasTimeline: source.kind === "video",
                durationMs: source.durationMs,
                size: source.size,
                mtime: source.mtime,
                truth: { expected: entry.expected, complete: entry.complete },
            },
        ];
    });
};
