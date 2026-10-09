import * as diagnostics from "node:diagnostics_channel";
import { monitorEventLoopDelay } from "node:perf_hooks";

/**
 * Request timing and event-loop lag, for diagnosing a slow NAS (§20).
 *
 * This exists because a HAR could prove what the slowness was *not* — not SQL, which benches
 * at fractions of a millisecond at real library size, and not the framework, which serves a
 * route in single-digit milliseconds — without being able to say what it was. The server kept
 * no record of how long it took to answer anything, so a request that took seven seconds and
 * a request that waited seven seconds for a CPU looked identical from outside.
 *
 * Two measurements, because one alone is ambiguous:
 *
 * - **Request duration** says a response was slow.
 * - **Event-loop delay** says why. Node serves requests on one thread, and `better-sqlite3` is
 *   synchronous, so a busy worker sharing the container shows up here as lag rather than as
 *   time attributable to any particular handler. Lag in the hundreds of milliseconds means the
 *   process is not being given a CPU; near zero with slow requests means the work is genuinely
 *   in the handler.
 *
 * Hooked through `diagnostics_channel` rather than a wrapper every route has to remember to
 * call. Route handlers deliberately have no shared entry point — the `dynamic`/`revalidate`
 * block is pasted literally into each one precisely because Next ignores a re-export — so
 * anything opt-in would be measuring only the routes somebody remembered.
 *
 * **Off unless asked for**, following `PRIVATE_STOCK_SQL_LOG` and for the same reason: on
 * Windows a console `process.stdout` is synchronous, and a terminal that stops draining blocks
 * the event loop of the process writing to it. A diagnostic for a stalled server must not be
 * able to stall one.
 *
 * Loaded only from the Node branch of `instrumentation.ts`, never imported directly: see there.
 */

/** Nanoseconds to milliseconds, one decimal. */
const ms = (nanoseconds: number): number => Math.round(nanoseconds / 1e5) / 10;

const flagged = (name: string): boolean => {
    const value = process.env[name];

    return value === "1" || value === "true";
};

/**
 * Only requests at least this slow are logged, so an idle server stays quiet and a busy one
 * does not spend its scarce CPU on describing itself. Everything on the NAS was over a second,
 * so the default is well below the signal being looked for.
 */
const slowRequestMs = Number(process.env.PRIVATE_STOCK_REQUEST_LOG_MS ?? 250);

/**
 * A signed media URL carries its credential in `?t=` (§12d), and a slow request is exactly the
 * kind this logs — a stream seeking on a busy NAS. A log line is not somewhere a day's access
 * to an item should end up, so the value is dropped and the parameter's presence kept.
 */
const redactToken = (url: string): string => url.replace(/([?&]t=)[^&#]*/g, "$1redacted");

/** How often the lag summary is printed, and the window each summary covers. */
const LAG_INTERVAL_MS = 30_000;

export const startRequestLog = (): void => {
    if (!flagged("PRIVATE_STOCK_REQUEST_LOG")) {
        return;
    }

    const started = new WeakMap<object, bigint>();

    diagnostics.subscribe("http.server.request.start", (message) => {
        const { request } = message as { request: object };
        started.set(request, process.hrtime.bigint());
    });

    diagnostics.subscribe("http.server.response.finish", (message) => {
        const { request, response } = message as {
            request: { method?: string; url?: string };
            response: { statusCode?: number };
        };

        const begin = started.get(request);

        if (begin === undefined) {
            return;
        }

        started.delete(request);
        const elapsed = Number(process.hrtime.bigint() - begin) / 1e6;

        if (elapsed >= slowRequestMs) {
            console.warn(
                `[slow] ${String(elapsed.toFixed(0)).padStart(6)}ms ` +
                    `${response.statusCode ?? "?"} ${request.method ?? "?"} ${redactToken(request.url ?? "?")}`
            );
        }
    });

    /*
     * `resolution` is the sampling interval, not the precision of the answer: the histogram is
     * fed every 20ms and records how late each sample was. Anything finer costs a timer wakeup
     * on a box that is already short of CPU, which would be the measurement changing the thing
     * it measures.
     *
     * Read it in the container, not on the Windows dev box. Windows timers are coarse enough
     * that an idle server here reports a mean around 30ms, which is the platform's clock rather
     * than a stalled loop. On Linux an unloaded process sits near zero, and that is the baseline
     * the numbers below are worth comparing against.
     */
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();

    const timer = setInterval(() => {
        // `max` is the one that matters: a single 7-second stall is invisible in a mean taken
        // over thirty seconds, and a single 7-second stall is exactly what was being chased.
        console.warn(
            `[loop] over ${LAG_INTERVAL_MS / 1000}s — ` +
                `mean ${ms(histogram.mean)}ms, p99 ${ms(histogram.percentile(99))}ms, ` +
                `max ${ms(histogram.max)}ms`
        );
        histogram.reset();
    }, LAG_INTERVAL_MS);

    // Nothing here should keep the process alive on its own.
    timer.unref();
};
