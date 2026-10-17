import { existsSync } from "node:fs";
import { readdir, rmdir, stat, unlink } from "node:fs/promises";
import * as path from "node:path";

import {
    REPRESENTATIVES_LOG_REL_PATH,
    assertSafeRelativePath,
    vectorFileRelPath,
    faceFileRelPath,
    FACE_ANCHORS_REL_PATH,
    tilePrintRelPath,
} from "@private-stock/core";
import { dataPaths, loadConfig } from "@private-stock/core/server";
import { db } from "@private-stock/db";

/**
 * Files under `/data` that nothing in the database references (§13, §13d).
 *
 * Rows and bytes are separate, so a row can go without its file. Forgetting a library is the
 * clearest case — one statement removes thousands of artifact, variant and trash rows, and
 * nothing on disk changes — but a killed container between writing a file and inserting its
 * row leaves the same litter, which is why this is a sweep over what exists rather than a
 * list handed over by whoever deleted the rows. A list would also have to fit in a job
 * payload, and a 200k library's does not.
 *
 * `/data/art` is excluded from backups precisely because it can be rebuilt (§13), so deleting
 * an artifact that turns out to be wanted costs one regeneration. Trashed bytes are the
 * exception and are treated as such below.
 *
 * **Only directories with something to be referenced *by* are swept.** `hls` and `sidecars`
 * are derived — a reset empties them with the rest (§13d) — but neither has a table naming
 * its files, so the reference set for both would be empty and a sweep would mean "delete
 * everything in here". That is the right answer today, when nothing writes to either, and
 * exactly the wrong one the moment on-demand HLS starts caching segments that deliberately
 * have no rows. A sweep that is correct only while a directory stays empty is a trap, not a
 * safeguard.
 */

/**
 * How recently a file must have been written to be left alone.
 *
 * The race this closes: a cover job writes its file and then inserts the row, so for a moment
 * the file legitimately has nothing pointing at it. Without a grace period a sweep running in
 * that window deletes the artifact of a job that is about to report success, and the item ends
 * up with a row and no bytes — which is worse than the litter, because nothing looks wrong.
 */
const GRACE_MS = 60 * 60 * 1000;

/** Every file under a directory, relative to it, in one walk. */
const walk = async (root: string, prefix = ""): Promise<string[]> => {
    let entries;
    try {
        entries = await readdir(path.join(root, prefix), { withFileTypes: true });
    } catch {
        // The directory does not exist yet, which is not a problem to solve here.
        return [];
    }

    const found: string[] = [];

    for (const entry of entries) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
            found.push(...(await walk(root, relPath)));
        } else {
            found.push(relPath);
        }
    }

    return found;
};

/**
 * What one directory is swept against.
 *
 * `storedPrefix` is the part that has to be stated rather than assumed, and getting it wrong
 * is not a near miss — it makes every live file look like an orphan. The two path spaces in
 * use here genuinely disagree:
 *
 *  - `Artifact.relPath` and `Variant.relPath` are **dataDir-relative** and carry their
 *    directory in the value: `"art/19/<id>/cover.webp"`. Every consumer resolves them with
 *    `path.resolve(config.dataDir, relPath)`.
 *  - `TrashEntry.trashRelPath` is **trash-relative** and carries no prefix, because the trash
 *    job resolves it against `dataPaths(config).trash`.
 *
 * The walk yields paths relative to the directory it walked, so art and variants need their
 * prefix put back before the comparison means anything.
 */
interface SweepTarget {
    dir: string;
    /** Prepended to each walked path to reach the form the database stores. */
    storedPrefix: string;
    referenced: Set<string>;
}

/**
 * Removes files whose stored form is not in `referenced`.
 *
 * Refuses to empty a directory outright. If every file in a non-empty directory looks like an
 * orphan while the database claims to reference something, the overwhelmingly likelier
 * explanation is that the two sides are speaking different path languages — which is exactly
 * the bug this function shipped with — and the consequence of being wrong is unrecoverable.
 * A sweep that finds nothing to keep has found a bug, not a windfall.
 *
 * The walk is returned too, in stored form, because it already answers the other question this
 * job asks — which rows name a file that is not there. That used to be a `stat` per row: 71,000
 * inode reads on the disk the web process is waiting on (§20), for files whose directories the
 * walk had just read.
 */
const sweepDirectory = async (
    target: SweepTarget
): Promise<{ removed: number; onDisk: Set<string> }> => {
    const walked = await walk(target.dir);
    const stored = (relPath: string): string =>
        target.storedPrefix ? `${target.storedPrefix}/${relPath}` : relPath;
    const onDisk = new Set(walked.map(stored));
    const orphans = walked.filter((relPath) => !target.referenced.has(stored(relPath)));

    if (walked.length > 0 && orphans.length === walked.length && target.referenced.size > 0) {
        console.error(
            `Refusing to sweep ${target.dir}: all ${walked.length} file(s) look unreferenced ` +
                `while the database names ${target.referenced.size}. That is a path mismatch, ` +
                `not an empty library.`
        );

        return { removed: 0, onDisk };
    }

    let removed = 0;

    for (const relPath of orphans) {
        const absolute = path.join(target.dir, relPath);

        try {
            const stats = await stat(absolute);

            if (Date.now() - stats.mtimeMs < GRACE_MS) {
                continue;
            }

            await unlink(absolute);
            removed += 1;
        } catch {
            // Gone already, or busy. Either way the next sweep will find it if it matters.
        }
    }

    return { removed, onDisk };
};

/**
 * Removes the scratch directories an interrupted preview or seeking sprite left behind.
 *
 * `renderPreview` works in a directory of its own per attempt (`.preview-parts-XXXXXX`) so that two
 * attempts at one item cannot write the same file — which they did, and the corruption was
 * reported by ffmpeg as duplicate EBML elements in a part that then vanished mid-concat. The cost
 * of that fix is that a killed attempt leaves a *new* directory rather than reusing one, and a
 * container on a NAS gets killed.
 *
 * The files inside are swept by `sweepDirectory` like any other unreferenced artifact; this takes
 * the empty husk afterwards, because §17 counts inodes here as a real budget. `rmdir` rather than
 * anything recursive, and only on a name this app generates: it refuses on a directory that still
 * has something in it, which makes "delete an in-flight attempt's work" impossible rather than
 * merely unlikely.
 */
const removeAbandonedWorkDirs = async (artDir: string): Promise<void> => {
    let shards;
    try {
        shards = await readdir(artDir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const shard of shards.filter((entry) => entry.isDirectory())) {
        const shardPath = path.join(artDir, shard.name);

        let items;
        try {
            items = await readdir(shardPath, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const item of items.filter((entry) => entry.isDirectory())) {
            const itemPath = path.join(shardPath, item.name);

            let work;
            try {
                work = await readdir(itemPath, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const dir of work) {
                if (
                    !dir.isDirectory() ||
                    !(dir.name.startsWith(".preview-parts") || dir.name.startsWith(".sprite-tiles"))
                ) {
                    continue;
                }

                // Fails while anything is still inside, which is the whole safety argument.
                await rmdir(path.join(itemPath, dir.name)).catch(() => undefined);
            }
        }
    }
};

/**
 * How many rows one read takes, and how long the sweep then leaves the disk alone.
 *
 * `Artifact` is ~3,700 pages on the real library, and on a cold cache each is a ~100 ms read on
 * the disk the web process is waiting on (§20). It was read in single statements of 8–17 s, three
 * times per sweep — once per question asked of it. Now it is read once, keyset-paged on rowid,
 * with a pause between batches so the web process's reads queue behind one batch rather than
 * behind the whole table.
 */
const READ_BATCH = 2_000;
const READ_PAUSE_MS = 100;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every row of a table, a batch at a time in rowid order.
 *
 * Not one snapshot, and it does not need to be. A row inserted mid-read lands past the cursor
 * and names a file younger than the hour of grace, which protects it from both halves of this
 * sweep; a row deleted mid-read only keeps its file referenced until tomorrow.
 */
const readInBatches = async <T>(table: string, columns: string): Promise<T[]> => {
    const statement = db.prepare(
        `SELECT rowid AS "cursor", ${columns} FROM "${table}"
          WHERE rowid > ? ORDER BY rowid LIMIT ?`
    );
    const rows: T[] = [];
    let cursor = 0;

    for (;;) {
        const batch = statement.all(cursor, READ_BATCH) as (T & { cursor: number })[];

        rows.push(...batch);

        if (batch.length < READ_BATCH) {
            return rows;
        }

        cursor = batch[batch.length - 1].cursor;
        await pause(READ_PAUSE_MS);
    }
};

/** Stored with forward slashes; compared against a walk that produces the same. */
const normalise = (relPath: string): string => relPath.replace(/\\/g, "/");

interface StoredRow {
    id: string;
    relPath: string;
    /**
     * Older than an hour: the grace the file sweep gives, for the same race. The row is written
     * as the job finishes, and on a slow share the rename may still be settling.
     */
    settled: 0 | 1;
}

interface ArtifactRow extends StoredRow {
    mediaId: string;
    kind: string;
    source: string;
}

/** What the walks saw, in stored form, and the top-level directories they covered. */
interface Walked {
    onDisk: Set<string>;
    prefixes: Set<string>;
}

/**
 * A stage's per-item files under one directory (§5e, §5f): vectors files for `embed`, faces files
 * for `faces`.
 *
 * No table names these files, unlike artifacts: the stage row is the record, and the path
 * follows from the item's id. A purged item's row goes with it, and its file is then swept here;
 * a `done` row whose file has gone is dropped so the stage runs again, which is the same repair
 * `reclaimMissingRows` makes for artifacts — and refused, as that is, when every file is missing at
 * once, which is an unmounted volume rather than a hundred thousand lost files. `keep` names files
 * that belong to the directory rather than to an item, such as the representatives log.
 */
const sweepStageFiles = async (
    dataDir: string,
    {
        stage,
        dir,
        relPathOf,
        keep,
    }: { stage: string; dir: string; relPathOf: (mediaId: string) => string; keep: string[] }
): Promise<{ removed: number; reclaimed: number }> => {
    const prefix = path.basename(dir);
    const rows = db
        .prepare(
            `SELECT "mediaId", ("at" < datetime('now', '-1 hour')) AS "settled"
               FROM "MediaStage" WHERE "stage" = ? AND "state" = 'done'`
        )
        .all(stage) as { mediaId: string; settled: 0 | 1 }[];
    const files = await sweepDirectory({
        dir,
        storedPrefix: prefix,
        referenced: new Set([...keep, ...rows.map((row) => relPathOf(row.mediaId))]),
    });
    const missing = findMissing(
        dataDir,
        rows.map((row) => ({
            id: row.mediaId,
            relPath: relPathOf(row.mediaId),
            settled: row.settled,
        })),
        { onDisk: files.onDisk, prefixes: new Set([prefix]) }
    );

    if (missing === null) {
        console.error(
            `Refusing to reclaim ${stage} files: every one is missing under ${dir}. ` +
                `Check that the data volume is mounted.`
        );
    }

    const clear = db.prepare(
        `DELETE FROM "MediaStage" WHERE "mediaId" = ? AND "stage" = ? AND "state" = 'done'`
    );
    const reclaimed = db.transaction(() =>
        (missing ?? []).reduce((count, row) => count + clear.run(row.id, stage).changes, 0)
    )();

    return { removed: files.removed, reclaimed };
};

export interface OrphanSweepResult {
    art: number;
    captures: number;
    variants: number;
    trash: number;
    embed: number;
    faces: number;
    tileprints: number;
    tags: number;
    /** Rows dropped because the file they name is gone, so the stage runs again. */
    reclaimed: number;
}

/**
 * Which stage produced an artifact of this kind.
 *
 * Deleting the row is not enough on its own: the sweep in §7b asks `MediaStage`, not
 * `Artifact`, so a cover whose bytes vanished stays marked `done` and is never regenerated.
 * Clearing the stage row is what turns a missing file back into work.
 *
 * `capture` and `subtitleVtt` are absent deliberately -- neither is produced by a stage, so
 * there is nothing to re-run and the row is simply dropped.
 */
const PRODUCING_STAGE: Record<string, string | undefined> = {
    cover: "cover",
    poster: "cover",
    preview: "preview",
    sprite: "sprite",
    spriteVtt: "sprite",
};

/**
 * Does the file a row names exist under `dataDir`?
 *
 * The stored path is checked rather than merely normalised, because a path read back out of
 * the database gets the same treatment as one that arrived in a request. A row whose path
 * cannot be trusted is reported as *present*, so this sweep leaves it alone: the alternative
 * is deleting a row on the strength of a path we just refused to resolve.
 */
const rowFileExists = (dataDir: string, relPath: string): boolean => {
    try {
        return existsSync(path.resolve(dataDir, assertSafeRelativePath(relPath)));
    } catch {
        console.warn(`Leaving a row whose stored path is not safe to resolve: "${relPath}"`);

        return true;
    }
};

/**
 * Has the walk seen this row's file? `null` when the row is outside every walked directory --
 * a tree this job does not walk, or a path that is not safe to resolve -- and the filesystem has
 * to be asked instead, exactly as every row used to be.
 */
const seenInWalk = (walked: Walked, relPath: string): boolean | null => {
    const normalised = normalise(relPath);

    return walked.prefixes.has(normalised.split("/")[0]) ? walked.onDisk.has(normalised) : null;
};

/**
 * The settled rows whose file is gone, or `null` when every one of them is.
 *
 * Every row missing at once is a `/data` that is not mounted, or a `dataDir` pointing somewhere
 * else -- not a library that lost all its pictures -- and the caller refuses rather than acting on
 * it. Decided before any confirming `stat`, so an unmounted volume costs nothing per row.
 *
 * A row the walk did not see is confirmed before it counts. That is a handful of calls rather
 * than one per row, and it closes the gap between the walk and the read: a file regenerated in
 * place after the walk passed its directory is still there.
 */
const findMissing = <T extends StoredRow>(
    dataDir: string,
    rows: T[],
    walked: Walked
): T[] | null => {
    const settled = rows.filter((row) => row.settled === 1);
    const unseen = settled.filter((row) => {
        const seen = seenInWalk(walked, row.relPath);

        return seen === null ? !rowFileExists(dataDir, row.relPath) : !seen;
    });

    if (settled.length > 0 && unseen.length === settled.length) {
        return null;
    }

    return unseen.filter(
        (row) => seenInWalk(walked, row.relPath) === null || !rowFileExists(dataDir, row.relPath)
    );
};

/**
 * Rows naming a file that is not there (§13d).
 *
 * The mirror of the sweep above, and the half that was missing. A row without its bytes shows
 * as a broken cover in the grid and nothing ever notices, because every "what still needs
 * doing" query in the app asks the database and the database says it was done.
 *
 * This is not hypothetical. The path-space bug in `sweepDirectory` unlinked every artifact
 * older than an hour the one time it ran, leaving 875 rows across 187 items pointing at empty
 * directories -- a library full of items with no picture, and no mechanism that would ever
 * have put them back.
 *
 * Only `auto` artifacts. A user's chosen capture may not be deleted and regenerated at will
 * (§9), so a missing one is reported rather than quietly dropped: the choice is already lost,
 * and removing the record of it would lose the fact that there was one.
 *
 * A row is deleted only while it still names the path found missing. The read and the delete
 * are minutes apart now that the read is paced, and a cover regenerated in between has a new
 * file and must keep its row.
 */
const reclaimMissingRows = (
    dataDir: string,
    artifacts: ArtifactRow[],
    variants: StoredRow[],
    walked: Walked
): number => {
    const missing = findMissing(dataDir, artifacts, walked);

    if (missing === null) {
        console.error(
            `Refusing to reclaim: every settled artifact row names a file that is missing ` +
                `under ${dataDir}. Check that the data volume is mounted.`
        );

        return 0;
    }

    const userChosen = missing.filter((row) => row.source === "user");

    if (userChosen.length > 0) {
        console.warn(
            `${userChosen.length} user-chosen artifact(s) name files that are gone; ` +
                `leaving the rows alone (§9)`
        );
    }

    const dropArtifact = db.prepare(`DELETE FROM "Artifact" WHERE "id" = ? AND "relPath" = ?`);
    const clearStage = db.prepare(`DELETE FROM "MediaStage" WHERE "mediaId" = ? AND "stage" = ?`);

    const reclaimed = db.transaction(() => {
        let count = 0;

        for (const row of missing) {
            if (row.source === "user") {
                continue;
            }

            // Changed since it was read: not the row that was found missing.
            if (dropArtifact.run(row.id, row.relPath).changes === 0) {
                continue;
            }

            const stage = PRODUCING_STAGE[row.kind];

            if (stage) {
                clearStage.run(row.mediaId, stage);
            }

            count += 1;
        }

        return count;
    })();

    /**
     * Variants need no stage cleared.
     *
     * Transcoding is selected by whether a browser can play the file rather than by a
     * `MediaStage` row (§8), so the backfill finds the item again as soon as the row naming a
     * rendition that does not exist is gone.
     */
    const missingVariants = findMissing(dataDir, variants, walked);

    if (missingVariants === null) {
        return reclaimed;
    }

    const dropVariant = db.prepare(`DELETE FROM "Variant" WHERE "id" = ? AND "relPath" = ?`);

    return (
        reclaimed +
        db.transaction(() => {
            let count = 0;

            for (const row of missingVariants) {
                count += dropVariant.run(row.id, row.relPath).changes;
            }

            return count;
        })()
    );
};

/**
 * The `orphanSweep` job.
 *
 * Runs after the worker's startup grace and daily thereafter, and after a library is forgotten.
 * The startup pass is what reconciles a database that was reset, restored or initialised fresh
 * beside a `/data` belonging to one that no longer exists (§13d); it is late by a few minutes
 * now, never skipped (`startup.ts`).
 *
 * Each table is read once and each directory walked once, and both questions -- files nobody
 * references, rows naming files that are gone -- are answered from those. It used to read
 * `Artifact` three times and `stat` every row besides.
 */
export const runOrphanSweep = async (): Promise<void> => {
    const config = loadConfig();
    const paths = dataPaths(config);

    // Before the walks, so a file written after its row was read is younger than the grace
    // period rather than unreferenced.
    const artifacts = await readInBatches<ArtifactRow>(
        "Artifact",
        `"id", "mediaId", "kind", "relPath", "source",
         ("generatedAt" < datetime('now', '-1 hour')) AS "settled"`
    );
    const variants = await readInBatches<StoredRow>(
        "Variant",
        `"id", "relPath", ("createdAt" < datetime('now', '-1 hour')) AS "settled"`
    );

    const referenced = (rows: StoredRow[]): Set<string> =>
        new Set(rows.map((row) => normalise(row.relPath)));

    /**
     * Scoped by kind, because artifacts no longer live in one tree (§13).
     *
     * Without the split every capture's path would be handed to the `art` sweep as a reference
     * it cannot match, and the set of referenced files would stop describing the directory
     * being swept — which is exactly the mismatch the circuit breaker exists to catch, reported
     * as a bug rather than as the miscount it is.
     */
    const art = await sweepDirectory({
        dir: paths.art,
        storedPrefix: "art",
        referenced: referenced(artifacts.filter((row) => row.kind !== "capture")),
    });

    /**
     * Captures, swept the same way but never for the same reason.
     *
     * Nothing regenerates these, so the only files here that are genuinely orphaned are ones
     * whose row was deleted while the unlink failed. Sweeping them is still right — an
     * unreferenced capture is unreachable and invisible — but the circuit breaker matters more
     * here than anywhere: a path mismatch would delete the one copy.
     */
    const captures = await sweepDirectory({
        dir: paths.captures,
        storedPrefix: "captures",
        referenced: referenced(artifacts.filter((row) => row.kind === "capture")),
    });

    const variantFiles = await sweepDirectory({
        dir: paths.variants,
        storedPrefix: "variants",
        referenced: referenced(variants),
    });

    /**
     * Trashed bytes no open entry is holding.
     *
     * Only reachable through an open `TrashEntry`, so any other file in the bin can never be
     * restored or purged by anything else — it is disk that would be lost for good. One way to
     * get one is forgetting a library, which cascades its trash entries away and leaves the
     * bytes behind. The other is a file coming back by itself (§10e): the scan revives the row
     * and closes the entry, and the copy in the bin is then a spare of bytes the library has
     * again. Closed entries used to count as holding their bytes, so those spares stayed on
     * /data for good.
     */
    const trash = await sweepDirectory({
        dir: paths.trash,
        // No prefix: the trash job resolves this column against the trash directory.
        storedPrefix: "",
        referenced: new Set(
            (
                db
                    .prepare(
                        `SELECT "trashRelPath" FROM "TrashEntry"
                          WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL`
                    )
                    .all() as { trashRelPath: string }[]
            ).flatMap((row) => {
                const normalised = normalise(row.trashRelPath);

                // The manifest written beside each file shares its fate (§10).
                return [normalised, `${normalised}.json`];
            })
        ),
    });

    const vectorFiles = await sweepStageFiles(config.dataDir, {
        stage: "embed",
        dir: paths.embed,
        relPathOf: vectorFileRelPath,
        keep: [REPRESENTATIVES_LOG_REL_PATH],
    });
    const faceFiles = await sweepStageFiles(config.dataDir, {
        stage: "faces",
        dir: paths.faces,
        relPathOf: faceFileRelPath,
        keep: [FACE_ANCHORS_REL_PATH],
    });
    const tilePrintFiles = await sweepStageFiles(config.dataDir, {
        stage: "tileprint",
        dir: paths.tileprints,
        relPathOf: tilePrintRelPath,
        keep: [],
    });

    /**
     * Tags' pictures (§6 "A tag's picture"), and the `tagPictures` job's scratch frames. An
     * automatic picture whose file has gone loses its row, so the job draws it again; a chosen one
     * is reported and kept, for the reason a capture's is (§9).
     */
    const pictureRows = (
        db
            .prepare(
                `SELECT "tagId", "source", "relPath", "smallRelPath",
                        ("generatedAt" < datetime('now', '-1 hour')) AS "settled"
                   FROM "TagPicture"`
            )
            .all() as {
            tagId: string;
            source: string;
            relPath: string;
            smallRelPath: string;
            settled: 0 | 1;
        }[]
    ).map((row) => ({ ...row, id: row.tagId }));
    const tagPictures = await sweepDirectory({
        dir: paths.tags,
        storedPrefix: "tags",
        referenced: new Set(
            pictureRows.flatMap((row) => [normalise(row.relPath), normalise(row.smallRelPath)])
        ),
    });
    const missingPictures =
        findMissing(config.dataDir, pictureRows, {
            onDisk: tagPictures.onDisk,
            prefixes: new Set(["tags"]),
        }) ?? [];
    const dropPicture = db.prepare(
        `DELETE FROM "TagPicture" WHERE "tagId" = ? AND "source" = 'auto' AND "relPath" = ?`
    );
    const picturesReclaimed = missingPictures.reduce(
        (count, row) =>
            count + (row.source === "auto" ? dropPicture.run(row.tagId, row.relPath).changes : 0),
        0
    );

    if (missingPictures.some((row) => row.source === "user")) {
        console.warn("Some chosen tag pictures name files that are gone; leaving the rows alone");
    }

    const result: OrphanSweepResult = {
        art: art.removed,
        captures: captures.removed,
        variants: variantFiles.removed,
        trash: trash.removed,
        embed: vectorFiles.removed,
        faces: faceFiles.removed,
        tileprints: tilePrintFiles.removed,
        tags: tagPictures.removed,
        reclaimed:
            picturesReclaimed +
            vectorFiles.reclaimed +
            faceFiles.reclaimed +
            tilePrintFiles.reclaimed +
            reclaimMissingRows(config.dataDir, artifacts, variants, {
                onDisk: new Set([...art.onDisk, ...captures.onDisk, ...variantFiles.onDisk]),
                prefixes: new Set(["art", "captures", "variants"]),
            }),
    };

    await removeAbandonedWorkDirs(paths.art);

    const total =
        result.art +
        result.captures +
        result.variants +
        result.trash +
        result.embed +
        result.faces +
        result.tileprints +
        result.tags;

    if (total > 0) {
        console.log(
            `Removed ${total} orphaned file(s): ${result.art} artifact(s), ` +
                `${result.captures} capture(s), ${result.variants} variant(s), ` +
                `${result.trash} in the trash, ${result.embed} vectors file(s), ` +
                `${result.faces} faces file(s), ${result.tileprints} tile prints file(s), ` +
                `${result.tags} tag picture file(s)`
        );
    }

    if (result.reclaimed > 0) {
        console.log(
            `Dropped ${result.reclaimed} row(s) whose file was gone; the stages that produce ` +
                `them will run again`
        );
    }
};
