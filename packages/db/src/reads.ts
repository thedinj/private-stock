import * as mediaRepo from "./repos/mediaRepo.js";
import * as tagRepo from "./repos/tagRepo.js";

/**
 * The statements a request may run off the web process's thread (§20 "Reads off the thread").
 *
 * Each is an ordinary repo function, named here so a reader thread can find it by name: a
 * function cannot cross a thread boundary, a string can. Only the reads that showed up in
 * `[slow]` are listed -- the grid's walk and hydration, the kept-order walks, the tiles' tags and
 * the filter panel's counts. Everything else a service reads is cheap enough to stay where it is.
 *
 * Reads only. A reader thread holds a read snapshot and nothing it runs may write; a write here
 * would also be a write on a connection that never sees the web process's transactions.
 */
export const reads = {
    listMedia: mediaRepo.listMedia,
    listMediaIdsPage: mediaRepo.listMediaIdsPage,
    countMedia: mediaRepo.countMedia,
    listByIds: mediaRepo.listByIds,
    orderedRowids: mediaRepo.orderedRowids,
    stillMatching: mediaRepo.stillMatching,
    facetCountsForTags: mediaRepo.facetCountsForTags,
    favoriteTagCount: mediaRepo.favoriteTagCount,
    listFacetValues: tagRepo.listFacetValues,
    tagsForMediaIds: tagRepo.listForMediaIds,
};

export type Reads = typeof reads;
export type ReadName = keyof Reads;

/** One statement a plan asks for, by name. */
export interface ReadRequest {
    name: ReadName;
    args: unknown[];
}

/**
 * A plan waiting on work another plan has in hand, rather than doing it again (`join`).
 */
export interface JoinRequest {
    join: Promise<unknown>;
}

/** What a plan can ask its driver for: a statement, or to wait on another plan's result. */
export type PlanRequest = ReadRequest | JoinRequest;

/**
 * A service's reads, written once and run either here or on a reader thread.
 *
 * A generator that yields each statement it needs and is handed back the rows. Which thread runs
 * the statement is the driver's business: `runNow` calls it on this connection, inside whatever
 * snapshot the caller holds, and `runOffThread` sends it to a reader. Everything between two
 * reads -- caches, authorization, signing URLs -- runs in the caller's process either way, which
 * is what lets a service keep its in-memory state while its statements move.
 */
export type ReadPlan<T> = Generator<PlanRequest, T, unknown>;

/**
 * Asks for one statement: `const rows = yield* read("listMedia", query, ...)`.
 *
 * The one cast in the arrangement lives here. A generator's `yield` expression cannot be typed
 * per call, so the value handed back is asserted to be what the named function returns -- which
 * both drivers guarantee, since each obtains it by calling exactly that function.
 */
export function* read<K extends ReadName>(
    name: K,
    ...args: Parameters<Reads[K]>
): Generator<PlanRequest, ReturnType<Reads[K]>, unknown> {
    return (yield { name, args }) as ReturnType<Reads[K]>;
}

/**
 * Waits for what another plan is already reading: `const shared = yield* join(taking)`.
 *
 * For a result several requests ask for at once -- the grid, its count and the other kind's
 * count all want the same kept order the moment a filter is opened (§20 "One take, however many
 * ask") -- so the first plan reads it and the rest wait for that rather than reading it again.
 *
 * `undefined` means the driver could not wait: `runNow` is synchronous, and a promise cannot be
 * waited on inside a synchronous call, so it answers at once and the plan does the work itself.
 * `runOffThread` waits, without holding a reader while it does. The promise must not reject;
 * one that can fail should settle with `undefined` instead, which reads the same way.
 *
 * **Join before the plan's first statement.** A plan's reader is leased at its first read and
 * held to its end, so a plan that read and then waited would hold a reader the work it waits on
 * may need -- with two readers, two such plans would wait for each other for good.
 */
export function* join<T>(waiting: Promise<T>): Generator<PlanRequest, T | undefined, unknown> {
    return (yield { join: waiting }) as T | undefined;
}

/** Whether a plan's request is a wait on another plan rather than a statement. */
export const isJoin = (request: PlanRequest): request is JoinRequest => "join" in request;

/** Runs one named read on this thread's connection. The reader thread calls it too. */
export const runRead = (request: ReadRequest): unknown =>
    (reads[request.name] as (...args: unknown[]) => unknown)(...request.args);

/**
 * Runs a plan here, synchronously.
 *
 * For callers that must stay synchronous -- inside a snapshot of their own, or inside a cache's
 * compute -- and for every test. Exactly what the code did before plans existed.
 */
export const runNow = <T>(plan: ReadPlan<T>): T => {
    let step = plan.next();

    while (!step.done) {
        let value: unknown;

        if (isJoin(step.value)) {
            // Nothing can be waited on here; the plan does the work itself (`join`).
            step = plan.next(undefined);
            continue;
        }

        try {
            value = runRead(step.value);
        } catch (error) {
            // Into the plan, as `runOffThread` does, so a plan behaves the same under either.
            step = plan.throw(error);
            continue;
        }

        step = plan.next(value);
    }

    return step.value;
};
