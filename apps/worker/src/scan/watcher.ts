import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import * as path from "node:path";

import { classifyPath, shouldIgnoreDirectory, toPosixRelative } from "@private-stock/core";
import { db, type MediaRootRow } from "@private-stock/db";

import { enqueue } from "../queue.js";

/**
 * OS-event-driven scanning.
 *
 * A file dropped into the library should appear in seconds, not at the next scheduled walk.
 * Native filesystem events give that, and a targeted rescan of the one affected directory
 * costs almost nothing compared with walking the whole root.
 *
 * ### Where this works, and where it cannot
 *
 * Watching is reliable when the watched path is a **local** filesystem. On a QNAP,
 * `/share/CACHEDEV1_DATA` is local, so a file written to it over SMB from another machine
 * still lands on the NAS's own filesystem and inotify fires normally.
 *
 * It is *not* reliable when the container mounts a **remote** share (NFS, or CIFS from
 * another box): inotify only sees changes made through the local kernel, so writes by other
 * machines are invisible, silently and with no error. Polling would catch them but at a
 * cost — re-statting a 200k-item library every few seconds over a network mount is exactly
 * the I/O storm the stat-based design exists to avoid.
 *
 * So: watch where it works, keep a periodic full scan as the safety net, and never poll a
 * network mount by default.
 *
 * ### One watch per directory, never per file
 *
 * An event only ever names a directory to rescan, so a directory is the finest grain worth
 * watching — and a watch on a directory already reports every file in it being created,
 * written, renamed or deleted. This used to be chokidar, which watches **every file** with an
 * `fs.watch` of its own on top of its directory: 13,023 handles and inotify watches for the
 * 13k-file library, ~27 MB of live JavaScript heap and ~67 MB of resident memory in the worker,
 * growing with the library and paid for nothing the scanner used (§20 "The worker's own
 * memory"). At 200k items it would also have run into the kernel's inotify watch limit.
 *
 * What chokidar's `awaitWriteFinish` gave is not needed here: a file still being copied keeps
 * the quiet period from ending, and the scanner settles every file itself, across two
 * observations, before importing it.
 */

/**
 * Wait for quiet before acting.
 *
 * Copying a folder emits hundreds of events; a single unpacking archive emits thousands.
 * Batching them into one targeted scan per directory is the difference between one walk and
 * a thousand redundant ones.
 */
const QUIET_PERIOD_MS = 3_000;

/**
 * The longest a change waits for quiet that never comes.
 *
 * A file being copied fires an event per write, so a twenty-minute copy would otherwise hold back
 * every other change in the library for twenty minutes. The scan this queues settles each file
 * before importing it, so meeting a half-written one costs nothing but a later look.
 */
const MAX_DELAY_MS = 30_000;

/**
 * How long a burst of events is collected before the names in it are looked at.
 *
 * A file being copied fires an event per write. Looking each one up would be a `stat` per
 * write; collected, it is one per distinct name per interval.
 */
const SETTLE_NAMES_MS = 250;

/**
 * Above this many distinct directories in one batch, scan the whole root instead.
 *
 * A bulk import touching hundreds of folders is cheaper to handle as one full walk than as
 * hundreds of subtree scans, each with its own transaction and reconcile pass.
 */
const FULL_SCAN_THRESHOLD = 25;

/**
 * How long a removal the app made itself is waited for. The event follows the unlink within
 * milliseconds; this only bounds how long a mark that never met its event is kept.
 */
const EXPECTED_REMOVAL_MS = 60_000;

/**
 * Files the app has just removed from a library itself, by absolute path, until their event.
 *
 * Deleting is the one write the app makes in a media root (§10), and it records the deletion
 * in the catalogue as it goes, so its event says nothing a scan needs to learn. Scanned anyway,
 * it cost a walk of the file's whole directory per file: deleting 120 videos at the top of a
 * 13k-item library was 120 full walks, interleaved with copying 45 GB into the bin on the same
 * disks (§18.1).
 */
const expectedRemovals = new Map<string, number>();

/** Say the app has just removed this file itself, so its disappearance needs no scan. */
export const expectRemoval = (absolutePath: string): void => {
    const now = Date.now();

    for (const [expected, until] of expectedRemovals) {
        if (until < now) expectedRemovals.delete(expected);
    }

    expectedRemovals.set(path.resolve(absolutePath), now + EXPECTED_REMOVAL_MS);
};

/** Whether this file's disappearance was the app's own, once: a later one is somebody else's. */
const takeExpectedRemoval = (absolutePath: string): boolean => {
    const resolved = path.resolve(absolutePath);
    const until = expectedRemovals.get(resolved);

    expectedRemovals.delete(resolved);

    return until !== undefined && until >= Date.now();
};

interface PendingChange {
    rootId: string;
    directories: Set<string>;
}

const pending = new Map<string, PendingChange>();
let flushTimer: NodeJS.Timeout | null = null;
/** When the oldest change still waiting was recorded, for `MAX_DELAY_MS`. */
let waitingSince: number | null = null;

const flush = (): void => {
    flushTimer = null;
    waitingSince = null;

    for (const [rootId, change] of pending) {
        if (change.directories.size >= FULL_SCAN_THRESHOLD) {
            console.log(
                `Watcher: ${change.directories.size} directories changed in root ${rootId}; ` +
                    "queueing a full scan"
            );
            enqueue(db, { kind: "scan", payload: { rootId }, priority: 20 });
        } else {
            for (const directory of change.directories) {
                enqueue(db, {
                    kind: "scan",
                    payload: { rootId, subPath: directory },
                    // Ahead of the scheduled sweep: this is the change someone is waiting to
                    // see appear in the grid.
                    priority: 15,
                });
            }
        }
    }

    pending.clear();
};

const scheduleFlush = (): void => {
    if (flushTimer) {
        clearTimeout(flushTimer);
    }

    waitingSince ??= Date.now();
    flushTimer = setTimeout(
        flush,
        Math.max(0, Math.min(QUIET_PERIOD_MS, waitingSince + MAX_DELAY_MS - Date.now()))
    );
};

/** Something in `directory` (relative to its root, posix, "" for the root) changed. */
const recordChange = (rootId: string, directory: string): void => {
    const existing = pending.get(rootId) ?? { rootId, directories: new Set<string>() };
    existing.directories.add(directory);
    pending.set(rootId, existing);

    scheduleFlush();
};

/** ENOSPC from `fs.watch` is the inotify watch limit, not a full disk; worth naming. */
const describeWatchError = (error: unknown): string =>
    (error as NodeJS.ErrnoException | null)?.code === "ENOSPC"
        ? "the system inotify watch limit was reached. Scheduled scanning still applies; to " +
          "watch a library this large, raise fs.inotify.max_user_watches."
        : error instanceof Error
          ? error.message
          : String(error);

const isGone = (error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException | null)?.code;

    return code === "ENOENT" || code === "ENOTDIR" || code === "EPERM";
};

/**
 * Watch one root: one `fs.watch` per directory under it, added and dropped as directories come
 * and go. Returns the function that stops it.
 *
 * Throws only if the root itself cannot be watched; a subdirectory that cannot be is reported
 * and left to the periodic scan.
 */
const watchRoot = async (root: MediaRootRow): Promise<() => void> => {
    const rootDir = root.path;
    const watchers = new Map<string, FSWatcher>();
    /** Names seen per directory since the last look, so a burst is looked at once. */
    const named = new Map<string, Set<string>>();
    let settleTimer: NodeJS.Timeout | null = null;
    let closed = false;

    const relativeOf = (absolute: string): string => {
        const relative = toPosixRelative(path.relative(rootDir, absolute));

        return relative === "." ? "" : relative;
    };

    const unwatchTree = (directory: string): void => {
        for (const [watched, watcher] of watchers) {
            if (watched === directory || watched.startsWith(directory + path.sep)) {
                watcher.close();
                watchers.delete(watched);
            }
        }
    };

    const settle = async (): Promise<void> => {
        settleTimer = null;

        const batch = [...named];
        named.clear();

        for (const [directory, names] of batch) {
            for (const name of names) {
                if (closed) {
                    return;
                }

                const target = path.join(directory, name);
                const relative = relativeOf(target);

                try {
                    const stats = await lstat(target);

                    if (stats.isDirectory()) {
                        // Already watched: what changed is inside it, and its own watch says
                        // so. Windows also reports a subdirectory whose contents changed.
                        if (watchers.has(target) || shouldIgnoreDirectory(relative)) {
                            continue;
                        }

                        // New, or moved in: watch it and what is under it. Symlinks are not
                        // followed, as the walker does not follow them.
                        await watchTree(target, true);
                    } else if (classifyPath(relative).classification === "ignored") {
                        // A NAS thumbnail or a sidecar: not library content, so not worth a scan.
                        continue;
                    }
                } catch (error) {
                    if (!isGone(error)) {
                        continue;
                    }

                    if (watchers.has(target)) {
                        // A directory deleted or moved away takes its watches with it.
                        unwatchTree(target);
                    } else if (
                        classifyPath(relative).classification === "ignored" ||
                        takeExpectedRemoval(target)
                    ) {
                        continue;
                    }
                }

                recordChange(root.id, relativeOf(directory));
            }
        }
    };

    const onEvent = (directory: string, name: string | Buffer | null): void => {
        if (closed) {
            return;
        }

        if (!name) {
            // The platform could not say what changed; the directory itself is the answer.
            recordChange(root.id, relativeOf(directory));
            return;
        }

        const names = named.get(directory) ?? new Set<string>();
        names.add(name.toString());
        named.set(directory, names);

        settleTimer ??= setTimeout(() => void settle(), SETTLE_NAMES_MS);
    };

    /**
     * Watch a directory and every directory under it. `appeared` for one that arrived while
     * watching, whose contents may already be there: the parent's scan (queued by the caller)
     * walks it, so nothing more is recorded here.
     */
    const watchTree = async (directory: string, appeared = false): Promise<void> => {
        if (closed || watchers.has(directory)) {
            return;
        }

        let watcher: FSWatcher;

        try {
            watcher = watch(directory, { persistent: true }, (_event, name) =>
                onEvent(directory, name)
            );
        } catch (error) {
            if (directory === rootDir) {
                throw error;
            }

            if (!isGone(error) || !appeared) {
                console.warn(`Watcher error for ${root.label}: ${describeWatchError(error)}`);
            }

            return;
        }

        watcher.on("error", (error: unknown) => {
            // A watched directory that is deleted can report its own end as an error.
            watcher.close();
            watchers.delete(directory);

            if (!isGone(error)) {
                console.warn(`Watcher error for ${root.label}: ${describeWatchError(error)}`);
            }
        });
        watchers.set(directory, watcher);

        let entries;

        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            const child = path.join(directory, entry.name);

            if (!shouldIgnoreDirectory(relativeOf(child))) {
                await watchTree(child, appeared);
            }
        }
    };

    await watchTree(rootDir);

    return () => {
        closed = true;

        if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = null;
        }

        for (const watcher of watchers.values()) {
            watcher.close();
        }

        watchers.clear();
        named.clear();
    };
};

export interface WatcherHandle {
    close: () => Promise<void>;
}

/**
 * Start watching every enabled root.
 *
 * Failures are reported and swallowed rather than thrown: a watcher that cannot start (an
 * exhausted inotify limit, a filesystem that does not support events) must degrade to
 * scheduled scanning, not stop the worker.
 */
export const startWatchers = async (roots: MediaRootRow[]): Promise<WatcherHandle> => {
    const stops: Array<() => void> = [];

    for (const root of roots) {
        if (!root.enabled) {
            continue;
        }

        try {
            stops.push(await watchRoot(root));
            console.log(`Watching ${root.label} for changes`);
        } catch (error) {
            console.warn(
                `Could not watch ${root.label}, falling back to scheduled scans: ` +
                    describeWatchError(error)
            );
        }
    }

    return {
        close: async () => {
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }

            waitingSince = null;
            expectedRemovals.clear();
            stops.forEach((stop) => stop());
        },
    };
};
