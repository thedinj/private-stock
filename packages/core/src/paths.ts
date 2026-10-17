/**
 * Path safety and artifact layout — pure string logic, no filesystem access.
 *
 * Every path the app touches passes through here. The rules are deliberately paranoid:
 * media roots hold the user's irreplaceable files, and the only write the app ever performs
 * on them is a delete (§18.1).
 */

import { PathSafetyError } from "./errors.js";

/** Two-level fanout for artifacts (§9) — NAS filesystems handle 100k-entry directories badly. */
export const fanout = (id: string): string => {
    const clean = id.replace(/-/g, "");
    if (clean.length < 2) {
        throw new PathSafetyError(`Cannot fan out an id shorter than 2 characters: "${id}"`);
    }

    return clean.slice(0, 2);
};

/** `<dataDir>/art/<xx>/<mediaId>/` — covers, posters, previews, sprites, subtitle VTTs. */
export const artifactDir = (mediaId: string): string => `art/${fanout(mediaId)}/${mediaId}`;

/**
 * `<dataDir>/captures/<xx>/<mediaId>/` — the stills a person framed by hand.
 *
 * A separate tree from `art`, and the separation is about backups rather than tidiness (§13).
 * Everything in `art` is regenerable, which is what makes excluding it from backups honest:
 * losing it costs CPU. A capture is somebody pausing on a frame and deciding *that* one — it
 * cannot be regenerated from anything, and left in `art` it would be real content sitting in
 * the one directory nothing backs up, with the loss silent and permanent.
 *
 * The 640px rendering of a capture stays in `art`, because that one genuinely is derived: it
 * can be remade from the capture at any time.
 */
export const captureDir = (mediaId: string): string => `captures/${fanout(mediaId)}/${mediaId}`;

/**
 * An item's vectors file (§5e), dataDir-relative like an artifact's path.
 *
 * One file per item, directly in its shard: there is never more than one, so a directory per
 * item would double the inodes §17 counts for nothing.
 */
export const vectorFileRelPath = (mediaId: string): string =>
    `embed/${fanout(mediaId)}/${mediaId}.vec`;

/**
 * An item's faces file (§5f): the vector of each face it shows, in the order of its `Face` rows'
 * `vectorIndex`. The vectors file format, as §5e's, so one reader serves both.
 */
export const faceFileRelPath = (mediaId: string): string =>
    `faces/${fanout(mediaId)}/${mediaId}.vec`;

/**
 * Every library performer's face reference, as the `faceAnchors` job last wrote it (§5f "One
 * face, one score"): what a face is scored against, by the review and by tagging that runs by
 * itself.
 */
export const FACE_ANCHORS_REL_PATH = "faces/anchors.bin";

/**
 * A video's tile prints (§10h): a 4×4 colour grid per sprite tile, for duplicates offset in
 * time. One small file per item, sharded like the vectors file.
 */
export const tilePrintRelPath = (mediaId: string): string =>
    `tileprints/${fanout(mediaId)}/${mediaId}.tp`;

/**
 * Where an MPEG-TS file's keyframes are (§8, "Playing an MPEG-TS file without copying it"): the
 * index its playlist of byte ranges is built from. One small file per item, sharded like the
 * tile prints.
 */
export const segmentIndexRelPath = (mediaId: string): string =>
    `segments/${fanout(mediaId)}/${mediaId}.json`;

/** The append-only log of every item's representatives (§5e). */
export const REPRESENTATIVES_LOG_REL_PATH = "embed/reps.log";

/**
 * Artifact kinds that are a single image file.
 *
 * Grouped because everything that can serve as a cover has to be one of these: the player's
 * "use this frame" action and the generator's alternates produce interchangeable files, and
 * only the `kind` and `source` distinguish them afterwards.
 */
export const IMAGE_ARTIFACT_KINDS = ["cover", "poster", "capture"] as const;
export type ImageArtifactKind = (typeof IMAGE_ARTIFACT_KINDS)[number];

/**
 * The live feed's word for "this item no longer has a cover" (§13b).
 *
 * An artifact change says which kind became ready, and a client answers `cover` by pointing
 * the tile at the cover alias. That is wrong when the cover just went away and nothing is left
 * to fall back to — discarding the capture that was the cover of an item whose generated cover
 * was never made — because the alias then answers 404 and the tile draws a broken image. This
 * tells the client to draw the placeholder instead.
 */
export const COVER_CLEARED_CHANGE = "coverCleared";

/**
 * The file name for an artifact inside its media's directory.
 *
 * Ordinal is in the name rather than only in the database so the directory is legible on
 * disk, and so a rebuild from the filesystem is possible if a database is ever lost —
 * artifacts are excluded from backups (§13) precisely because they are regenerable, and that
 * is only comfortable if their layout is self-describing.
 */
export const artifactFileName = (kind: string, ordinal = 0): string => {
    switch (kind) {
        case "cover":
            /**
             * Ordinal 0 is the generated cover and keeps the bare name; above it are the
             * grid-sized renderings of captures (§13).
             *
             * The ordinal was ignored here, which meant every rendering wrote to `cover.webp`
             * — over each other, and over the generator's own file. Nothing errored: the row
             * said one thing, the directory held another, and the item's generated cover had
             * quietly become a still somebody captured.
             */
            return ordinal === 0 ? "cover.webp" : `cover-${ordinal}.webp`;
        case "poster":
            return `poster-${ordinal}.webp`;
        case "capture":
            return `capture-${ordinal}.webp`;
        case "preview":
            return "preview.webm";
        case "sprite":
            return `sprite-${ordinal}.webp`;
        case "spriteVtt":
            return "sprite.vtt";
        case "subtitleVtt":
            return `subtitle-${ordinal}.vtt`;
        default:
            throw new PathSafetyError(`Unknown artifact kind: "${kind}"`);
    }
};

/**
 * The value stored in `Artifact.relPath`.
 *
 * `capture` is the one kind that does not live under `art`: it is the only artifact nothing
 * can regenerate, so it sits in a tree that is backed up. Everything else, including the
 * cover-sized rendering *of* a capture, is derived and stays where derived things go.
 */
export const artifactRelPath = (mediaId: string, kind: string, ordinal = 0): string =>
    `${kind === "capture" ? captureDir(mediaId) : artifactDir(mediaId)}/${artifactFileName(
        kind,
        ordinal
    )}`;

/**
 * Parse the name segment of an art URL back into a kind and ordinal.
 *
 * Deliberately a whitelist that reconstructs the name rather than a parser that trusts it:
 * the result is used to build a filesystem path, so anything not exactly of a known shape
 * must be rejected outright rather than sanitised and hoped about.
 */
export const parseArtifactName = (
    name: string
): { kind: string; ordinal: number; explicitOrdinal: boolean } => {
    const match = /^([a-zA-Z]+)(?:-(\d{1,4}))?$/.exec(name);

    if (!match) {
        throw new PathSafetyError(`Malformed artifact name: "${name}"`);
    }

    const [, kind, rawOrdinal] = match;
    const ordinal = rawOrdinal ? Number(rawOrdinal) : 0;

    const known = ["cover", "poster", "capture", "preview", "sprite", "spriteVtt", "subtitleVtt"];

    if (!known.includes(kind)) {
        throw new PathSafetyError(`Unknown artifact kind: "${kind}"`);
    }

    /**
     * Whether the caller named an ordinal, which is not the same question as whether the
     * ordinal is zero.
     *
     * `cover` and `cover-0` both parse to ordinal 0 and mean different things: the bare name
     * is the alias every grid tile asks for -- *whichever* frame currently represents this
     * item -- while `cover-0` names the generator's own cover, the specific row. Collapsing
     * the two made every request for a particular cover return the effective one instead.
     */
    return { kind, ordinal, explicitOrdinal: rawOrdinal !== undefined };
};

/** `<dataDir>/variants/<xx>/<mediaId>/` — background-generated web-safe renditions. */
export const variantDir = (mediaId: string): string => `variants/${fanout(mediaId)}/${mediaId}`;

/**
 * `<dataDir>/variants/<xx>/<mediaId>/<profile>.mp4` — a background web-safe rendition.
 *
 * The profile is validated rather than interpolated blindly: it reaches this function from a
 * database row, and the result is a filesystem path.
 */
export const variantRelPath = (mediaId: string, profile: string): string => {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(profile)) {
        throw new PathSafetyError(`Unsafe variant profile: "${profile}"`);
    }

    return `${variantDir(mediaId)}/${profile}.mp4`;
};

/** `<dataDir>/hls/<xx>/<mediaId>/<profile>/` — cached on-demand transcode segments. */
export const hlsDir = (mediaId: string, profile: string): string =>
    `hls/${fanout(mediaId)}/${mediaId}/${profile}`;

/**
 * Paths are stored POSIX-style and relative to a root, never absolute — so a database
 * created on Windows means the same thing on the NAS (§15).
 */
export const toPosixRelative = (relPath: string): string => relPath.replace(/\\/g, "/");

/**
 * Reject anything that could escape its root before it reaches the filesystem.
 *
 * This runs on stored paths as well as request input: a path that became unsafe through a
 * bug is just as dangerous as one that arrived that way.
 */
export const assertSafeRelativePath = (relPath: string): string => {
    const posix = toPosixRelative(relPath);

    if (posix.length === 0) {
        throw new PathSafetyError("Empty relative path");
    }
    if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) {
        throw new PathSafetyError(`Absolute path where a relative one was required: "${relPath}"`);
    }
    if (posix.split("/").some((segment) => segment === "..")) {
        throw new PathSafetyError(`Path escapes its root: "${relPath}"`);
    }
    if (posix.includes("\0")) {
        throw new PathSafetyError("Path contains a null byte");
    }

    return posix;
};

/**
 * Directories generated by the NAS itself, never media (§18.5).
 *
 * Scanning into these produces thousands of junk thumbnails on the first run, which is
 * tedious to undo — so they are excluded by default rather than by admin configuration.
 */
export const DEFAULT_IGNORED_DIRECTORIES = [
    "@eaDir", // Synology
    ".@__thumb", // QNAP
    "#recycle",
    ".Trashes",
    ".Spotlight-V100",
    "$RECYCLE.BIN",
    "System Volume Information",
    ".git",
] as const;

export const DEFAULT_IGNORED_FILES = ["Thumbs.db", ".DS_Store", "desktop.ini"] as const;

/** Extensions treated as media. Image input is deliberately limited to these four (§18.3). */
export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"] as const;

export const VIDEO_EXTENSIONS = [
    ".mp4",
    ".m4v",
    ".mov",
    ".mkv",
    ".avi",
    ".wmv",
    ".flv",
    ".webm",
    ".mpg",
    ".mpeg",
    ".ts",
    ".m2ts",
] as const;

/** Files that attach to a sibling media item rather than becoming one (§18.5). */
export const SUBTITLE_EXTENSIONS = [".srt", ".ass", ".ssa", ".vtt", ".sub"] as const;
export const COMPANION_EXTENSIONS = [...SUBTITLE_EXTENSIONS, ".nfo"] as const;

/**
 * Where a trashed file lives, relative to the trash directory (§10).
 *
 * Dated so a person can find a deletion by when it happened, and prefixed with the entry id
 * so two files of the same name deleted on the same day cannot collide. The basename is kept
 * only because a bin full of bare uuids is useless to whoever has to search it.
 *
 * Lives here rather than beside the code that moves the bytes because both sides need it: the
 * web app writes the path into the entry, and the worker reads it back to find the file. Two
 * implementations of one naming scheme would drift into a bin whose contents cannot be found.
 *
 * The basename is rewritten rather than trusted. It comes from a media root, so it can hold
 * anything a filesystem allows, and this value becomes a path on a different volume.
 */
export const trashRelPathFor = (entryId: string, relPath: string, at: Date): string => {
    const date = at.toISOString().slice(0, 10);
    const lastSeparator = Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\"));
    const base = relPath
        .slice(lastSeparator + 1)
        .replace(/[^\w.-]+/g, "_")
        .slice(-100);

    return `${date}/${entryId}-${base || "file"}`;
};
