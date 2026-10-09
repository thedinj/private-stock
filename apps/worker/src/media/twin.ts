import { copyFile, link, mkdir, rm } from "node:fs/promises";
import * as path from "node:path";

import { artifactRelPath, assertSafeRelativePath, findStage, needsWork } from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";
import { artifactRepo, db, mediaFileRepo, stageRepo } from "@private-stock/db";

type ArtifactRow = artifactRepo.ArtifactRow;

/**
 * Borrowing what a byte-identical copy already has (§10f).
 *
 * Identical bytes render identically: the same covers, the same preview, the same sprite
 * sheets, the same fingerprint, the same transcode. A library with a few hundred exact copies
 * used to render every one of them in full — and an exact copy is the item most likely to be
 * deleted, so that was the work most likely to be thrown away.
 *
 * A stage about to render something asks whether a twin has already settled it, and if so
 * takes the result instead. Anything that goes wrong on the way falls back to rendering: a
 * borrowed artifact is an optimisation, and must never be the reason an item has none.
 */

export interface SettledTwin {
    mediaId: string;
    /** `empty` carries over too: a clip too short for a preview is too short in every copy. */
    state: "done" | "empty";
}

/** The other items holding exactly these bytes. */
export const twinsOf = (fileId: string): string[] => mediaFileRepo.identicalMediaIds(fileId);

/**
 * A twin whose outcome for this stage is settled at the current recipe version, if any.
 *
 * Settled by `needsWork`, the same rule the sweep uses, so a twin rendered under an old recipe
 * is not copied into a new item only for the sweep to re-render both. A failure is not
 * borrowed: it may have been the twin's bad luck rather than the bytes.
 */
export const settledTwin = (
    fileId: string,
    stageName: string,
    /**
     * For a stage whose output depends on settings: only a twin whose outcome records this
     * recipe counts, so a settings change is not hidden behind an answer from the old ones.
     * `unrecordedAs` is what an outcome from before recipes were recorded was produced by.
     */
    recipe?: { current: string; unrecordedAs: string }
): SettledTwin | null => {
    const stage = findStage(stageName);

    if (!stage) {
        return null;
    }

    for (const mediaId of twinsOf(fileId)) {
        const row = stageRepo.find(mediaId, stage.name);

        if (
            row &&
            !needsWork(stage, row) &&
            (row.state === "done" || row.state === "empty") &&
            (recipe === undefined || (row.recipe ?? recipe.unrecordedAs) === recipe.current)
        ) {
            return { mediaId, state: row.state };
        }
    }

    return null;
};

/**
 * Put a copy of a file under `dataDir` at another path under `dataDir`.
 *
 * `hardlink` only where every writer of that kind replaces its file by rename. Covers,
 * previews and sprite sheets are written by ffmpeg straight into their final path, which
 * truncates the inode in place — so a later regeneration of one item would rewrite its twin's
 * file through the link, mid-read. They are small and copied. A transcode lands by rename
 * (`media/transcode.ts`), runs to gigabytes, and is linked.
 */
export const placeDataFile = async (
    fromRelPath: string,
    toRelPath: string,
    options: { hardlink: boolean }
): Promise<void> => {
    const { dataDir } = loadConfig();
    const from = path.resolve(dataDir, assertSafeRelativePath(fromRelPath));
    const to = path.resolve(dataDir, assertSafeRelativePath(toRelPath));

    await mkdir(path.dirname(to), { recursive: true });

    if (!options.hardlink) {
        await copyFile(from, to);
        return;
    }

    // `link` refuses an existing target, and a filesystem that cannot link at all (some SMB
    // and FAT mounts) still deserves the copy.
    await rm(to, { force: true });

    try {
        await link(from, to);
    } catch {
        await copyFile(from, to);
    }
};

/**
 * Copy a twin's generated artifacts onto this item, files and rows both.
 *
 * Only `auto` rows. A twin's captures and its chosen cover are somebody's decisions about that
 * item; this one gets the generator's output and makes its own.
 *
 * Null when there is nothing to borrow or a file could not be copied — a twin whose stage row
 * says done can still have lost its files to an `art` directory that was cleared to reclaim
 * space (§13), and the caller then renders as it always did.
 */
export const adoptArtifacts = async (
    mediaId: string,
    twinMediaId: string,
    wanted: (row: ArtifactRow) => boolean
): Promise<ArtifactRow[] | null> => {
    const rows = artifactRepo
        .listForMedia(twinMediaId)
        .filter((row) => row.source === "auto" && wanted(row));

    if (rows.length === 0) {
        return null;
    }

    const placed: { row: ArtifactRow; relPath: string }[] = [];

    try {
        for (const row of rows) {
            const relPath = artifactRelPath(mediaId, row.kind, row.ordinal);

            await placeDataFile(row.relPath, relPath, { hardlink: false });
            placed.push({ row, relPath });
        }
    } catch (error) {
        console.warn(
            `Could not borrow artifacts for ${mediaId} from its identical copy ${twinMediaId}; ` +
                `rendering instead: ${(error as Error).message}`
        );

        return null;
    }

    return db.transaction(() =>
        placed.map(({ row, relPath }) =>
            artifactRepo.upsert({
                mediaId,
                kind: row.kind,
                ordinal: row.ordinal,
                relPath,
                width: row.width,
                height: row.height,
                tileCount: row.tileCount,
                intervalMs: row.intervalMs,
                bytes: row.bytes,
                atMs: row.atMs,
                source: "auto",
                // The twin's, not this stage's current constant: the files are the twin's
                // output, and the row must say which recipe actually made them.
                generatorVersion: row.generatorVersion,
            })
        )
    )();
};
