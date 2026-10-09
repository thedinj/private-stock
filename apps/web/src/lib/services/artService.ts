import { stat } from "node:fs/promises";
import * as path from "node:path";

import { NotFoundError, assertSafeRelativePath, parseArtifactName } from "@private-stock/core";
import { artifactVersion, dataPaths, loadConfig } from "@private-stock/core/server";
import { artifactRepo, mediaRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";

/**
 * Serving generated imagery (§9).
 *
 * Artifacts are plain files under `dataDir`, served with a long cache lifetime and a version
 * token in the URL. They are behind auth like everything else — the existence of an item is
 * itself information a user without access to its root must not learn.
 */

/** The URL the client should request for an item's cover, or null when there is none. */
export const coverUrl = (
    mediaId: string,
    coverPath: string | null,
    coverGeneratedAt: string | null
): string | null =>
    coverPath
        ? `/api/art/${mediaId}/cover?v=${artifactVersion(coverPath, coverGeneratedAt)}`
        : null;

/** The URL for any other artifact of an item, versioned the same way. */
export const artifactUrl = (
    mediaId: string,
    name: string,
    relPath: string,
    generatedAt: string | null
): string => `/api/art/${mediaId}/${name}?v=${artifactVersion(relPath, generatedAt)}`;

const CONTENT_TYPES: Record<string, string> = {
    webp: "image/webp",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webm: "video/webm",
    vtt: "text/vtt",
};

export interface ResolvedArtifact {
    absolutePath: string;
    sizeBytes: number;
    contentType: string;
    /** Whether the URL carried the version token matching what is being served. */
    versioned: boolean;
}

/**
 * Resolve a media id and an artifact name to a file on disk.
 *
 * `name` is the URL segment — "cover", "poster-2", "capture-3". The bare "cover" is an
 * **alias**: it resolves the *effective* cover, so a grid tile is served whichever frame
 * currently represents the item without needing to know one was chosen. Every other name,
 * "cover-0" included, is a specific artifact.
 *
 * The distinction is the whole point and was missing: resolving on `kind` alone sent every
 * request for a particular cover to the effective one, so the frame strip drew the item's
 * current cover in place of each capture's own rendering. It was invisible until covers
 * stopped sharing a filename, because until then the wrong row named the right file.
 *
 * Three checks, in order: the user can see the media, the stored path is still a safe
 * relative path, and the resolved absolute path is genuinely inside the art directory. The
 * third is the backstop for a path that reached the database in a form the second would pass
 * but the filesystem would resolve elsewhere.
 *
 * Kept light on purpose: a grid page asks this sixty times at once, on the thread that serves
 * everything else (§20). Visibility and the artifact row are one statement
 * (`findVisibleArtifact`), and the size comes from an async `stat` — a synchronous one on a
 * NAS volume ffmpeg is also reading stops every tile behind it.
 */
export const resolveArtifact = async (
    mediaId: string,
    name: string,
    requestedVersion: string | null,
    auth: AuthContext
): Promise<ResolvedArtifact> => {
    const { kind, ordinal, explicitOrdinal } = parseArtifactName(name);

    // Visibility and the row in one statement. Not visible and not there are the same answer,
    // deliberately: a user must not be able to discover that an item exists by the shape of
    // the error.
    const artifact = mediaRepo.findVisibleArtifact(
        mediaId,
        auth.accessibleRootIds,
        kind === "cover" && !explicitOrdinal
            ? { effectiveCover: true }
            : { effectiveCover: false, kind: kind as artifactRepo.ArtifactKind, ordinal },
        // The trash page shows each item's cover, and only an administrator can see it (§10).
        { includeTrashed: auth.scopes.includes("admin") }
    );

    if (!artifact) {
        throw new NotFoundError("Artifact not found");
    }

    const config = loadConfig();
    const paths = dataPaths(config);
    const absolutePath = path.resolve(config.dataDir, assertSafeRelativePath(artifact.relPath));

    /**
     * Two roots now, because a capture is not stored with the derived artifacts (§13).
     *
     * Still a whitelist rather than a check that the path is merely inside `dataDir`: this
     * route serves bytes by id to anyone who may see the item, so the set of directories it
     * can reach has to be named, not inferred.
     */
    const roots = [paths.art, paths.captures].map((root) =>
        root.endsWith(path.sep) ? root : root + path.sep
    );

    if (!roots.some((root) => absolutePath.startsWith(root))) {
        throw new NotFoundError("Artifact not found");
    }

    let sizeBytes: number;

    try {
        sizeBytes = (await stat(absolutePath)).size;
    } catch {
        // The row exists but the file does not — artifacts are excluded from backups and can
        // be deleted to reclaim space (§13). The worker's backfill pass regenerates it.
        throw new NotFoundError("Artifact is not available");
    }

    const extension = artifact.relPath.slice(artifact.relPath.lastIndexOf(".") + 1).toLowerCase();

    return {
        absolutePath,
        sizeBytes,
        contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
        versioned: requestedVersion === artifactVersion(artifact.relPath, artifact.generatedAt),
    };
};
