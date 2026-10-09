import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
    ConflictError,
    EMBED_DIMS,
    NotFoundError,
    REPRESENTATIVES_LOG_REL_PATH,
    ValidationError,
    assertSafeRelativePath,
    asksForLook,
    decodeVectorFile,
    dequantize,
    mediaKinds,
    meanDirection,
    normaliseVector,
    parseLookFrame,
    quantizedSimilarity,
    vectorFileRelPath,
    type MediaKind,
    type MediaQuery,
    type VectorFile,
} from "@private-stock/core";
import { encodeLookText, loadConfig } from "@private-stock/core/server";
import { mediaRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { createTtlCache } from "../ttlCache";
import { currentLookIndex, rankLook, type LookRanking } from "./lookIndex";

/**
 * Ordering the library by a look (§5e "Search runs in two passes").
 *
 * In two passes. The first scores every embedded item by its few representative moments, in
 * memory (`lookIndex`). The second reads the best hundred of what the rest of the query allows
 * in full -- every moment kept, not eight -- and orders those by their best one, which is also the
 * moment each is shown matching at. The list is the best of each kind, and is kept as a kept order
 * (`keptOrders`), so paging, the count and the viewer's walk all read it rather than ranking
 * again.
 *
 * **Asynchronous at one point only.** Words become a vector in the text encoder's process, which
 * is an `await`; everything else here, and every reader of a list, is synchronous. So a request
 * asking for a look calls `prepareLook` before anything reads the list, and the kept order is
 * taken from what that left ready -- and refuses, loudly, a look nobody prepared.
 */

/**
 * How many items of each kind a look lists (§5e): videos and photographs are capped apart, so a
 * library of mostly one does not crowd the other out of the list.
 */
export const LOOK_LIMIT_PER_KIND = 120;

/** How many of them are read in full and reordered: the second pass. */
export const RESCORE_COUNT = 100;

/** Ids checked against the rest of the query per statement while filling the list. */
const SLICE = 500;

/** How long the vector for a set of words is kept. Words mean the same thing tomorrow. */
const VECTOR_TTL_MS = 60 * 60_000;

/** Prepared looks kept for the synchronous half; one per look in use. */
const PREPARED_ENTRIES = 32;

const lookKey = (query: Pick<MediaQuery, "lookText" | "like">): string =>
    JSON.stringify([query.lookText ?? null, query.like ?? null]);

const logPath = (dataDir: string): string => path.join(dataDir, REPRESENTATIVES_LOG_REL_PATH);

/** An item's vectors file, or null when it has none: not embedded yet, or nothing to embed. */
const readVectors = (dataDir: string, mediaId: string): VectorFile | null => {
    try {
        return decodeVectorFile(
            readFileSync(path.resolve(dataDir, assertSafeRelativePath(vectorFileRelPath(mediaId))))
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }

        throw error;
    }
};

/**
 * The moment of an item a "more like this" asks about, as a vector.
 *
 * The kept moment nearest the time given, all of its squares together: a vertical frame is two
 * squares, and the person pointed at the frame, not at its top half. Nearest rather than exact
 * because thinning keeps only moments that differ (§5e), and the one on screen was very likely
 * represented by an earlier one it resembled. No time, or a photograph, is the item as a whole.
 */
const momentVector = (file: VectorFile, atMs: number | null): Float32Array => {
    const at = (entry: VectorFile["vectors"][number]): number => entry.atMs ?? 0;
    const nearest =
        atMs === null
            ? null
            : file.vectors.reduce(
                  (best, entry) =>
                      Math.abs(at(entry) - atMs) < Math.abs(best - atMs) ? at(entry) : best,
                  at(file.vectors[0])
              );
    const chosen = file.vectors.filter((entry) => nearest === null || at(entry) === nearest);

    return meanDirection(chosen.map((entry) => normaliseVector(dequantize(entry.vector))));
};

/** Vectors for words, shared by everyone: what the words are is all they depend on. */
const textVectors = createTtlCache<Promise<Float32Array>>(VECTOR_TTL_MS, 64);

const textVector = (text: string): Promise<Float32Array> => {
    const pending = textVectors.get(text, () => encodeLookText(text));

    // A failed encode is not kept: the next search tries again.
    pending.catch(() => textVectors.delete(text));

    return pending;
};

interface PreparedLook {
    vector: Float32Array;
    ranking: LookRanking;
    /** The item a "more like this" started from, left out of its own list. */
    excludeId: string | null;
}

const prepared = new Map<string, PreparedLook>();

/** Rankings by look and index version: a new embedding makes a new ranking. */
const rankings = createTtlCache<LookRanking>(10 * 60_000, 16, {
    weigh: (ranking) => ranking.order.length,
    maxWeight: 500_000,
});

/**
 * Make a query's look ready to be listed: its vector, and every item ranked against it.
 *
 * Call before listing, counting or walking a query that asks for a look; a query without one is
 * left alone. Checks that a "more like this" names an item this viewer can see, so the look
 * cannot be used to ask about one they cannot.
 */
export const prepareLook = async (query: MediaQuery, auth: AuthContext): Promise<void> => {
    if (!asksForLook(query)) {
        return;
    }

    if (query.lookText !== undefined && query.like !== undefined) {
        throw new ValidationError("Ask for a look in words or from a moment, not both.");
    }

    const { dataDir } = loadConfig();
    const frame = query.like === undefined ? null : parseLookFrame(query.like);
    let vector: Float32Array;

    if (frame === null) {
        vector = await textVector(query.lookText as string);
    } else {
        const visible = mediaRepo.listByIds([frame.mediaId], auth.userId, auth.accessibleRootIds);
        const file = visible.length > 0 ? readVectors(dataDir, frame.mediaId) : null;

        if (visible.length === 0) {
            throw new NotFoundError("Media not found");
        }

        // A conflict, not a 404: the item is there, it has not been through the embed stage yet,
        // and the grid says what the server says rather than "moved or removed".
        if (file === null || file.vectors.length === 0 || file.dims !== EMBED_DIMS) {
            throw new ConflictError(
                "That item has not been looked at yet, so there is nothing to compare it with."
            );
        }

        vector = momentVector(file, frame.atMs);
    }

    const index = currentLookIndex(logPath(dataDir));
    const key = lookKey(query);
    const ranking = rankings.get(`${key}|${index.version}`, () => rankLook(index.entries, vector));

    prepared.delete(key);
    prepared.set(key, { vector, ranking, excludeId: frame?.mediaId ?? null });

    // Oldest first: a Map iterates in insertion order, and a reused look was just re-inserted.
    for (const stale of prepared.keys()) {
        if (prepared.size <= PREPARED_ENTRIES) break;

        prepared.delete(stale);
    }
};

/** Rescore one candidate against every moment it kept: its best, and where that was. */
const rescore = (
    dataDir: string,
    mediaId: string,
    vector: Float32Array
): { score: number; atMs: number } | null => {
    const file = readVectors(dataDir, mediaId);

    if (file === null || file.dims !== EMBED_DIMS || file.vectors.length === 0) {
        return null;
    }

    let best = { score: -Infinity, atMs: -1 };

    for (const entry of file.vectors) {
        const score = quantizedSimilarity(vector, entry.vector.values, entry.vector.scale);

        if (score > best.score) {
            best = { score, atMs: entry.atMs ?? -1 };
        }
    }

    return best;
};

export interface LookOrder {
    rowids: number[];
    /** Where each item matched, by rowid; absent for an item matched as a whole. */
    moments: Map<number, number>;
}

/**
 * A look's list, as a kept order: the best `LOOK_LIMIT_PER_KIND` items of each kind the rest of
 * the query allows.
 *
 * Synchronous, for `keptOrders`, and run inside the caller's snapshot. Walks the ranking a slice
 * at a time, asking the database which of each slice the query allows -- one slice for a look
 * over the whole library, more for a narrow one or a kind the library has few of -- then reads the first `RESCORE_COUNT` in full
 * and reorders them. The rest keep their first-pass order behind them: a full read can only raise
 * an item's score, so what is reordered is exactly the part that is looked at first.
 */
export const takeLookOrder = (
    query: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string
): LookOrder => {
    const look = prepared.get(lookKey(query));

    if (look === undefined) {
        // A route that lists a look without preparing it, or more looks prepared at once than are
        // kept. A conflict rather than a guess: answering without the look would be the library.
        throw new ConflictError("That look is not ready yet. Try again.");
    }

    const { ranking, vector, excludeId } = look;
    const found: { rowid: number; id: string; score: number; atMs: number }[] = [];
    // A query for one kind leaves the other with nothing to wait for.
    const room = new Map<MediaKind, number>(
        mediaKinds
            .filter((kind) => query.kind === undefined || query.kind === kind)
            .map((kind) => [kind, LOOK_LIMIT_PER_KIND])
    );
    const full = (): boolean => [...room.values()].every((left) => left === 0);

    for (let start = 0; start < ranking.order.length && !full(); start += SLICE) {
        const positions = ranking.order.subarray(start, start + SLICE);
        const byId = new Map<string, number>();

        for (const position of positions) {
            const id = ranking.entries[position].mediaId;

            if (id !== excludeId) byId.set(id, position);
        }

        const allowed = mediaRepo.matchingIds(
            query,
            auth.userId,
            auth.accessibleRootIds,
            [...byId.keys()],
            overlayUserId
        );

        for (const { rowid, id, kind } of allowed) {
            const left = room.get(kind) ?? 0;

            if (left === 0) continue;

            const position = byId.get(id) as number;

            room.set(kind, left - 1);
            found.push({
                rowid,
                id,
                score: ranking.scores[position],
                atMs: ranking.atMs[position],
            });
        }
    }

    const { dataDir } = loadConfig();
    const head = found.slice(0, RESCORE_COUNT).map((item) => ({
        ...item,
        ...(rescore(dataDir, item.id, vector) ?? {}),
    }));

    head.sort((a, b) => b.score - a.score);

    const listed = [...head, ...found.slice(RESCORE_COUNT)];

    return {
        rowids: listed.map((item) => item.rowid),
        moments: new Map(
            listed.filter((item) => item.atMs >= 0).map((item) => [item.rowid, item.atMs])
        ),
    };
};
