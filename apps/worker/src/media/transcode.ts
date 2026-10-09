import { spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import * as path from "node:path";

import {
    buildTranscodeArgs,
    parseTranscodeProgress,
    type BuildTranscodeInput,
} from "@private-stock/core";

import { resolveFfmpeg } from "./binaries.js";
import { bePolite } from "./politeSpawn.js";

/**
 * Running a transcode (§8).
 *
 * `spawn` rather than `execFile`, unlike every other ffmpeg call in this app, because this
 * one runs for minutes and has to be watched: progress has to reach the job row so the UI can
 * show it, and a cancelled or abandoned job has to be killable. `execFile` gives a promise
 * and nothing else.
 */

export interface RunTranscodeOptions extends Omit<BuildTranscodeInput, "inputPath"> {
    inputPath: string;
    /** Final destination. Written atomically — see below. */
    outputPath: string;
    durationMs: number | null;
    /** Called with 0–1 as the encode proceeds; also the job's heartbeat. */
    onProgress?: (fraction: number) => void;
    /** Aborts the encode. A killed worker's job is reclaimed by the queue instead. */
    signal?: AbortSignal;
}

export interface TranscodeResult {
    /** Whether both streams were copied rather than re-encoded. */
    remux: boolean;
    /** Wall-clock milliseconds, for the log line and for sizing future work. */
    elapsedMs: number;
}

/**
 * ffmpeg writes nothing useful to stdout unless asked, and errors to stderr.
 *
 * Kept short: on failure this becomes the job's `lastError`, which the admin view shows, and
 * ffmpeg is capable of emitting megabytes when it dislikes a file.
 */
const MAX_ERROR_CHARS = 4_000;

export const runTranscode = async (options: RunTranscodeOptions): Promise<TranscodeResult> => {
    const ffmpeg = await resolveFfmpeg();
    const startedAt = Date.now();

    await mkdir(path.dirname(options.outputPath), { recursive: true });

    /**
     * Encode to a temporary name and rename on success.
     *
     * A transcode that dies halfway — a killed container, a full disk, a corrupt region two
     * hours in — otherwise leaves a truncated MP4 exactly where the player expects a complete
     * one. The database row is only written after the rename, so there is no window in which
     * a `Variant` points at a partial file.
     */
    const tempPath = `${options.outputPath}.partial`;

    const { args, remux } = buildTranscodeArgs({
        inputPath: options.inputPath,
        settings: options.settings,
        remuxOnly: options.remuxOnly,
        videoNeedsEncode: options.videoNeedsEncode,
        audioNeedsEncode: options.audioNeedsEncode,
        threads: options.threads,
    });

    try {
        await new Promise<void>((resolve, reject) => {
            const child = spawn(ffmpeg, [...args, tempPath], {
                stdio: ["ignore", "pipe", "pipe"],
            });

            // Lowered only for background work. The thread cap above is the hard ceiling;
            // this is what keeps the encode out of the way of page serving on the way to it.
            bePolite(child);

            let stderr = "";
            let settled = false;

            const finish = (error?: Error): void => {
                if (settled) {
                    return;
                }

                settled = true;
                options.signal?.removeEventListener("abort", onAbort);

                if (error) reject(error);
                else resolve();
            };

            function onAbort(): void {
                // SIGKILL rather than SIGTERM: ffmpeg handles SIGTERM by finalising the file,
                // which for a cancelled job means spending more time producing output nobody
                // asked for.
                child.kill("SIGKILL");
                finish(new Error("Transcode cancelled"));
            }

            if (options.signal?.aborted) {
                child.kill("SIGKILL");
                finish(new Error("Transcode cancelled"));
                return;
            }

            options.signal?.addEventListener("abort", onAbort);

            child.stdout.on("data", (buffer: Buffer) => {
                const fraction = parseTranscodeProgress(
                    buffer.toString("utf8"),
                    options.durationMs
                );

                if (fraction !== null) {
                    options.onProgress?.(fraction);
                }
            });

            child.stderr.on("data", (buffer: Buffer) => {
                // Keep the tail rather than the head: ffmpeg's last words explain the failure,
                // while the first lines are usually stream descriptions.
                stderr = (stderr + buffer.toString("utf8")).slice(-MAX_ERROR_CHARS);
            });

            child.on("error", (error) => finish(error));

            child.on("close", (code) => {
                if (code === 0) {
                    finish();
                    return;
                }

                finish(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
            });
        });

        await rename(tempPath, options.outputPath);

        return { remux, elapsedMs: Date.now() - startedAt };
    } catch (error) {
        // Never leave the partial behind: it is inside the directory the web app serves
        // variants from, and it is indistinguishable from a complete file by name alone.
        await rm(tempPath, { force: true });

        throw error;
    }
};
