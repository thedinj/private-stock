import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { InferenceSession } from "onnxruntime-node";
import { z } from "zod";

import { createClipTokenizer, type ClipTokenizer } from "../clipTokenizer.js";
import { NotFoundError } from "../errors.js";

/**
 * The models built into the image, and how to open one (§5e).
 *
 * In `core/server` for ffmpeg's reason: two processes need it. The worker embeds frames; the
 * web app encodes the words somebody typed. Where the files are and how a session is opened
 * must have one definition, because the thread count in particular is a politeness decision
 * (§7c) and a second copy would be a second chance to get it wrong.
 */

const modelSchema = z.object({
    id: z.string().min(1),
    // A model, or the data a model needs beside it: the tokenizer's vocabulary and merges.
    file: z.string().regex(/^[\w.-]+\.(onnx|json|txt)$/),
    url: z.string().url(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().positive(),
});

const manifestSchema = z.object({ models: z.array(modelSchema).min(1) });

export type ModelEntry = z.infer<typeof modelSchema>;

const MANIFEST = path.join("models", "manifest.json");

/**
 * The directory holding `manifest.json` and the model files.
 *
 * Found by walking up rather than from the workspace root, because the web app's standalone
 * server changes into `apps/web` before anything runs and the container has no workspace marker
 * — `findWorkspaceRoot` would answer `/app/apps/web` there. Walking up from both the working
 * directory and this module's own location finds `/app/models` in the container and
 * `<repo>/models` in development, whichever process is asking.
 */
export const findModelsDir = (): string => {
    const starts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];

    for (const start of starts) {
        let current = path.resolve(start);

        for (;;) {
            if (existsSync(path.join(current, MANIFEST))) {
                return path.join(current, "models");
            }

            const parent = path.dirname(current);

            if (parent === current) break;

            current = parent;
        }
    }

    throw new NotFoundError(
        `No ${MANIFEST} above ${starts.join(" or ")}. The models ship in the image; in development run \`pnpm models:fetch\`.`
    );
};

export const readModelManifest = (dir: string = findModelsDir()): ModelEntry[] =>
    manifestSchema.parse(JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"))).models;

/**
 * The absolute path of a model's file, checked to be present and the size the manifest says.
 *
 * Size, not checksum: hashing a few hundred MB on every process start would cost seconds of
 * disk the NAS does not have (§20). The checksum is verified once, when the file is fetched.
 */
const modelPath = (id: string, dir: string = findModelsDir()): string => {
    const entry = readModelManifest(dir).find((model) => model.id === id);

    if (!entry) {
        throw new NotFoundError(`No model "${id}" in ${path.join(dir, "manifest.json")}.`);
    }

    const file = path.join(dir, entry.file);

    if (!existsSync(file) || statSync(file).size !== entry.bytes) {
        throw new NotFoundError(
            `Model "${id}" is missing or incomplete at ${file}. Run \`pnpm models:fetch\`.`
        );
    }

    return file;
};

export interface OpenModelOptions {
    /**
     * Threads for one inference. Background work passes the per-job cap (§7c): a session that
     * takes every core freezes the web process as surely as an ffmpeg that does (§20).
     */
    threads: number;
    /**
     * Whether onnxruntime may keep its CPU memory arena and pre-planned buffers. Default true.
     *
     * Off for a process that exits rather than releases (the embedder child, §5e "Memory"). The
     * arena grows in powers of two and keeps a block for every input shape it has seen; measured
     * in the container, a child embedding real sprite sheets at sixteen squares a run reached
     * ~400 MB, and one square a run without the arena held ~210 MB at the same speed. The cost
     * the arena was kept on for — a released session keeping everything — does not apply to a
     * process that ends instead of releasing.
     */
    arena?: boolean;
    /**
     * How far onnxruntime may rewrite the graph before running it. Default `all`.
     *
     * `basic` for the face models (§5f): at `all` the runtime converts their layers to layouts
     * that hold far more memory, and in the container the pair settled at ~572 MB against ~440 MB
     * at `basic` — the difference between fitting beside the database's page cache and not. The
     * outputs are the same (cosine 1.0000000 for the recogniser, differences of ~2e-6 in the
     * detector's scores); detection is ~30% slower and recognition ~30% faster.
     */
    optimization?: "all" | "basic";
}

/**
 * The session options `openModel` passes, apart from where the model is.
 *
 * Its own function so the thread count — a politeness decision (§7c) — and the memory settings
 * can be asserted without loading a model.
 */
export const sessionOptions = (options: OpenModelOptions): InferenceSession.SessionOptions => {
    const arena = options.arena ?? true;

    return {
        // Never zero: onnxruntime reads 0 as "every core it can see", which inside a container
        // is the host's, not the quota's (§20).
        intraOpNumThreads: Math.max(1, Math.floor(options.threads)),
        interOpNumThreads: 1,
        executionMode: "sequential",
        graphOptimizationLevel: options.optimization ?? "all",
        enableCpuMemArena: arena,
        enableMemPattern: arena,
        // Errors only. The face detector's file declares a fixed 640×640 output shape and is fed
        // tiles trimmed to their own aspect, which it handles — but onnxruntime warns about the
        // mismatch on every run, and the faces stage runs it a hundred times a video (§5f).
        logSeverityLevel: 3,
    };
};

/**
 * Open a model for inference.
 *
 * `onnxruntime-node` is imported here, on first use, not at the top of the module. Both
 * processes import `core/server` for other reasons, and loading the native runtime costs
 * resident memory inside a container whose cap includes its page cache (§5e "Memory"). A
 * library that never turns the feature on should never pay for it.
 *
 * The caller owns the session and must `release()` it when idle; nothing is cached here.
 */
export const openModel = async (
    id: string,
    options: OpenModelOptions
): Promise<InferenceSession> => {
    const file = modelPath(id);
    const ort = await import("onnxruntime-node");

    return ort.InferenceSession.create(file, sessionOptions(options));
};

/**
 * CLIP's tokenizer, from the vocabulary and merges pinned beside the models (§5e).
 *
 * Read once per call: the caller keeps it for as long as it keeps the text model, which is the
 * text encoder's own process, and a few MB of tables are nothing beside the model.
 */
export const loadClipTokenizer = (): ClipTokenizer =>
    createClipTokenizer(
        JSON.parse(readFileSync(modelPath("clip-b32-vocab"), "utf8")) as Record<string, number>,
        readFileSync(modelPath("clip-b32-merges"), "utf8")
    );
