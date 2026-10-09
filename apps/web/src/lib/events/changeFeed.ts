import { changeLogRepo, type ChangeRow } from "@private-stock/db";

/**
 * The change feed poller (§13b).
 *
 * **One poller for the whole process, not one per client.** A single
 * `SELECT ... WHERE id > :cursor` per second serves every connected browser, so cost is flat
 * in viewer count. It is still polling underneath, but it polls a tiny indexed table
 * in-process rather than making each browser poll the library.
 *
 * Lives here rather than in the route because a route module is instantiated per request;
 * the poller has to outlive them and be shared.
 */

/** How often the feed is read. Fast enough to feel immediate, slow enough to be free. */
const POLL_INTERVAL_MS = 1_000;

/**
 * Rows read per tick.
 *
 * A scan of 200k files can produce far more than this. When a tick is full the subscriber is
 * told the feed was truncated rather than being sent the rows — catching a client up one row
 * at a time is both slower and less useful than telling it to refetch.
 */
const MAX_ROWS_PER_TICK = 500;

export type FeedBatch =
    | { kind: "changes"; cursor: number; rows: ChangeRow[] }
    /** Too much happened to describe individually; the client should refetch. */
    | { kind: "truncated"; cursor: number };

export type Subscriber = (batch: FeedBatch) => void;

interface Registration {
    subscriber: Subscriber;
    /** Root ids this connection may hear about; a change elsewhere is invisible to it. */
    rootIds: Set<string>;
}

const globalForFeed = globalThis as unknown as {
    privateStockFeed:
        | {
              registrations: Set<Registration>;
              timer: NodeJS.Timeout | null;
              cursor: number;
          }
        | undefined;
};

/**
 * Cached off `globalThis` so Next's hot reload does not leave a poller per edit running.
 *
 * The same trick the database handle uses — and for the same reason, magnified: a leaked
 * interval keeps querying forever with nothing reading the results.
 */
const state = (globalForFeed.privateStockFeed ??= {
    registrations: new Set<Registration>(),
    timer: null,
    cursor: 0,
});

/**
 * Filter a batch to what one connection is allowed to know about.
 *
 * `rootId` on each row is matched against that user's `LibraryAccess`, so the feed never
 * reveals the existence of media in a root they cannot see (§13b). Rows with no root — a job
 * or a scan finishing — carry no library information and pass through.
 */
const visibleTo = (rows: ChangeRow[], rootIds: Set<string>): ChangeRow[] =>
    rows.filter((row) => row.rootId === null || rootIds.has(row.rootId));

const tick = (): void => {
    if (state.registrations.size === 0) {
        return;
    }

    let rows: ChangeRow[];

    try {
        rows = changeLogRepo.readSince(state.cursor, MAX_ROWS_PER_TICK);
    } catch (error) {
        // A locked or briefly unavailable database must not kill the poller; the next tick
        // retries from the same cursor.
        console.error("Change feed poll failed:", error);
        return;
    }

    if (rows.length === 0) {
        return;
    }

    state.cursor = rows[rows.length - 1].id;
    const truncated = rows.length >= MAX_ROWS_PER_TICK;

    for (const registration of state.registrations) {
        try {
            registration.subscriber(
                truncated
                    ? { kind: "truncated", cursor: state.cursor }
                    : {
                          kind: "changes",
                          cursor: state.cursor,
                          rows: visibleTo(rows, registration.rootIds),
                      }
            );
        } catch (error) {
            // One broken connection must not stop the others being served.
            console.error("Change feed subscriber failed:", error);
        }
    }
};

/**
 * Start listening to the feed.
 *
 * `from` is the client's `Last-Event-ID` when it is reconnecting, and the current head when
 * it is not: a browser that has just loaded the grid already has current data, and replaying
 * an hour of scan history into it would be a burst of animations describing changes it can
 * already see.
 */
export const subscribe = (
    subscriber: Subscriber,
    rootIds: string[],
    from?: number
): (() => void) => {
    const registration: Registration = { subscriber, rootIds: new Set(rootIds) };

    // The shared cursor moves to the earliest point any connection needs, so a reconnecting
    // client is caught up without every other client re-receiving what it already has —
    // `visibleTo` and the client's own id comparison handle the overlap.
    const head = changeLogRepo.latestId();
    state.cursor = from !== undefined ? Math.min(state.cursor || head, from) : state.cursor || head;

    state.registrations.add(registration);

    state.timer ??= setInterval(tick, POLL_INTERVAL_MS);
    // Node must be free to exit with only this timer outstanding.
    state.timer.unref?.();

    return () => {
        state.registrations.delete(registration);

        if (state.registrations.size === 0 && state.timer) {
            clearInterval(state.timer);
            state.timer = null;
        }
    };
};
