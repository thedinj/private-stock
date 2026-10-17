import { access, constants, readdir } from "node:fs/promises";
import * as path from "node:path";

import {
    ConflictError,
    NotFoundError,
    ValidationError,
    type LibrariesResponse,
    type LibraryStats,
    type LibrarySummary,
} from "@private-stock/core";
import { inspectLibraryPath, loadConfig } from "@private-stock/core/server";
import { jobRepo, mediaRootRepo, scanRepo } from "@private-stock/db";

import { forgetAuth } from "../auth/authCache";
import type { AuthContext } from "../auth/withAuth";
import { countMedia, listMedia } from "./mediaService";
import { forgetKeptOrders } from "./keptOrders";
import { clearProcessingCache } from "./pipelineService";
import { playbackCheckEnabled } from "./settingsService";

/**
 * Libraries (§12b).
 *
 * A library is a directory an administrator added, plus the settings they chose for it. Two
 * rules shape everything here:
 *
 * - **Nothing creates a library on its own.** Directories under the media folder are offered
 *   as suggestions when adding one, and that is all they are. When rows appeared by
 *   themselves there were two kinds of library — one an admin could repoint, and one the next
 *   scan would put back — and "edit this library's path" meant different things for each.
 * - **Nothing removes one because its directory went missing.** An unreachable path is a
 *   misconfiguration or an offline share. Both are fixed by repointing, which is only
 *   possible if the row is still there.
 */

/**
 * Whether this platform treats two spellings of a path as the same directory.
 *
 * Windows and macOS do by default. Comparing raw strings there would let two spellings of one
 * directory both be added as libraries — the same content catalogued twice, every count
 * doubled, and every file reported as a duplicate of itself.
 */
const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

/** The form paths are compared in. Never stored: the admin's own spelling is what is kept. */
const comparable = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);

const withSep = (value: string): string => (value.endsWith(path.sep) ? value : value + path.sep);

/**
 * Why a path cannot be used, or null if it can.
 *
 * Returns rather than throws because two callers need the same answer for different reasons:
 * the dialog asks on every keystroke and wants a sentence to show, and the write asks once
 * and wants to refuse. Having them share this is what stops the form accepting something the
 * server then rejects, which is the failure mode a live check is supposed to remove.
 */
export const checkLibraryPath = async (
    candidate: string,
    excludeId?: string
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
    const inspected = await inspectLibraryPath(candidate);

    if (!inspected.ok) {
        return inspected;
    }

    /**
     * The app's own directory is never a library, in either direction.
     *
     * It holds the database, the signing key, the trash and every capture. As a library its
     * artifacts would be catalogued as media, and made deletable it would put all of that one
     * trash action away from gone — the trash itself included. "Everything the app produces
     * goes to `dataDir`" only means something if `dataDir` is not also somewhere it reads from.
     */
    const dataDir = comparable(path.resolve(loadConfig().dataDir));
    const requested = comparable(inspected.path);

    if (
        requested === dataDir ||
        requested.startsWith(withSep(dataDir)) ||
        dataDir.startsWith(withSep(requested))
    ) {
        return {
            ok: false,
            reason: "That directory holds private-stock's own data, so it cannot be a library",
        };
    }

    /**
     * Nesting is refused in both directions.
     *
     * One file inside two libraries is catalogued twice, counted twice, and offered as a
     * duplicate of itself — and the two rows can disagree about whether deletion is allowed.
     */
    for (const existing of mediaRootRepo.listRoots()) {
        if (existing.id === excludeId) {
            continue;
        }

        const candidate = comparable(inspected.path);
        const other = comparable(existing.path);

        if (candidate === other) {
            return { ok: false, reason: `"${existing.label}" already uses that directory` };
        }

        if (candidate.startsWith(withSep(other))) {
            return { ok: false, reason: `That directory is already inside "${existing.label}"` };
        }

        if (other.startsWith(withSep(candidate))) {
            return { ok: false, reason: `That directory already contains "${existing.label}"` };
        }
    }

    return inspected;
};

/**
 * The same check, as the thing a write does.
 *
 * Overlap is a conflict and a bad path is a validation failure, so the two map to different
 * statuses — but the wording is the check's, which is what keeps the dialog's live message
 * and the eventual error identical.
 */
const validatePath = async (candidate: string, excludeId?: string): Promise<string> => {
    const checked = await checkLibraryPath(candidate, excludeId);

    if (!checked.ok) {
        throw checked.reason.includes("already")
            ? new ConflictError(checked.reason)
            : new ValidationError(checked.reason);
    }

    return checked.path;
};

/**
 * Whether files in this directory could actually be deleted.
 *
 * The `writable` flag is the app's permission; this is the filesystem's. In the container a
 * library is read-only unless docker-compose mounts its folder `:rw`, and no setting inside the
 * app can change a mount — so the flag is refused where this says no, rather than accepted and
 * left to fail file by file in a trash job. `access` reports a read-only mount as `EROFS` and a
 * directory the app's user cannot write as `EACCES`; both mean the same thing here.
 */
export const isMountWritable = async (directory: string): Promise<boolean> => {
    try {
        await access(directory, constants.W_OK);

        return true;
    } catch {
        return false;
    }
};

const assertMountWritable = async (directory: string): Promise<void> => {
    if (!(await isMountWritable(directory))) {
        throw new ValidationError(
            `${directory} is mounted read-only, so nothing in it can be deleted. Add a :rw ` +
                "mount for it to docker-compose and recreate the container."
        );
    }
};

export const addLibrary = async (candidate: string, label?: string, writable = false) => {
    const resolved = await validatePath(candidate);

    if (writable) {
        await assertMountWritable(resolved);
    }

    clearLibraryCaches();

    // The directory's own name is a better default than an empty field, and an admin who
    // wants something else can rename it afterwards like any other setting.
    const root = mediaRootRepo.create(
        resolved,
        label?.trim() || path.basename(resolved) || resolved
    );

    if (writable) {
        mediaRootRepo.setWritable(root.id, true);
    }

    // Every signed-in user's accessible roots just grew, and they are cached (§20).
    forgetAuth();

    return mediaRootRepo.findById(root.id)!;
};

/**
 * Allows or forbids deletion from a library (§18.1).
 *
 * Switching it off is always allowed. Switching it on is refused unless the directory is
 * really writable, because a flag the mount contradicts puts a delete button in front of
 * everyone with the `delete` scope that cannot work.
 */
export const setLibraryWritable = async (id: string, writable: boolean): Promise<void> => {
    const root = mediaRootRepo.findById(id);

    if (!root) {
        throw new NotFoundError("Library not found");
    }

    if (writable) {
        await assertMountWritable(root.path);
    }

    mediaRootRepo.setWritable(id, writable);
};

/**
 * Points a library somewhere else.
 *
 * The reason the path is a column. File paths are stored relative to their library, so a move
 * that keeps the internal structure needs nothing but this: tags, ratings, watch state,
 * duplicate groups and processing history are all attached to the library and survive
 * untouched. The next scan reconciles whatever did change.
 */
export const repointLibrary = async (id: string, candidate: string) => {
    if (!mediaRootRepo.findById(id)) {
        throw new NotFoundError("Library not found");
    }

    const resolved = await validatePath(candidate, id);

    mediaRootRepo.setPath(id, resolved);

    /**
     * Everything in the library is hidden until a scan confirms it.
     *
     * Repointing says nothing about whether the files are at the new path, and an item shown
     * from a directory nobody has looked at can be played, transcoded or deleted against
     * whatever happens to occupy that relative path. Hiding is the honest position, and the
     * scan queued below is what ends it — usually in seconds.
     */
    mediaRootRepo.markUnverified(id);

    // Queued work resolves its path at run time, so anything outstanding would read from the
    // new directory and write that file's metadata onto the old item.
    jobRepo.cancelPendingForRoot(id);
    jobRepo.enqueueRootScan(id);
    clearLibraryCaches();

    return mediaRootRepo.findById(id)!;
};

/**
 * Forgets a library and everything catalogued from it.
 *
 * Content in the media directory is untouched — this discards what the app remembered, not the
 * files it catalogued — but the tags and ratings go with it, so the UI asks first. It exists
 * because a mistyped library would otherwise be permanent.
 *
 * The rows go here and the files `/data` holds for them go in a job. Removing thousands of
 * covers, previews and sprite sheets is not a request handler's work, and the list cannot
 * travel in a job payload — a 200k library's would not fit. The sweep finds them by looking
 * for what nothing references, which also catches litter from every other cause.
 */
export const removeLibrary = (id: string): void => {
    if (!mediaRootRepo.findById(id)) {
        throw new NotFoundError("Library not found");
    }

    mediaRootRepo.remove(id);
    clearLibraryCaches();
    forgetAuth();
    jobRepo.enqueueKind("orphanSweep", 60);
};

/**
 * Directories under the media folder that are not libraries yet.
 *
 * Convenience only. On a NAS every library arrives through a bind mount into that folder, so
 * this turns the common case into a click rather than a typed absolute path — without making
 * anything a library until someone says so.
 */
export const listCandidates = async (): Promise<string[]> => {
    const config = loadConfig();

    let entries;
    try {
        entries = await readdir(config.mediaDir, { withFileTypes: true });
    } catch {
        // Not an error: the media folder is a convenience, and an install whose libraries are
        // all absolute paths never needs it to exist.
        return [];
    }

    const known = new Set(mediaRootRepo.listRoots().map((root) => root.path));

    return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => path.resolve(config.mediaDir, entry.name))
        .filter((candidate) => !known.has(candidate))
        .sort();
};

/**
 * Two summaries of the library, split by how often they change and what they cost (§14, §20).
 *
 * They were one. `/api/library/stats` answered the item counts, the queue depth, the scanning
 * flag and the root counts together, and the shell polled it every ten seconds. Measured on the
 * NAS with the disk saturated, the counts alone were 466 pages — one index entry per listable
 * item plus a `UserMedia` probe each, 2.1 s cold — and the queue summary another ~670, for a
 * badge that had already been removed. `better-sqlite3` is synchronous, so every one of those
 * seconds was the whole web process stopped, on every poll.
 *
 * - **`libraryStats`** is what the shell polls: whether a scan is running, and the root counts an
 *   empty grid uses to say *why* it is empty. Two statements over tables with a handful of rows,
 *   the same for every viewer.
 * - **`librarySummaries`** is the expensive half: each library this viewer can see with its
 *   count and a cover, and the total the nav shows beside "Library". It changes only when items
 *   arrive, leave, or are hidden, so it is cached per viewer, thrown away by the actions in this
 *   process that change it, and re-asked by the browser when the change feed says items came or
 *   went (§13b) — on no timer of its own beyond `useLibraries`' slow one.
 */

/**
 * How long the cheap half is reused. It is two tiny statements, so this only stops several tabs
 * and viewers asking in the same moment from each paying for them.
 */
const STATS_TTL_MS = 3_000;

let statsCache: { at: number; stats: LibraryStats } | null = null;

/**
 * How long a viewer's counts are reused.
 *
 * A minute, matching `useLibraries`' interval: a polling tab finds at most one fresh answer per
 * interval, and every other ask in between — other tabs, the change feed's refetches during a
 * scan — is free. Only changes made by the worker wait for it; everything this process does
 * that changes a count calls `clearLibraryCaches()`.
 */
const SUMMARIES_TTL_MS = 60_000;

/**
 * One entry per viewer, and a bound so a long-lived process cannot grow one per account that
 * ever signed in. Well past any plausible number of simultaneous viewers here.
 */
const SUMMARIES_CACHE_MAX = 64;

const summariesCache = new Map<string, { at: number; summaries: LibrariesResponse }>();

/**
 * Throws both cached summaries away.
 *
 * Called by everything in this process that changes what they say: adding, moving, enabling or
 * forgetting a library, and trashing, restoring or hiding an item. Those are the moments somebody
 * is watching the number, and a count that stays put reads as the action not having happened
 * (the same failure `invalidateLibraries` exists for on the client).
 */
export const clearLibraryCaches = (): void => {
    statsCache = null;
    summariesCache.clear();
    // Every one of those changes the processing totals too: a library's items join or leave
    // the denominator, a trashed item leaves it, a restored one returns.
    clearProcessingCache();
    // And which items any kept list order holds (§20): a library's items joining or leaving
    // every list at once is not something a slice-by-slice check should be left to find.
    forgetKeptOrders();
};

/**
 * The cheap, global half: scanning, and the root counts.
 *
 * The root counts are deliberately *not* filtered by access. They exist so an empty grid can say
 * why it is empty — "you have three libraries and none of them is enabled" — and answering that
 * from the roots this viewer can reach would report zero of zero and explain nothing at all.
 * That is also what makes this the same answer for everyone, and so one cache entry.
 */
export const libraryStats = (): LibraryStats => {
    const now = Date.now();

    if (statsCache && now - statsCache.at < STATS_TTL_MS) {
        return statsCache.stats;
    }

    const roots = mediaRootRepo.listRoots();
    const stats: LibraryStats = {
        scanning: scanRepo.isAnyRunning(),
        rootsTotal: roots.length,
        rootsEnabled: roots.filter((root) => root.enabled === 1).length,
        everScanned: roots.some((root) => root.lastScanAt !== null),
        playbackCheck: playbackCheckEnabled(),
    };

    statsCache = { at: now, stats };

    return stats;
};

const summariesKey = (auth: AuthContext): string =>
    `${auth.userId}|${[...auth.accessibleRootIds].sort().join(",")}`;

/**
 * The libraries this viewer can see, each with its size and a face (§14).
 *
 * The counts are the viewer's, not the database's. They sit beside a grid the viewer can scroll,
 * so anything they include that the grid excludes reads as items gone missing — which is why they
 * are asked through `mediaService`, the one place the access filter and the hidden-item filter
 * are applied, rather than with SQL of their own.
 *
 * A query per root, deliberately. Roots are a handful — directories an administrator typed in,
 * not user data — and both queries ride the partial index that leads with `listRootId`. A single
 * grouped query would be one round trip and would have to reimplement the access filter.
 *
 * Keyed by viewer *and* reach, because both are part of the answer: the same person with a
 * library newly denied must not be handed a count that includes it.
 */
export const librarySummaries = (auth: AuthContext): LibrariesResponse => {
    const key = summariesKey(auth);
    const cached = summariesCache.get(key);
    const now = Date.now();

    if (cached && now - cached.at < SUMMARIES_TTL_MS) {
        return cached.summaries;
    }

    const visible = mediaRootRepo
        .listRoots()
        .filter((root) => root.enabled === 1 && auth.accessibleRootIds.includes(root.id));

    const libraries: LibrarySummary[] = visible.map((root) => {
        const { total } = countMedia({ rootId: root.id, limit: 1, page: 0, sort: "addedAt" }, auth);

        // Newest first, so a library's face is whatever arrived in it most recently rather than
        // whichever row the database happened to return.
        const newest = listMedia(
            { rootId: root.id, limit: 1, page: 0, sort: "addedAt", direction: "desc" },
            auth
        );

        return { id: root.id, label: root.label, items: total, cover: newest.items[0] ?? null };
    });

    const summaries: LibrariesResponse = {
        libraries,
        total: libraries.reduce((sum, library) => sum + library.items, 0),
    };

    // Re-inserting moves the key to the end, so insertion order stays age order and the first
    // key is the oldest. Nothing subtler is warranted for a bound nobody is expected to reach.
    summariesCache.delete(key);

    if (summariesCache.size >= SUMMARIES_CACHE_MAX) {
        const oldest = summariesCache.keys().next();

        if (!oldest.done) {
            summariesCache.delete(oldest.value);
        }
    }

    summariesCache.set(key, { at: now, summaries });

    return summaries;
};

/** Whether each library's directory can be read right now, for the admin list. */
export const availability = async (): Promise<Map<string, boolean>> => {
    const roots = mediaRootRepo.listRoots();
    const checked = await Promise.all(
        roots.map(async (root) => [root.id, (await inspectLibraryPath(root.path)).ok] as const)
    );

    return new Map(checked);
};

export interface BrowseEntry {
    name: string;
    path: string;
}

export interface BrowseResult {
    /** Null at the top, where the entries are starting points rather than a directory. */
    path: string | null;
    parent: string | null;
    entries: BrowseEntry[];
}

/**
 * Where browsing starts.
 *
 * The media folder first, because on a NAS that is where every library already is. Then the
 * filesystem roots, because on a dev machine the content is on another drive entirely —
 * which is the case that made this model necessary in the first place.
 */
const startingPoints = async (): Promise<BrowseEntry[]> => {
    const config = loadConfig();
    const entries: BrowseEntry[] = [];

    const mediaDir = path.resolve(config.mediaDir);

    if ((await inspectLibraryPath(mediaDir)).ok) {
        entries.push({ name: mediaDir, path: mediaDir });
    }

    if (process.platform === "win32") {
        // Probed rather than asked: enumerating volumes needs a native call, and 26 stats
        // cost nothing next to a dialog someone is about to read.
        for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
            const drive = `${letter}:\\`;

            if ((await inspectLibraryPath(drive)).ok) {
                entries.push({ name: drive, path: drive });
            }
        }
    } else if (entries.every((entry) => entry.path !== path.sep)) {
        entries.push({ name: path.sep, path: path.sep });
    }

    return entries;
};

/**
 * Directories inside a path, for picking one without typing it exactly.
 *
 * **Directories only, never files.** An admin can already type any path and learn from the
 * error whether it exists, so this does not grant reach it did not have — but listing file
 * names would, and there is no reason to.
 *
 * A Windows junction reports as a symbolic link rather than a directory, so a plain
 * `isDirectory()` filter would hide exactly the directories someone linked deliberately. The
 * `stat` settles it, and following a link is the right answer here: the admin is choosing
 * where to point a library, and the link is the path they mean.
 */
export const browseDirectories = async (target?: string): Promise<BrowseResult> => {
    if (!target) {
        return { path: null, parent: null, entries: await startingPoints() };
    }

    const inspected = await inspectLibraryPath(target);

    if (!inspected.ok) {
        throw new ValidationError(inspected.reason);
    }

    const here = inspected.path;

    let dirents;
    try {
        dirents = await readdir(here, { withFileTypes: true });
    } catch {
        throw new ValidationError("That directory cannot be listed");
    }

    const entries: BrowseEntry[] = [];

    for (const dirent of dirents) {
        if (!dirent.isDirectory() && !dirent.isSymbolicLink()) {
            continue;
        }

        const child = path.join(here, dirent.name);

        if (dirent.isSymbolicLink() && !(await inspectLibraryPath(child)).ok) {
            // A link to a file, or one whose target is gone. Not a directory to descend into.
            continue;
        }

        entries.push({ name: dirent.name, path: child });
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    const parent = path.dirname(here);

    return { path: here, parent: parent === here ? null : parent, entries };
};
