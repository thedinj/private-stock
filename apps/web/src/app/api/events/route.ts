import type { ChangeRow } from "@private-stock/db";

import { requireAuth } from "@/lib/auth/withAuth";
import { toErrorResponse } from "@/lib/errors/handleRouteError";
import { subscribe, type FeedBatch } from "@/lib/events/changeFeed";

// Declared literally — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * The live update stream (§13b).
 *
 * **Server-Sent Events, not WebSockets.** The traffic is entirely one-way, and SSE gives
 * reconnection, backoff and `Last-Event-ID` resumption for free in the browser. WebSockets
 * would also mean a custom server or a second listener, which is exactly the complexity
 * avoided by not adding an HTTP framework (§2).
 *
 * `EventSource` cannot set an Authorization header, so this authenticates with the HttpOnly
 * refresh cookie. The alternative — `fetch` with a `ReadableStream` — allows headers but
 * means reimplementing reconnection, backoff and resumption by hand, which is where the bugs
 * live.
 */

/**
 * Idle connections get killed by proxies and by phones putting the radio to sleep, and a
 * dead stream looks exactly like a quiet one. A comment every twenty seconds is enough to
 * keep it open and to make a genuinely broken connection fail fast enough to reconnect.
 */
const HEARTBEAT_MS = 20_000;

/**
 * Above this many changes in one tick, send a summary instead of individual events.
 *
 * Below it a single new file appears immediately and a thumbnail pops in exactly when it is
 * ready — the case that makes the app feel alive. Above it, a scan is running and a thousand
 * animations would melt the grid and, on a NAS, the box.
 *
 * The threshold lives here rather than in the worker on purpose: the worker writes
 * fine-grained rows and the reader decides how much detail to send, so this can change
 * without a migration (§13b).
 */
const DISCRETE_EVENT_LIMIT = 25;

interface Summary {
    added: number;
    updated: number;
    removed: number;
}

const summarise = (rows: ChangeRow[]): Summary => {
    const summary: Summary = { added: 0, updated: 0, removed: 0 };

    for (const row of rows) {
        if (row.op === "insert") summary.added += 1;
        else if (row.op === "delete") summary.removed += 1;
        else summary.updated += 1;
    }

    return summary;
};

export async function GET(request: Request) {
    try {
        const auth = await requireAuth(request, { allowCookie: true });

        const lastEventId = Number(request.headers.get("last-event-id"));
        const resumeFrom =
            Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : undefined;

        const encoder = new TextEncoder();
        let unsubscribe: (() => void) | null = null;
        let heartbeat: NodeJS.Timeout | null = null;

        const stream = new ReadableStream({
            start(controller) {
                let closed = false;

                const send = (chunk: string): void => {
                    if (closed) {
                        return;
                    }

                    try {
                        controller.enqueue(encoder.encode(chunk));
                    } catch {
                        // The client went away between the poll and the write. Tear down
                        // rather than accumulating a subscriber nobody is reading.
                        closed = true;
                        cleanup();
                    }
                };

                const cleanup = (): void => {
                    unsubscribe?.();
                    unsubscribe = null;

                    if (heartbeat) {
                        clearInterval(heartbeat);
                        heartbeat = null;
                    }
                };

                // Tell the browser how long to wait before reconnecting. Left to the default,
                // a restarted container gets hammered by every open tab at once.
                send("retry: 5000\n\n");

                const onBatch = (batch: FeedBatch): void => {
                    if (batch.kind === "truncated") {
                        send(
                            `id: ${batch.cursor}\nevent: resync\ndata: ${JSON.stringify({
                                reason: "too many changes",
                            })}\n\n`
                        );
                        return;
                    }

                    if (batch.rows.length === 0) {
                        return;
                    }

                    // Artifact events are never summarised away: a thumbnail appearing is the
                    // single most visible sign the app is working, and patching one in place
                    // is never disruptive however many are arriving.
                    const artifacts = batch.rows.filter((row) => row.entity === "artifact");
                    const rest = batch.rows.filter((row) => row.entity !== "artifact");

                    for (const row of artifacts) {
                        send(`id: ${row.id}\nevent: change\ndata: ${JSON.stringify(row)}\n\n`);
                    }

                    if (rest.length === 0) {
                        return;
                    }

                    if (rest.length > DISCRETE_EVENT_LIMIT) {
                        send(
                            `id: ${batch.cursor}\nevent: summary\ndata: ${JSON.stringify(
                                summarise(rest)
                            )}\n\n`
                        );
                        return;
                    }

                    for (const row of rest) {
                        send(`id: ${row.id}\nevent: change\ndata: ${JSON.stringify(row)}\n\n`);
                    }
                };

                unsubscribe = subscribe(onBatch, auth.accessibleRootIds, resumeFrom);

                heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
                heartbeat.unref?.();

                // Closing the tab, navigating away, or a proxy dropping the connection all
                // arrive here. Without it every reload leaks a subscriber and a timer.
                request.signal.addEventListener("abort", () => {
                    closed = true;
                    cleanup();

                    try {
                        controller.close();
                    } catch {
                        // Already closed by the runtime.
                    }
                });
            },

            cancel() {
                unsubscribe?.();

                if (heartbeat) {
                    clearInterval(heartbeat);
                }
            },
        });

        return new Response(stream, {
            status: 200,
            headers: {
                "Content-Type": "text/event-stream; charset=utf-8",
                // Reverse proxies buffer by default, and a buffered event stream arrives in
                // silent chunks or not at all. `no-transform` stops compression middleware
                // holding bytes back; `X-Accel-Buffering` is nginx's opt-out (Caddy does not
                // buffer).
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                Connection: "keep-alive",
            },
        });
    } catch (error) {
        return toErrorResponse(error, request);
    }
}
