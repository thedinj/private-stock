/**
 * A shuffled library that can still be paged (§20).
 *
 * Shuffling by sorting is the obvious approach and the one that does not scale: ordering by
 * a per-row hash has no index to walk, so every page sorts the whole library, and paging by
 * OFFSET then walks and discards everything before it. The first version of the grid did
 * exactly this, and at 200k items a shuffled page cost six seconds and repeated rows across
 * page boundaries.
 *
 * Instead, the shuffle is *computed*. With a prime `p` and any `a` that is not a multiple of
 * it, the map
 *
 *     i -> (a * i + b) mod p
 *
 * visits every residue in 0..p-1 exactly once before repeating, because `a` has a
 * multiplicative inverse modulo a prime. That makes it a permutation — so the k-th item of
 * the shuffle is arithmetic rather than a sort, any page can be jumped to directly, and no
 * item can appear on two pages.
 *
 * The trick is standard in music players, which need exactly this property: shuffle a
 * playlist too large to hold in memory, allow skipping around it, and never play a track
 * twice before the end.
 */

/**
 * Slots are matched against SQLite rowids, which are dense-ish and start at 1.
 *
 * "Dense-ish" is the important qualifier: deleting rows leaves holes, and a hole is simply a
 * slot whose lookup finds nothing. Callers over-fetch rather than trying to compact the
 * space, because compacting would renumber rows and change everyone's shuffle.
 */
export interface ShuffleParams {
    /** Prime strictly greater than the highest rowid, so every row has a slot. */
    prime: number;
    /** Multiplier. Never a multiple of `prime`, or the map collapses to a constant. */
    a: number;
    /** Offset. Rotates the whole sequence. */
    b: number;
}

/**
 * The smallest prime greater than `n`.
 *
 * Trial division, which is more than fast enough: this runs once per query on a number the
 * size of a library, and the gap to the next prime is tiny at this magnitude.
 */
export const primeAbove = (n: number): number => {
    const isPrime = (value: number): boolean => {
        if (value < 2) return false;
        if (value % 2 === 0) return value === 2;

        for (let divisor = 3; divisor * divisor <= value; divisor += 2) {
            if (value % divisor === 0) return false;
        }

        return true;
    };

    let candidate = Math.max(2, Math.floor(n) + 1);

    while (!isPrime(candidate)) {
        candidate += 1;
    }

    return candidate;
};

/**
 * Turns a seed into a permutation.
 *
 * `a` is forced into 1..prime-1 so it can never be a multiple of the prime — at `a = 0` the
 * map sends every index to the same slot, which would render one item over and over and look
 * like the library had collapsed to a single row.
 */
export const shuffleParams = (seed: number, maxRowid: number): ShuffleParams => {
    const prime = primeAbove(Math.max(1, maxRowid));

    // Mixed so that nearby seeds give unrelated orderings rather than near-identical ones
    // shifted by a row -- consecutive seeds are exactly what a "reshuffle" button produces.
    const mixed = Math.abs(Math.floor(seed) * 2_654_435_761) % Number.MAX_SAFE_INTEGER;

    return {
        prime,
        a: (mixed % (prime - 1)) + 1,
        b: Math.floor(mixed / prime) % prime,
    };
};

/**
 * 2^31 − 1, a Mersenne prime: the range every rowid shuffle is taken over.
 *
 * Fixed rather than sized to the library, because sized to the library it moved. The prime was
 * the smallest one above `max(rowid)`, primes are a few apart at this magnitude, and so nearly
 * any scan that added items picked a new prime -- and with it a completely different order for
 * the *same* seed. Leaving a shuffle and coming back after the worker had found ten new files
 * showed a different library under an address that had not changed.
 *
 * With the range fixed, a seed is one order forever, and a new item takes its slot without
 * disturbing anyone else's. Sorting by the expression costs the same whatever the prime is.
 *
 * Only for callers that *sort* by `(a * rowid + b) % p` -- the library and the tag strips.
 * Anything that walks the permutation slot by slot (`shufflePageSlots`, playlists) needs a
 * prime close to its own size, or it walks two billion empty slots.
 *
 * The bound is SQLite's: `a * rowid` must stay inside a 64-bit integer, or SQLite silently
 * switches to floating point and the order stops being a permutation. Both factors are below
 * 2^31, so the product is below 2^62.
 */
const ROWID_SHUFFLE_PRIME = 2_147_483_647;

/** A seed's permutation of rowids, the same however large the library grows. */
export const rowidShuffleParams = (seed: number): ShuffleParams =>
    shuffleParams(seed, ROWID_SHUFFLE_PRIME - 1);

/**
 * The slot at position `index` in the shuffled order.
 *
 * BigInt, deliberately. Both `a` and `index` approach the prime, so their product approaches
 * p² — past 2^53 for any library over about 94 million, and past it far sooner once the
 * multiplier is large. In double arithmetic the result silently loses low bits, the map
 * stops being a bijection, and the symptom is duplicated and missing items scattered through
 * the shuffle rather than an error.
 */
export const shuffleSlot = (index: number, params: ShuffleParams): number =>
    Number((BigInt(params.a) * BigInt(index) + BigInt(params.b)) % BigInt(params.prime));

/**
 * Slots for one page of the shuffle, in order.
 *
 * Each page owns a fixed, non-overlapping window of the permutation: page `n` is indices
 * `n * pageSize` up to `(n + 1) * pageSize`. That window is what guarantees the two
 * properties the whole design exists for -- no item on two pages, and no item on none.
 *
 * An earlier version over-fetched, taking extra slots to keep every page exactly full. It
 * looked tidier and was wrong: filling page `n` meant reaching into indices that page `n+1`
 * would also start from, so the pages overlapped and rows repeated across boundaries. That
 * is precisely the bug the OFFSET shuffle had, reintroduced by trying to hide the symptom of
 * a different one.
 *
 * So pages can come back short. Slots are dropped for two reasons: the prime overshoots the
 * highest rowid by a few, and deleted rows leave holes. Both are small on a real library,
 * and a page of 57 is a far better failure than a page that silently repeats.
 *
 * Returns slots rather than rows: the caller does one indexed lookup by rowid, which is the
 * point -- no scan, no sort, no offset.
 */
export const shufflePageSlots = (
    page: number,
    pageSize: number,
    maxRowid: number,
    params: ShuffleParams
): number[] => {
    const slots: number[] = [];
    const start = page * pageSize;

    for (let offset = 0; offset < pageSize; offset += 1) {
        const index = start + offset;

        // Past the end of the permutation there is nothing left to visit; wrapping would
        // re-show the beginning of the shuffle as though it were new.
        if (index >= params.prime) {
            break;
        }

        const slot = shuffleSlot(index, params);

        if (slot >= 1 && slot <= maxRowid) {
            slots.push(slot);
        }
    }

    return slots;
};

/**
 * Whether a shuffled page can be the last one.
 *
 * Because slots are skipped, a page can come back short without the shuffle being finished —
 * so "fewer rows than asked for" is not a reliable end marker, and treating it as one would
 * truncate the library at a random point. The permutation's length is the real boundary.
 *
 * The test is on the page's *first* index, not its last. Asking whether the page ends past
 * the permutation stops one page early whenever the prime is not a multiple of the page size,
 * silently orphaning the final few slots — a handful of items that exist in the library and
 * appear on no page of the shuffle.
 */
export const shuffleExhausted = (page: number, pageSize: number, params: ShuffleParams): boolean =>
    page * pageSize >= params.prime;
