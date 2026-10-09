/**
 * The browser end of the live update stream (§13b).
 *
 * Two problems to solve beyond "open an EventSource".
 *
 * **HTTP/1.1 allows only about six connections per origin**, and an SSE stream holds one open
 * indefinitely — three tabs could starve the app of ordinary requests. So exactly one tab
 * holds the connection and relays what it receives to the others over a `BroadcastChannel`,
 * keeping the count at one per browser regardless of how many tabs are open.
 *
 * **Which tab should that be** is normally a leader election, with heartbeats and stale-lock
 * timeouts and a long tail of bugs. The Web Locks API answers it exactly: a lock is held for
 * as long as a promise is unresolved and is released by the browser when the tab goes away,
 * so a closed leader hands over immediately and without anyone having to detect it.
 */

export interface ChangeEvent {
    id: number;
    entity: "media" | "artifact" | "variant" | "scan" | "job";
    entityId: string | null;
    rootId: string | null;
    op: "insert" | "update" | "delete";
    detail: string | null;
}

export interface SummaryEvent {
    added: number;
    updated: number;
    removed: number;
}

export type LiveEvent =
    | { type: "change"; change: ChangeEvent }
    | { type: "summary"; summary: SummaryEvent }
    /** Too much changed to describe; refetch rather than patch. */
    | { type: "resync" };

const CHANNEL_NAME = "private-stock-events";
const LOCK_NAME = "private-stock-events-leader";

type Listener = (event: LiveEvent) => void;

/**
 * Open the stream, or attach to the one another tab already holds.
 *
 * Returns a teardown function. Calling it releases the lock if this tab was the leader, which
 * lets another tab take over immediately rather than after a timeout.
 */
export const connectLiveUpdates = (onEvent: Listener): (() => void) => {
    if (typeof window === "undefined") {
        return () => {};
    }

    const channel = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL_NAME) : null;

    let source: EventSource | null = null;
    let releaseLock: (() => void) | null = null;
    let torndown = false;

    // A follower hears everything through the channel. The leader does not receive its own
    // posts, so it calls the listener directly as well.
    if (channel) {
        channel.onmessage = (message: MessageEvent<LiveEvent>) => onEvent(message.data);
    }

    const emit = (event: LiveEvent): void => {
        onEvent(event);
        channel?.postMessage(event);
    };

    const openStream = (): void => {
        if (torndown) {
            return;
        }

        // Credentials are the HttpOnly refresh cookie; EventSource cannot set a header.
        source = new EventSource("/api/events");

        source.addEventListener("change", (event) => {
            try {
                emit({ type: "change", change: JSON.parse((event as MessageEvent).data) });
            } catch {
                // A malformed frame is not worth tearing the connection down for.
            }
        });

        source.addEventListener("summary", (event) => {
            try {
                emit({ type: "summary", summary: JSON.parse((event as MessageEvent).data) });
            } catch {
                /* ignore */
            }
        });

        source.addEventListener("resync", () => emit({ type: "resync" }));

        // EventSource reconnects on its own, using the `retry` interval the server sends and
        // resuming from the last event id. Nothing to do here but let it.
    };

    const locks = (navigator as Navigator & { locks?: LockManager }).locks;

    if (locks) {
        void locks
            .request(
                LOCK_NAME,
                () =>
                    new Promise<void>((resolve) => {
                        if (torndown) {
                            resolve();
                            return;
                        }

                        releaseLock = resolve;
                        openStream();
                    })
            )
            .catch(() => {
                // Lock machinery unavailable or the request was aborted. Falling back to an
                // own connection is worse for the connection budget but correct.
                if (!torndown && !source) {
                    openStream();
                }
            });
    } else {
        // No Web Locks: every tab opens its own stream. Degrades the connection budget rather
        // than the feature.
        openStream();
    }

    return () => {
        torndown = true;

        source?.close();
        source = null;

        // Resolving the callback promise is what releases the lock, handing leadership to
        // whichever tab is waiting.
        releaseLock?.();
        releaseLock = null;

        if (channel) {
            channel.onmessage = null;
            channel.close();
        }
    };
};
