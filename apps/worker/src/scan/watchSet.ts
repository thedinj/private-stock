/**
 * Whether the set of libraries being watched still matches the ones configured (§7).
 *
 * Pure, and separate from the watcher itself, because the decision it supports is the one
 * that was wrong: watching used to be rebuilt on the periodic-scan timer, so a library added
 * from the admin page went unwatched for up to a day and files dropped into it did not appear
 * until somebody scanned by hand. The fix is a short poll, and a short poll is only affordable
 * if "has anything changed?" is cheap and provably right.
 *
 * Tearing watchers down and starting them again is not free — starting re-walks every watched
 * directory to put a watch on it — so the comparison is what keeps a timer from putting a
 * recurring stat storm over the whole library.
 */

export interface WatchableRoot {
    id: string;
    path: string;
    enabled: 1 | null;
}

/**
 * A comparable description of what should be watched.
 *
 * All three fields matter, and each for a different reason. The id alone is not enough: a
 * library that has been repointed is a different directory to watch under the same id. The
 * path alone is not enough either, because two rows can name the same directory. And a
 * disabled library must stop being watched while its row stays exactly where it was.
 *
 * Sorted, so that the same set arriving in a different order — which it will, since the query
 * orders by something unrelated — does not read as a change and rebuild every watcher.
 */
export const watchSignature = (roots: WatchableRoot[]): string =>
    roots
        .map((root) => `${root.id}:${root.path}:${root.enabled ? 1 : 0}`)
        .sort()
        .join("|");
