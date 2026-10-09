import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { TextObservation } from "../ocr.js";
import type { ReadPositions } from "../ocrRead.js";
import { assertSafeRelativePath } from "../paths.js";
import type { Config } from "../config.js";
import { dataPaths } from "./index.js";

/**
 * What Tesseract read from a tuning video, kept on disk (§5d "Tuning against expected text").
 *
 * One file per video and recognition config, mapping each frame position to what was read
 * there. Reading a frame is the only expensive part of evaluating a set of settings; every
 * other setting chooses among frames already read, so with this cache the tuner evaluates
 * thousands of candidates for the price of reading each frame once — and a second run, after
 * an administrator adds expected text, reads nothing at all.
 *
 * On disk rather than in SQLite, by the rule bulky derived output follows (§9). Derived in the
 * strict sense: deleting it costs a re-read and nothing else.
 *
 * **Keyed to the file's size and mtime.** The scanner treats a change to either as different
 * bytes, and so does this: a cache describing other bytes is discarded, not trusted.
 */

const CACHE_VERSION = 1;

export interface CachedFrame {
    /** False when no frame could be taken there — past the end, or an unreadable region. */
    read: boolean;
    observations: TextObservation[];
}

export interface TuneCache {
    version: number;
    size: number;
    mtime: number;
    positions: Record<string, CachedFrame>;
}

/** The file it describes, as the catalogue last saw it. */
export interface CachedSource {
    size: number;
    mtime: number;
}

const cachePath = (config: Config, mediaId: string, recognitionKey: string): string => {
    if (!/^[a-z0-9-]+$/i.test(recognitionKey)) {
        throw new Error(`Unsafe tuning cache key: "${recognitionKey}"`);
    }

    return path.resolve(
        dataPaths(config).ocrTune,
        assertSafeRelativePath(`${mediaId}/${recognitionKey}.json`)
    );
};

const empty = (source: CachedSource): TuneCache => ({
    version: CACHE_VERSION,
    size: source.size,
    mtime: source.mtime,
    positions: {},
});

/** The cache for one video and config, or an empty one when there is none that still applies. */
export const loadTuneCache = async (
    config: Config,
    mediaId: string,
    recognitionKey: string,
    source: CachedSource
): Promise<TuneCache> => {
    try {
        const parsed = JSON.parse(
            await readFile(cachePath(config, mediaId, recognitionKey), "utf8")
        ) as TuneCache;

        if (
            parsed.version === CACHE_VERSION &&
            parsed.size === source.size &&
            parsed.mtime === source.mtime &&
            typeof parsed.positions === "object"
        ) {
            return parsed;
        }
    } catch {
        // Absent or unreadable: start again, which costs a re-read and nothing else.
    }

    return empty(source);
};

/** Written to a temporary name and renamed, so a crash never leaves half a cache to trust. */
export const saveTuneCache = async (
    config: Config,
    mediaId: string,
    recognitionKey: string,
    cache: TuneCache
): Promise<void> => {
    const target = cachePath(config, mediaId, recognitionKey);
    const temporary = `${target}.partial`;

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(temporary, JSON.stringify(cache), "utf8");
    await rename(temporary, target);
};

/** Positions the cache does not hold yet. */
export const missingPositions = (cache: TuneCache, positions: number[]): number[] =>
    positions.filter((atMs) => !(String(atMs) in cache.positions));

/** Record what reading these positions produced, frames that could not be taken included. */
export const recordFrames = (
    cache: TuneCache,
    requested: number[],
    read: { positions: number[]; observations: TextObservation[] }
): void => {
    const readAt = new Set(read.positions);

    for (const atMs of requested) {
        cache.positions[String(atMs)] = {
            read: readAt.has(atMs),
            observations: read.observations.filter((observation) => observation.atMs === atMs),
        };
    }
};

/**
 * A reader that answers from the cache, for replaying a read plan without reading anything.
 *
 * A position the cache does not hold is an error rather than a silent empty frame: it means
 * the tuner forgot to read something, and simulating it as blank would score the settings on
 * frames that were never looked at.
 */
export const cachedReader =
    (cache: TuneCache): ReadPositions =>
    async (positions) => {
        const observations: TextObservation[] = [];
        let framesRead = 0;

        for (const atMs of positions) {
            const frame = cache.positions[String(atMs)];

            if (!frame) {
                throw new Error(`The tuning cache has no frame at ${atMs}ms`);
            }

            if (frame.read) {
                framesRead += 1;
                observations.push(...frame.observations);
            }
        }

        return { observations, framesRead };
    };

/** Forget a video's cached readings, when it leaves the bench. */
export const removeTuneCache = async (config: Config, mediaId: string): Promise<void> => {
    await rm(path.resolve(dataPaths(config).ocrTune, assertSafeRelativePath(mediaId)), {
        recursive: true,
        force: true,
    });
};
