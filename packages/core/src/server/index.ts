/**
 * Server-only entry point (`@private-stock/core/server`).
 *
 * Anything importing `node:*` lives behind this subpath so the main export stays free of
 * Node and DOM dependencies — a future Capacitor app has to be able to consume
 * `@private-stock/core` unchanged (§2).
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, stat, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";

import { assertSafeRelativePath } from "../paths.js";
import { type Config, resolveConfig } from "../config.js";

export const CONFIG_FILENAME = "config.json";
const SECRET_FILENAME = "secret.key";
const WORKSPACE_MARKER = "pnpm-workspace.yaml";

/**
 * Walk up to the workspace root.
 *
 * Relative paths in config must not resolve against `process.cwd()`. The three entry points
 * — `next dev` in apps/web, the worker in apps/worker, and `db:init` in packages/db — each
 * run from a different directory, so a default of `./data` would silently give each one its
 * own database. The symptom (data written by one process invisible to another) is baffling
 * and slow to diagnose, so the root is pinned rather than inherited.
 *
 * In the container there is no marker file above /app, so this falls back to the given
 * directory — which is correct there, because config supplies absolute paths anyway.
 */
export const findWorkspaceRoot = (from: string = process.cwd()): string => {
    let current = path.resolve(from);

    for (;;) {
        if (existsSync(path.join(current, WORKSPACE_MARKER))) {
            return current;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return path.resolve(from);
        }

        current = parent;
    }
};

/**
 * Load `config.json`, apply environment overrides, and validate.
 *
 * A missing file is fine — every key has a default, and a Docker deployment typically
 * configures through environment variables alone. A malformed file is not: it throws with
 * the offending key named, because silently falling back to defaults is how a NAS ends up
 * serving on the wrong port with nobody knowing why.
 */
export const loadConfig = (from: string = process.cwd()): Config => {
    const root = findWorkspaceRoot(from);
    const configPath = path.join(root, CONFIG_FILENAME);

    let fileConfig: unknown = {};

    if (existsSync(configPath)) {
        const raw = readFileSync(configPath, "utf8");

        try {
            fileConfig = JSON.parse(raw);
        } catch (error) {
            throw new Error(`${configPath} is not valid JSON: ${(error as Error).message}`);
        }
    }

    const config = resolveConfig(fileConfig, process.env);

    return {
        ...config,
        dataDir: path.resolve(root, config.dataDir),
        mediaDir: path.resolve(root, config.mediaDir),
    };
};

/**
 * Return the signing secret, generating and persisting one on first boot.
 *
 * Nobody should have to invent a signing key to use the app, and nobody should accidentally
 * run with a default one — so it is generated once into `<dataDir>/secret.key` with 0600
 * permissions and read back on every subsequent start.
 */
export const resolveSecret = (config: Config): string => {
    if (config.secret) {
        return config.secret;
    }

    const secretPath = path.join(config.dataDir, SECRET_FILENAME);

    if (existsSync(secretPath)) {
        const existing = readFileSync(secretPath, "utf8").trim();
        if (existing.length >= 32) {
            return existing;
        }
    }

    mkdirSync(config.dataDir, { recursive: true });

    const generated = randomBytes(48).toString("base64url");
    writeFileSync(secretPath, generated, { mode: 0o600 });

    return generated;
};

/** Absolute paths derived from `dataDir`. Created on boot so no job has to check. */
export const dataPaths = (config: Config) => ({
    database: path.join(config.dataDir, "private-stock.db"),
    art: path.join(config.dataDir, "art"),
    captures: path.join(config.dataDir, "captures"),
    variants: path.join(config.dataDir, "variants"),
    hls: path.join(config.dataDir, "hls"),
    trash: path.join(config.dataDir, "trash"),
    backups: path.join(config.dataDir, "backups"),
    sidecars: path.join(config.dataDir, "sidecars"),
    ocrTune: path.join(config.dataDir, "ocr-tune"),
    embed: path.join(config.dataDir, "embed"),
    faces: path.join(config.dataDir, "faces"),
    tileprints: path.join(config.dataDir, "tileprints"),
    tags: path.join(config.dataDir, "tags"),
});

export type DataDirName = keyof ReturnType<typeof dataPaths>;

/**
 * Whether a directory under `dataDir` can be rebuilt, or holds the only copy of something.
 *
 * The distinction the reset path turns on (§13d). Everything `derived` is a cache of what the
 * originals and the database already say: throwing it away costs CPU and nothing else, and
 * *keeping* it across a reset is the actively wrong choice, because media ids are fresh UUIDs
 * and not one of those files would ever be read again.
 *
 * `irreplaceable` is the short list that must survive, and it is short on purpose. Trashed
 * bytes have been removed from a media root and exist nowhere else; the backups are the only
 * thing standing behind a migration that succeeded and was wrong.
 *
 * Exhaustive over `DataDirName`, so adding a directory to `dataPaths` without deciding which
 * it is fails to compile. That is the whole point of the map: the failure it prevents is a new
 * directory silently inheriting "keep forever" and drifting out of step with the database, or
 * silently inheriting "delete freely" and taking user data with it.
 */
export const DATA_DIR_KIND: Record<DataDirName, "derived" | "irreplaceable"> = {
    /** The thing everything else is derived *from*. */
    database: "irreplaceable",
    /** Covers, previews, sprite sheets. Excluded from backups precisely because of this (§13). */
    art: "derived",
    /**
     * Stills somebody framed by hand. Nothing can regenerate these (§13).
     *
     * They live apart from `art` for exactly this line: a reset may empty everything derived,
     * and emptying a directory of somebody's captures would be silent, permanent data loss
     * dressed up as housekeeping.
     */
    captures: "irreplaceable",
    /** Web-safe renditions. Expensive to rebuild, and still only a copy of the original. */
    variants: "derived",
    /** Cached on-demand segments, which is all they have ever been. */
    hls: "derived",
    /** An export *of* the database, so the database can always produce it again. */
    sidecars: "derived",
    /** Removed from a media root and held in limbo. There is no other copy (§10). */
    trash: "irreplaceable",
    /**
     * What Tesseract read from the OCR tuner's videos, kept so re-tuning reads nothing twice
     * (§5d "Tuning against expected text"). A cache in the plainest sense.
     */
    ocrTune: "derived",
    /** Snapshots taken before migrating. Deleting these deletes the undo (§13). */
    backups: "irreplaceable",
    /**
     * What each item's moments look like, as vectors (§5e). Rebuilt from the sprite sheets by
     * re-running the stage: a night of CPU, and nothing that cannot be had again.
     */
    embed: "derived",
    /**
     * The vector of every face found (§5f). Rebuilt from the sprite sheets by re-running the
     * stage. What people *said* about the faces is in the database, and a re-run carries it over
     * to the faces found again, so nothing here is the only copy of a decision.
     */
    faces: "derived",
    /** Colour grids read from the sprite sheets (§10h). Minutes to rebuild, from /data alone. */
    tileprints: "derived",
    /**
     * Tags' pictures (§6 "A tag's picture"). Some are chosen by hand and nothing regenerates
     * those, so the directory is kept whole; the automatic ones beside them are a few hundred
     * small files, and the orphan sweep takes any a reset leaves without a row.
     */
    tags: "irreplaceable",
};

/**
 * The directories a reset may empty, as absolute paths.
 *
 * Derived from the map rather than listed again, so the two cannot disagree -- a second list
 * is exactly how a directory ends up classified one way in the comment and the other way in
 * the code that runs.
 */
export const derivedDataDirs = (config: Config): string[] => {
    const paths = dataPaths(config);

    return (Object.keys(DATA_DIR_KIND) as DataDirName[])
        .filter((name) => DATA_DIR_KIND[name] === "derived")
        .map((name) => paths[name]);
};

/**
 * Files anywhere under a directory.
 *
 * Counted rather than listed, because the answer for a real library is hundreds of thousands
 * and every caller only ever wanted the number. Synchronous because both callers are CLIs
 * deciding what to print before they do anything.
 */
export const countFilesUnder = (dir: string): number => {
    if (!existsSync(dir)) {
        return 0;
    }

    let total = 0;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        total += entry.isDirectory() ? countFilesUnder(path.join(dir, entry.name)) : 1;
    }

    return total;
};

/**
 * The directories a reset empties: everything derived, **and the captures**.
 *
 * Deliberately not the same list as `derivedDataDirs`, and the difference is the point. That
 * one answers "what can be rebuilt", which is what decides backups and what the orphan sweep
 * is allowed to touch -- and a captured still can be rebuilt by nothing, so it has to stay
 * out of it.
 *
 * Reset asks a different question: what can the new database account for? A reset destroys
 * every `Media` row, and media ids are fresh UUIDs, so *nothing ever written* can be named
 * again. Captures are not merely unreferenced afterwards, they are unreferenceable -- files
 * no sweep will reclaim, because the sweep only ever visits items that exist. Keeping them
 * is not caution, it is the litter this command exists to stop producing (§13d).
 *
 * They are still counted and reported separately by the CLI, because destroying somebody's
 * work silently and destroying it are different failures and only one of them is intended.
 */
export const resetDataDirs = (config: Config): string[] => {
    const paths = dataPaths(config);

    return [...derivedDataDirs(config), paths.captures];
};

/** How many rebuildable files exist under `dataDir` right now. */
export const countDerivedFiles = (config: Config): number =>
    derivedDataDirs(config).reduce((total, dir) => total + countFilesUnder(dir), 0);

/**
 * Free space on the volume holding a directory, in bytes.
 *
 * Trashing copies before it unlinks, so a delete *consumes* space on `/data` until the
 * retention window closes — the opposite of what deleting is expected to do. Checking first
 * is what stops a bulk duplicate cleanup filling the volume that holds the database, which
 * would take the whole app down in the middle of an operation the user believed was freeing
 * disk (§18.1).
 *
 * Returns null when the platform cannot answer rather than guessing: a missing number must
 * not read as "no space", or deletion stops working for everyone on a filesystem statfs does
 * not understand.
 */
export const freeBytes = async (dir: string): Promise<number | null> => {
    try {
        const stats = await statfs(dir);

        return Number(stats.bsize) * Number(stats.bavail);
    } catch {
        return null;
    }
};

/**
 * Where a library lives, and where one of its files lives.
 *
 * One helper because there were six copies of `path.resolve(mediaDir, dirName, relPath)`
 * scattered across the scanner, the watcher, the probe, the trash job and two services. Six
 * copies of a path rule is five chances for one of them to be subtly different, and one of
 * these is the path the app is allowed to delete from (§18.1).
 *
 * `assertSafeRelativePath` runs on the relative half as it comes *out* of the database, not
 * only as it goes in: a path that became unsafe through a bug is exactly as dangerous as one
 * that arrived that way.
 */
export const libraryFilePath = (libraryPath: string, relPath: string): string =>
    path.resolve(libraryPath, assertSafeRelativePath(relPath));

/**
 * Whether a library's directory can actually be used right now.
 *
 * Checked when a path is typed, so a mistake is reported at the moment it is made rather than
 * discovered later as a library that mysteriously never finds anything. In a container this
 * is also what catches a host path nobody mounted — the single most likely way to configure
 * this wrongly.
 */
export const inspectLibraryPath = async (
    candidate: string
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
    if (!path.isAbsolute(candidate)) {
        return { ok: false, reason: "The path must be absolute" };
    }

    const resolved = path.resolve(candidate);

    try {
        const stats = await stat(resolved);

        if (!stats.isDirectory()) {
            return { ok: false, reason: "That path is a file, not a directory" };
        }
    } catch {
        return {
            ok: false,
            reason: "No such directory, or it is not readable by private-stock",
        };
    }

    try {
        await access(resolved, constants.R_OK);
    } catch {
        return { ok: false, reason: "The directory exists but cannot be read" };
    }

    return { ok: true, path: resolved };
};

export const ensureDataDirs = (config: Config): void => {
    for (const dir of Object.values(dataPaths(config))) {
        const target = dir.endsWith(".db") ? path.dirname(dir) : dir;
        mkdirSync(target, { recursive: true });
    }
};

/**
 * Short, opaque token identifying a particular rendering of an artifact.
 *
 * Derived from the path and the generation time rather than being a counter, so it needs no
 * storage and changes exactly when the bytes do — whether that is a regenerated cover or a
 * person choosing a different frame.
 *
 * Lives here rather than in the web app because the worker needs it too: the sprite VTT it
 * writes contains URLs for the sheets, and those have to carry the same token the web app
 * would have produced or the browser re-downloads every sheet on every open.
 */
export const artifactVersion = (relPath: string, generatedAt: string | null): string =>
    createHash("sha1")
        .update(`${relPath}|${generatedAt ?? ""}`)
        .digest("hex")
        .slice(0, 10);

export {
    FRAME_TIMEOUT_MS,
    frameArgs,
    resolveFfmpeg,
    resolveFfprobe,
    resolveTesseract,
    type ExtractFrameOptions,
} from "./ffmpeg.js";

export {
    findModelsDir,
    loadClipTokenizer,
    openModel,
    readModelManifest,
    type ModelEntry,
    type OpenModelOptions,
} from "./models.js";

export { encodeLookText, stopTextEncoder } from "./textEncoder.js";

export { readTileMoments } from "./tileMoments.js";

export {
    cachedReader,
    loadTuneCache,
    missingPositions,
    recordFrames,
    removeTuneCache,
    saveTuneCache,
    type CachedSource,
    type TuneCache,
} from "./ocrTuneCache.js";
