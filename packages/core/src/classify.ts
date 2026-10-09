import { type FileClassification, type MediaKind } from "./domain.js";
import {
    COMPANION_EXTENSIONS,
    DEFAULT_IGNORED_DIRECTORIES,
    DEFAULT_IGNORED_FILES,
    IMAGE_EXTENSIONS,
    SUBTITLE_EXTENSIONS,
    VIDEO_EXTENSIONS,
} from "./paths.js";

/**
 * Deciding what a file *is*, before anything touches it (§18.5).
 *
 * Pure and table-driven so the rules can be unit-tested without a filesystem. Getting this
 * wrong on the first scan means thousands of junk entries that are tedious to undo, so the
 * default is conservative: anything unrecognised is ignored rather than imported.
 */

export interface Classification {
    classification: FileClassification;
    kind: MediaKind | null;
    /** For companions: what sort, so the scanner knows which table to attach it to. */
    companionKind: "subtitle" | "metadata" | "artwork" | null;
    reason: string;
}

const extensionOf = (relPath: string): string => {
    const name = relPath.slice(relPath.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");

    return dot <= 0 ? "" : name.slice(dot).toLowerCase();
};

const baseNameOf = (relPath: string): string => relPath.slice(relPath.lastIndexOf("/") + 1);

/**
 * Artwork that belongs to a folder or a sibling video rather than being library content.
 *
 * These are the filenames that turn a first scan into a mess: every season folder
 * contributes a `folder.jpg`, every ripped file a `*-thumb.jpg`.
 */
const ARTWORK_NAMES = new Set([
    "folder.jpg",
    "folder.jpeg",
    "folder.png",
    "cover.jpg",
    "cover.jpeg",
    "cover.png",
    "poster.jpg",
    "poster.png",
    "fanart.jpg",
    "banner.jpg",
    "backdrop.jpg",
    "thumb.jpg",
    "season.jpg",
]);

const ARTWORK_SUFFIXES = ["-thumb", "-poster", "-fanart", "-banner", "-landscape"];

const ignoredDirectories = new Set<string>(DEFAULT_IGNORED_DIRECTORIES);
const ignoredFiles = new Set<string>(DEFAULT_IGNORED_FILES);

export interface ClassifyOptions {
    /** Extra glob-free directory names from Setting, editable by an admin. */
    extraIgnoredDirectories?: string[];
}

export const classifyPath = (relPath: string, options: ClassifyOptions = {}): Classification => {
    const segments = relPath.split("/");
    const name = baseNameOf(relPath);
    const ext = extensionOf(relPath);
    const lowerName = name.toLowerCase();

    const extraIgnored = new Set(options.extraIgnoredDirectories ?? []);

    for (const segment of segments.slice(0, -1)) {
        if (ignoredDirectories.has(segment) || extraIgnored.has(segment)) {
            return {
                classification: "ignored",
                kind: null,
                companionKind: null,
                reason: `inside ignored directory "${segment}"`,
            };
        }
    }

    // Dotfiles and dot-directories: editor swap files, resource forks, sync metadata.
    if (segments.some((segment) => segment.startsWith("."))) {
        return {
            classification: "ignored",
            kind: null,
            companionKind: null,
            reason: "dot-prefixed",
        };
    }

    if (ignoredFiles.has(name)) {
        return {
            classification: "ignored",
            kind: null,
            companionKind: null,
            reason: "system file",
        };
    }

    // Partial downloads and copies in flight. The scanner also waits for size to settle
    // (§7), but skipping these outright avoids probing something that will be renamed.
    if ([".part", ".crdownload", ".tmp", ".!ut", ".partial"].includes(ext)) {
        return {
            classification: "ignored",
            kind: null,
            companionKind: null,
            reason: "incomplete file",
        };
    }

    if ((SUBTITLE_EXTENSIONS as readonly string[]).includes(ext)) {
        return {
            classification: "companion",
            kind: null,
            companionKind: "subtitle",
            reason: "subtitle sidecar",
        };
    }

    if ((COMPANION_EXTENSIONS as readonly string[]).includes(ext)) {
        return {
            classification: "companion",
            kind: null,
            companionKind: "metadata",
            reason: "metadata sidecar",
        };
    }

    if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
        const stem = lowerName.slice(0, lowerName.length - ext.length);

        if (
            ARTWORK_NAMES.has(lowerName) ||
            ARTWORK_SUFFIXES.some((suffix) => stem.endsWith(suffix))
        ) {
            return {
                classification: "companion",
                kind: null,
                companionKind: "artwork",
                reason: "folder or sibling artwork",
            };
        }

        return { classification: "media", kind: "image", companionKind: null, reason: "image" };
    }

    if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
        return { classification: "media", kind: "video", companionKind: null, reason: "video" };
    }

    return {
        classification: "ignored",
        kind: null,
        companionKind: null,
        reason: ext ? `unrecognised extension "${ext}"` : "no extension",
    };
};

/**
 * A readable title from a filename, used until something better exists.
 *
 * Deliberately conservative — it strips the extension and tidies separators, and does not
 * try to parse series, episode, or release tags. That belongs to the `parse` stage (§18.6),
 * where the result is recorded with `source: "filename"` and can be re-derived.
 */
export const titleFromPath = (relPath: string): string => {
    const name = baseNameOf(relPath);
    const ext = extensionOf(relPath);
    const stem = ext ? name.slice(0, name.length - ext.length) : name;

    return (
        stem
            .replace(/[._]+/g, " ")
            .replace(/\s{2,}/g, " ")
            .trim() || name
    );
};

/**
 * Should a *directory* be skipped entirely?
 *
 * Separate from `classifyPath` because that function answers a question about files, and a
 * directory has no extension — asking it about `holiday/` yields "ignored", which is right
 * for a file with no extension and catastrophically wrong for a folder. A watcher using the
 * file rule on directories silently refuses to descend into the whole library.
 */
export const shouldIgnoreDirectory = (relPath: string, options: ClassifyOptions = {}): boolean => {
    if (!relPath || relPath === ".") {
        return false;
    }

    const extraIgnored = new Set(options.extraIgnoredDirectories ?? []);

    return relPath
        .split("/")
        .filter(Boolean)
        .some(
            (segment) =>
                ignoredDirectories.has(segment) ||
                extraIgnored.has(segment) ||
                segment.startsWith(".")
        );
};
