import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

import { EMBED_DIMS, decodeRepresentatives, quantizedSimilarity } from "@private-stock/core";

/**
 * Every embedded item's representatives, in memory, for the first pass of a look (§5e
 * "Searching").
 *
 * Read from `embed/reps.log`, which the worker appends a record to each time it embeds an item:
 * the web process cannot open thirteen thousand vectors files per search, and does not need to —
 * up to eight representative moments an item find the candidates, and only the best hundred are
 * read in full afterwards (`lookService`).
 *
 * **Kept current by reading only what was appended.** The byte offset of the last complete
 * record read is remembered, and each use reads from there to the end. A record the worker is
 * halfway through writing is left for the next read, which starts at it (`decodeRepresentatives`).
 * The last record for an item wins, replacing its entry in place, so a re-embedded item keeps its
 * position and a ranking taken earlier stays valid. A log that is shorter than the offset, or is
 * a different file, has been replaced, and is read again from the start.
 *
 * **Memory.** 512 bytes a representative, packed one item to an array: ~50 MB for the 13k-item
 * production library at up to eight each, ~41 MB as measured. Let go after `IDLE_MS` without a
 * look, because it is page cache the database could be using (§20), and reading it back costs a
 * second or so of disk.
 */

/** How long the index is kept with nobody asking for a look. */
const IDLE_MS = 30 * 60_000;

/**
 * How much of the log is read at once. A first read of the whole log in one buffer would be a
 * second copy of the index alive while the first is built, which glibc keeps once freed (§5e
 * "Memory"); a record is a few KB, so a chunk always holds many.
 */
const CHUNK_BYTES = 8 * 1024 * 1024;

export interface LookEntry {
    mediaId: string;
    /** Every representative's values, end to end, `EMBED_DIMS` apiece. */
    values: Int8Array;
    scales: Float32Array;
    /** Where each representative is in the item, or -1 for a photograph's. */
    atMs: Int32Array;
}

interface LoadedIndex {
    entries: LookEntry[];
    positions: Map<string, number>;
    /** Where the next read of the log starts: just past the last complete record. */
    offset: number;
    /** The log file's identity when it was opened, so a replaced log is noticed. */
    ino: number;
    /** Rises with every change, so a ranking can tell it was taken from an older index. */
    version: number;
}

let index: LoadedIndex | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let versions = 0;

const emptyIndex = (ino: number): LoadedIndex => ({
    entries: [],
    positions: new Map(),
    offset: 0,
    ino,
    version: ++versions,
});

const apply = (loaded: LoadedIndex, bytes: Uint8Array): void => {
    const { records, length } = decodeRepresentatives(bytes);

    for (const record of records) {
        // A record of some other shape is a model this build does not search with.
        if (record.vectors.some((vector) => vector.vector.values.length !== EMBED_DIMS)) {
            continue;
        }

        const values = new Int8Array(record.vectors.length * EMBED_DIMS);

        record.vectors.forEach((vector, i) => values.set(vector.vector.values, i * EMBED_DIMS));

        const entry: LookEntry = {
            mediaId: record.mediaId,
            values,
            scales: Float32Array.from(record.vectors, (vector) => vector.vector.scale),
            atMs: Int32Array.from(record.vectors, (vector) => vector.atMs ?? -1),
        };
        const position = loaded.positions.get(record.mediaId);

        if (position === undefined) {
            loaded.positions.set(record.mediaId, loaded.entries.length);
            loaded.entries.push(entry);
        } else {
            loaded.entries[position] = entry;
        }
    }

    loaded.offset += length;

    if (records.length > 0) {
        loaded.version = ++versions;
    }
};

/** Read whatever has been appended to the log since the last read. */
const catchUp = (logPath: string): LoadedIndex => {
    let fd: number;

    try {
        fd = openSync(logPath, "r");
    } catch {
        // Nothing has been embedded: the stage is off, or has not run yet.
        index = emptyIndex(0);

        return index;
    }

    try {
        const { size, ino } = fstatSync(fd);

        if (index === null || index.ino !== ino || size < index.offset) {
            index = emptyIndex(ino);
        }

        const chunk = new Uint8Array(Math.min(CHUNK_BYTES, size - index.offset));

        while (index.offset < size) {
            const read = readSync(
                fd,
                chunk,
                0,
                Math.min(chunk.length, size - index.offset),
                index.offset
            );
            const before = index.offset;

            apply(index, chunk.subarray(0, read));

            // Nothing whole in a full chunk would be a record larger than a chunk, which the
            // format cannot produce; stop rather than spin, and read the rest next time.
            if (index.offset === before) break;
        }

        return index;
    } finally {
        closeSync(fd);
    }
};

/**
 * The index as the log stands now. Cheap when nothing has changed: one `stat`.
 */
export const currentLookIndex = (logPath: string): LoadedIndex => {
    if (idleTimer) {
        clearTimeout(idleTimer);
    }

    idleTimer = setTimeout(() => {
        index = null;
    }, IDLE_MS);
    idleTimer.unref();

    // The common case, a log nobody has appended to since, without opening it.
    if (index !== null && index.offset > 0) {
        try {
            const { size, ino } = statSync(logPath);

            if (size === index.offset && ino === index.ino) {
                return index;
            }
        } catch {
            // Gone: fall through, and the read below finds nothing.
        }
    }

    return catchUp(logPath);
};

/**
 * Every item in the index scored against a look, best first: the first pass (§5e).
 *
 * An item's score is its best representative's, and that representative's moment is where it
 * matched. Every item rather than a top few hundred, because what the rest of the query allows is
 * not known here: a look narrowed to one performer may have to walk far down the list to fill a
 * page. Positions into `entries`, which the ranking keeps a reference to so a reload of the
 * index cannot change what they point at.
 */
export interface LookRanking {
    entries: LookEntry[];
    /** Positions into `entries`, best match first. */
    order: Uint32Array;
    /** By position: the item's best score, and the moment it came from (-1 for none). */
    scores: Float32Array;
    atMs: Int32Array;
}

export const rankLook = (entries: LookEntry[], query: Float32Array): LookRanking => {
    const scores = new Float32Array(entries.length);
    const atMs = new Int32Array(entries.length);

    entries.forEach((entry, position) => {
        let best = -Infinity;
        let bestAt = -1;

        for (let i = 0; i < entry.scales.length; i += 1) {
            const score = quantizedSimilarity(query, entry.values, entry.scales[i], i * EMBED_DIMS);

            if (score > best) {
                best = score;
                bestAt = entry.atMs[i];
            }
        }

        scores[position] = best;
        atMs[position] = bestAt;
    });

    const order = Uint32Array.from(entries.keys()).sort((a, b) => scores[b] - scores[a]);

    return { entries, order, scores, atMs };
};
