/**
 * A small in-memory cache with a lifetime per entry and a bound on how many it keeps.
 *
 * For answers that cost a walk of the library and are allowed to be a few minutes old: the
 * home page's shuffled samples, a saved view's card face (§6, §14c) and a shuffle's whole order
 * (§20). Per process, so the web server holds one copy and a restart empties it, which is all
 * any of them needs.
 *
 * Insertion order is the eviction order -- a `Map` iterates in it, and a recomputed entry is
 * re-inserted at the end -- so the oldest entry goes first once the bound is reached, and an
 * expired one goes whenever a write passes it.
 *
 * `weigh` and `maxWeight` bound what the entries hold as well as how many there are, for values
 * whose size depends on the library. A value heavier than the whole budget is returned and not
 * kept: storing it would evict everything else and then itself.
 */
export interface TtlCacheBounds<T> {
    weigh?: (value: T) => number;
    maxWeight?: number;
}

export const createTtlCache = <T>(
    ttlMs: number,
    maxEntries: number,
    { weigh = () => 0, maxWeight = Infinity }: TtlCacheBounds<T> = {}
) => {
    const entries = new Map<string, { value: T; expiresAt: number; weight: number }>();
    let totalWeight = 0;

    const remove = (key: string): void => {
        const entry = entries.get(key);

        if (entry) {
            totalWeight -= entry.weight;
            entries.delete(key);
        }
    };

    return {
        /** The cached value for `key`, or `compute()`'s answer, kept for `ttlMs`. */
        get: (key: string, compute: () => T, now = Date.now()): T => {
            const cached = entries.get(key);

            if (cached && cached.expiresAt > now) {
                return cached.value;
            }

            const value = compute();
            const weight = weigh(value);

            remove(key);

            if (weight > maxWeight) {
                return value;
            }

            entries.set(key, { value, expiresAt: now + ttlMs, weight });
            totalWeight += weight;

            for (const [stale, entry] of entries) {
                if (
                    entries.size <= maxEntries &&
                    totalWeight <= maxWeight &&
                    entry.expiresAt > now
                ) {
                    break;
                }

                remove(stale);
            }

            return value;
        },
        /** Forgets one entry, so the next `get` computes it again. */
        delete: remove,
        /** Forgets everything, for a change that makes every entry wrong at once. */
        clear: (): void => {
            entries.clear();
            totalWeight = 0;
        },
    };
};
