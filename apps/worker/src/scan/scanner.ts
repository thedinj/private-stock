import { readdir, stat } from "node:fs/promises";
import { existsSync, type Stats } from "node:fs";
import * as path from "node:path";

import {
    assertSafeRelativePath,
    classifyPath,
    titleFromPath,
    toPosixRelative,
} from "@private-stock/core";
import {
    changeLogRepo,
    db,
    mediaFileRepo,
    mediaRepo,
    mediaRootRepo,
    scanRepo,
    searchRepo,
    stageRepo,
    trashRepo,
    type MediaFileRow,
    type MediaRootRow,
    type ScanCounts,
} from "@private-stock/db";

import { FILEHASH_PRIORITY, type FileHashPayload } from "../jobs/fileHash.js";
import { enqueue } from "../queue.js";

/**
 * The library scanner (§7).
 *
 * Deliberately stat-based: a full walk compares `(size, mtime)` and never reads file
 * contents, because hashing every file on every pass would make a rescan over SMB unusable.
 * The performance budget (§20) is a rescan of an unchanged 200k-item library in under five
 * minutes, and that is only reachable if the common case costs one `stat` per file.
 */

/**
 * How recently a file must have been touched before its stability is checked directly.
 *
 * Copying a large file onto a NAS takes minutes, and probing it halfway through produces a
 * corrupt-looking result that then has to be detected and redone.
 */
const RECENTLY_MODIFIED_MS = 30_000;

/** Gap between the two observations used to decide whether a file is still growing. */
const SETTLE_RECHECK_MS = 1_500;

/**
 * Is this file finished being written?
 *
 * Deliberately a real check rather than "ignore anything younger than 30 seconds". That age
 * rule looks equivalent and is not: a watcher-triggered scan runs *because* a file just
 * appeared, so a blanket age test rejects the very file it was woken for — and with a daily
 * safety-net scan, it would not be looked at again for a day.
 *
 * Two observations a moment apart answer the actual question. Only recently-touched files
 * pay for the extra stat, so a rescan of a settled library is unaffected.
 */
const isSettled = async (absolutePath: string, stats: Stats, now: number): Promise<boolean> => {
    if (now - stats.mtimeMs >= RECENTLY_MODIFIED_MS) {
        return true;
    }

    await new Promise((resolve) => setTimeout(resolve, SETTLE_RECHECK_MS));

    try {
        const again = await stat(absolutePath);

        return again.size === stats.size && again.mtimeMs === stats.mtimeMs;
    } catch {
        // Vanished between the two looks — a temporary file, or a move in progress.
        return false;
    }
};

/** Write in batches so a long scan does not hold one enormous transaction open. */
const BATCH_SIZE = 200;

/** How often a running scan's progress row is rewritten. `finish` writes the final figures. */
const COUNTS_INTERVAL_MS = 5_000;

interface PendingFile {
    relPath: string;
    size: number;
    mtimeMs: number;
    dev: string | null;
    inode: string | null;
    classification: "media" | "companion" | "ignored";
    kind: "image" | "video" | null;
}

/**
 * Walk a directory tree, yielding batches.
 *
 * Iterative rather than recursive: a deeply nested library should not be able to exhaust the
 * stack, and an explicit stack makes it trivial to skip an unreadable subtree — a permission
 * error on one folder must not abort the whole scan.
 */
async function* walkRoot(rootDir: string, startDir: string): AsyncGenerator<PendingFile[]> {
    const stack: string[] = [startDir];
    let batch: PendingFile[] = [];

    while (stack.length > 0) {
        const current = stack.pop()!;

        let entries;
        try {
            entries = await readdir(current, { withFileTypes: true });
        } catch (error) {
            console.warn(`Skipping unreadable directory ${current}: ${(error as Error).message}`);
            continue;
        }

        for (const entry of entries) {
            const absolute = path.join(current, entry.name);
            const relPath = toPosixRelative(path.relative(rootDir, absolute));

            if (entry.isDirectory()) {
                // Classify the directory itself so ignored trees (@eaDir, #recycle) are never
                // descended into — the cost of walking them is the point, not just the rows.
                const verdict = classifyPath(`${relPath}/placeholder.mp4`);
                if (verdict.classification !== "ignored") {
                    stack.push(absolute);
                }
                continue;
            }

            if (!entry.isFile()) {
                // Sockets, FIFOs, block devices. Symlinks are not followed: a link pointing
                // outside the root would import files the admin never mounted.
                continue;
            }

            const verdict = classifyPath(relPath);

            if (verdict.classification === "ignored") {
                continue;
            }

            let stats;
            try {
                stats = await stat(absolute);
            } catch {
                continue;
            }

            // Still being written — leave it for the next pass.
            if (!(await isSettled(absolute, stats, Date.now()))) {
                continue;
            }

            batch.push({
                relPath,
                size: stats.size,
                mtimeMs: Math.floor(stats.mtimeMs),
                dev: stats.dev ? String(stats.dev) : null,
                inode: stats.ino ? String(stats.ino) : null,
                classification: verdict.classification,
                kind: verdict.kind,
            });

            if (batch.length >= BATCH_SIZE) {
                yield batch;
                batch = [];
            }
        }
    }

    if (batch.length > 0) {
        yield batch;
    }
}

export interface ScanOptions {
    /**
     * Restrict the scan to one directory below the root, POSIX-relative.
     *
     * This is what makes watcher-driven scanning cheap: a file landing in one folder costs a
     * walk of that folder, not of the whole library.
     */
    subPath?: string;
    /**
     * Re-examine files even when size and mtime are unchanged.
     *
     * The normal scan's whole economy is skipping unchanged files, so this is deliberately
     * not the default — it re-queues a probe for every item in the root. It earns its cost
     * when the probe logic itself has changed, or when someone suspects the catalogue has
     * drifted from what is on disk.
     */
    force?: boolean;
}

/**
 * Which of these paths are files the library already knows, under a new name (§7).
 *
 * Only paths with no row of their own can be moves, so an ordinary rescan of an unchanged
 * library does no work here at all. A reorganisation pays one `stat` per moved file, to
 * answer the question that separates a move from a copy: **is the old path still there?**
 *
 * A copy leaves the original in place and takes a fresh inode, so it would fail both tests.
 * Checking anyway is cheap, and the cost of being wrong is one file's history attached to
 * another file.
 */
const detectMoves = async (
    root: MediaRootRow,
    rootDir: string,
    batch: PendingFile[],
    scanId: string,
    scanStartedAt: string
): Promise<Map<string, MediaFileRow>> => {
    const moves = new Map<string, MediaFileRow>();

    for (const pending of batch) {
        if (mediaFileRepo.findByPath(root.id, pending.relPath)) {
            continue;
        }

        const candidate = mediaFileRepo.findMoveCandidate({
            rootId: root.id,
            dev: pending.dev,
            inode: pending.inode,
            size: pending.size,
            mtime: pending.mtimeMs,
            scanStartedAt,
            scanId,
        });

        if (!candidate) {
            continue;
        }

        try {
            await stat(path.resolve(rootDir, assertSafeRelativePath(candidate.relPath)));
            // Still there, so this is a copy rather than a move and the new path is a new file.
            continue;
        } catch {
            moves.set(pending.relPath, candidate);
        }
    }

    return moves;
};

export const scanRoot = async (
    root: MediaRootRow,
    options: ScanOptions = {}
): Promise<ScanCounts> => {
    const rootDir = root.path;
    const subPath = options.subPath ? assertSafeRelativePath(options.subPath) : "";
    const startDir = subPath ? path.resolve(rootDir, subPath) : rootDir;

    const scan = scanRepo.start(root.id);

    /**
     * The scan's start time, taken from SQLite rather than from JavaScript.
     *
     * These two do not produce comparable strings: SQLite's CURRENT_TIMESTAMP is
     * "2026-09-15 00:30:14" while `toISOString()` is "2026-09-15T00:31:10.532Z". Compared as
     * text — which is what a DATETIME column comparison does — the space sorts before the
     * "T", so every row looks older than the scan start and the reconcile pass marks the
     * entire library missing. Three scans later it would archive itself.
     *
     * Reading the value back from the row the database just wrote makes the formats
     * identical by construction.
     */
    const startedAt = scan.startedAt;

    // Where this scan confirms the files it did not need to write (see `beginScanSeen`).
    mediaFileRepo.beginScanSeen(scan.id);

    const counts: ScanCounts = {
        filesSeen: 0,
        filesAdded: 0,
        filesChanged: 0,
        filesMissing: 0,
        filesMoved: 0,
    };

    try {
        await stat(startDir);
    } catch {
        // An unmounted share is not a scan failure to be retried in a tight loop; it is a
        // fact about the world. Fail the scan and leave every existing row untouched — in
        // particular, do *not* reconcile, or one offline share would mark a whole root
        // missing.
        scanRepo.fail(scan.id, `Directory is not available: ${startDir}`);
        throw new Error(`Directory is not available: ${startDir}`);
    }

    let countsWrittenAt = Date.now();

    try {
        for await (const batch of walkRoot(rootDir, startDir)) {
            // Resolved before the transaction opens, because deciding this needs the
            // filesystem and the batch is written synchronously.
            const moved = await detectMoves(root, rootDir, batch, scan.id, startedAt);

            /**
             * Items whose file moved in this batch: their search document still says the old
             * name, and nothing else would ever rebuild it — the index stage is settled (§12b).
             * Reindexed once for the batch after it commits, so a renamed folder of a thousand
             * files is one statement per item rather than a transaction each.
             */
            const movedMedia: string[] = [];

            const enqueueAfterCommit: {
                fileId: string;
                relPath: string;
                kind: "image" | "video";
            }[] = [];

            db.transaction(() => {
                // Accumulated and written at the end of the same transaction as the changes
                // they describe (§13b), so the grid can never be told about a row that was
                // then rolled back — nor miss one that was not.
                const changes: changeLogRepo.RecordChangeInput[] = [];

                for (const pending of batch) {
                    const movedFrom = moved.get(pending.relPath);

                    if (movedFrom) {
                        /**
                         * The same file, at a new path.
                         *
                         * Recording the move rather than creating a row is the whole point:
                         * the item, its tags, its rating and its processing history stay
                         * attached to the file instead of being stranded on an item that is
                         * about to be archived.
                         */
                        mediaFileRepo.recordMove(movedFrom.id, pending.relPath);
                        counts.filesSeen += 1;
                        counts.filesMoved += 1;

                        const mediaId = mediaRepo.findMediaIdForFile(movedFrom.id);

                        if (mediaId) {
                            mediaRepo.retitleAfterMove(
                                mediaId,
                                titleFromPath(movedFrom.relPath),
                                titleFromPath(pending.relPath)
                            );
                            movedMedia.push(mediaId);
                            changes.push({
                                entity: "media",
                                entityId: mediaId,
                                rootId: root.id,
                                op: "update",
                                detail: "moved",
                            });
                        }

                        continue;
                    }

                    const result = mediaFileRepo.upsertSeen({
                        scanId: scan.id,
                        rootId: root.id,
                        relPath: pending.relPath,
                        size: pending.size,
                        mtime: pending.mtimeMs,
                        dev: pending.dev,
                        inode: pending.inode,
                        classification: pending.classification,
                        isOnDiskNow: () =>
                            existsSync(
                                path.resolve(rootDir, assertSafeRelativePath(pending.relPath))
                            ),
                    });

                    counts.filesSeen += 1;

                    if (result.outcome === "created") counts.filesAdded += 1;
                    if (result.outcome === "changed") counts.filesChanged += 1;

                    /**
                     * The file was trashed and is back at its old path.
                     *
                     * Someone restored it with a file manager rather than through the app, so
                     * the trash entry now describes a deletion that has been undone. Closing
                     * it here is what stops the retention window running out and the purge
                     * destroying an item the library is, by this point, happily showing
                     * (§10).
                     */
                    if (result.revivedFromTrash && trashRepo.markRestoredByFile(result.file.id)) {
                        console.log(
                            `${pending.relPath} reappeared in ${root.label}; closed its trash entry`
                        );
                    }

                    if (pending.classification !== "media" || !pending.kind) {
                        continue;
                    }

                    // Still on its way to the bin. Even a forced rescan must not queue work
                    // against it: that work would fail once the move lands.
                    if (result.file.state === "trashed") {
                        continue;
                    }

                    // A companion or an unchanged file needs nothing further; this is the
                    // path that keeps a rescan cheap. A forced rescan gives that up on
                    // purpose.
                    if (result.outcome === "seen" && !options.force) {
                        continue;
                    }

                    const existingMediaId = mediaRepo.findMediaIdForFile(result.file.id);

                    if (!existingMediaId) {
                        const mediaId = mediaRepo.createForFile({
                            kind: pending.kind,
                            title: titleFromPath(pending.relPath),
                            fileId: result.file.id,
                        });

                        changes.push({
                            entity: "media",
                            entityId: mediaId,
                            rootId: root.id,
                            op: "insert",
                        });
                    } else if (result.outcome === "changed") {
                        // Failures recorded against the old bytes say nothing about these —
                        // typically a download caught half-written that has since finished.
                        stageRepo.clearFailures(existingMediaId);

                        changes.push({
                            entity: "media",
                            entityId: existingMediaId,
                            rootId: root.id,
                            op: "update",
                        });
                    }

                    enqueueAfterCommit.push({
                        fileId: result.file.id,
                        relPath: pending.relPath,
                        kind: pending.kind,
                    });
                }

                changeLogRepo.recordMany(changes);
            })();

            searchRepo.requestReindex(movedMedia);

            for (const item of enqueueAfterCommit) {
                const mediaId = mediaRepo.findMediaIdForFile(item.fileId);

                if (!mediaId) {
                    continue;
                }

                /**
                 * Identify the file first, and let the hash queue the probe (§10f).
                 *
                 * Everything after the probe renders something, and an identical copy can take
                 * what its twin already rendered -- but only once something knows it is one. The
                 * payload records what the probe had seen so far, so the hash can tell whether
                 * the probe it owes has already happened on an earlier attempt.
                 */
                const chained = enqueue(db, {
                    kind: "filehash",
                    mediaId,
                    fileId: item.fileId,
                    priority: FILEHASH_PRIORITY,
                    payload: {
                        probeAfter: true,
                        probedAt: mediaRepo.findBasic(mediaId)?.probedAt ?? null,
                    } satisfies FileHashPayload,
                });

                // A hash the sweep had already queued for this item carries no such promise,
                // and the conflict kept that one -- so the probe is queued here instead.
                if (!chained) {
                    enqueue(db, { kind: "probe", mediaId, fileId: item.fileId, priority: 50 });
                }
            }

            // On a timer rather than per batch: a commit is what empties the web process's
            // page cache (§20), and a progress figure a few seconds old costs nothing.
            if (Date.now() - countsWrittenAt >= COUNTS_INTERVAL_MS) {
                scanRepo.updateCounts(scan.id, counts);
                countsWrittenAt = Date.now();
            }
        }

        // Scoped to the subtree that was actually walked — reconciling a subtree scan
        // against the whole root would mark every untouched file missing.
        counts.filesMissing = mediaFileRepo.markMissingAfterScan(
            root.id,
            scan.id,
            startedAt,
            subPath
        );

        if (counts.filesMissing > 0) {
            // One row without an entityId rather than one per file. A share that went offline
            // marks a whole root missing at once, and the client's response either way is to
            // refetch the list — sending ten thousand individual removals to say so would
            // cost more than the refetch it triggers.
            changeLogRepo.record({
                entity: "media",
                rootId: root.id,
                op: "delete",
                detail: String(counts.filesMissing),
            });
        }

        scanRepo.finish(scan.id, counts);

        // Only a full scan means "this root is current"; a subtree scan says nothing about
        // the rest of it.
        if (!subPath) {
            mediaRootRepo.markScanned(root.id);
        }

        return counts;
    } catch (error) {
        scanRepo.fail(scan.id, (error as Error).message);
        throw error;
    } finally {
        mediaFileRepo.endScanSeen(scan.id);
    }
};
