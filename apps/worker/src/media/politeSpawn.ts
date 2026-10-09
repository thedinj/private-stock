import { execFile, spawn, type ChildProcess } from "node:child_process";
import { setPriority } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { POLITE_PRIORITY, isPolite } from "../throttle.js";

const execFileAsync = promisify(execFile);

/**
 * Running ffmpeg without taking the box down with it (§7c).
 *
 * The priority is set on the *child*, immediately after it is spawned, and never restored.
 * Both halves matter:
 *
 *  - On the child, because the worker process itself must stay responsive -- it is holding
 *    heartbeats for every other job in flight, and a niced worker would lose claims under
 *    load rather than merely finish later.
 *  - Never restored, because on POSIX an unprivileged process may lower a priority and may
 *    not raise it again. Each child is spawned fresh at the parent's priority, so there is
 *    nothing to put back and the container needs no CAP_SYS_NICE.
 *
 * `setPriority` rather than a `nice` binary: Node maps its own scale onto `nice` on Linux and
 * `BELOW_NORMAL_PRIORITY_CLASS` on Windows, so the dev box and the NAS take the same path.
 */
export const bePolite = (child: ChildProcess): void => {
    if (isPolite()) {
        lowerPriority(child);
    }
};

/**
 * Lower a child's priority whatever the work is: for a child whose life is not one job's.
 *
 * The embedder child (§5e) serves job after job and outlives the window opening or closing, and
 * its priority can only ever go down. Deciding it from whichever job happened to start it left a
 * child niced by a throttled job serving hours of full-speed work after the window was switched
 * off, and would leave one started by a request serving background work at full priority.
 */
export const lowerPriority = (child: ChildProcess): void => {
    if (child.pid === undefined) {
        return;
    }

    try {
        setPriority(child.pid, POLITE_PRIORITY);
    } catch {
        // Best effort, always. A platform or a container that refuses this must not turn a
        // perfectly good encode into a failed job -- the throttle's other two levers, the
        // concurrency floor and the thread cap, do not depend on it.
    }
};

/**
 * `execFile`, with the child's priority lowered when the work is background work.
 *
 * The promise `promisify` returns carries the `ChildProcess` on `.child`, which is the only
 * moment the pid is available without rewriting every caller around `spawn`.
 */
export const execFilePolitely: typeof execFileAsync = ((
    file: string,
    args: string[],
    options: Parameters<typeof execFileAsync>[2]
) => {
    const promise = execFileAsync(file, args, options);

    bePolite(promise.child);

    return promise;
}) as typeof execFileAsync;

/**
 * How much of a child's stderr `runPolitely` keeps: the end of it, which is where ffmpeg says
 * why it stopped.
 */
const STDERR_TAIL_BYTES = 64 * 1024;

/**
 * A child that exited non-zero or was killed, shaped like `execFile`'s rejection.
 *
 * `killed` is what `isUnreadableSource` reads to leave a timeout to be retried, and the
 * message is what it matches markers against, so both keep `execFile`'s meaning. The message
 * names the program rather than its command line: the line is several hundred characters of
 * filter graph, and the 500 a stage row keeps used to be spent on it before the reason began.
 */
export class ProcessFailedError extends Error {
    constructor(
        readonly program: string,
        readonly code: number | null,
        readonly signal: NodeJS.Signals | null,
        readonly killed: boolean,
        stderrTail: string
    ) {
        const outcome = killed
            ? "was stopped at its time limit"
            : code === null
              ? `was killed (${signal})`
              : `exited with code ${code}`;

        super(`${program} ${outcome}${stderrTail ? `\n${stderrTail}` : ""}`);
        this.name = "ProcessFailedError";
    }
}

/**
 * Run a child to completion, keeping only the tail of its stderr.
 *
 * For a process whose output is files rather than stdout. `execFile` buffers all of stderr and
 * kills the child when it passes `maxBuffer` -- and ffmpeg, told to decode past damage with
 * `-max_error_rate 1`, logs several lines per bad packet. A file with 20,000 of them wrote
 * 7 MB of complaints, so the cap killed the very run that had been told to tolerate them, and
 * the sprite failed three times over days for a reason that had nothing to do with the file.
 */
export const runPolitely = (
    file: string,
    args: string[],
    options: { timeoutMs: number }
): Promise<void> =>
    new Promise((resolve, reject) => {
        const child = spawn(file, args, { stdio: ["ignore", "ignore", "pipe"] });
        let tail = "";
        let killed = false;

        bePolite(child);

        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            tail = (tail + chunk).slice(-STDERR_TAIL_BYTES);
        });

        const timer = setTimeout(() => {
            killed = true;
            child.kill("SIGTERM");
        }, options.timeoutMs);

        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });

        child.on("close", (code, signal) => {
            clearTimeout(timer);

            if (code === 0 && !killed) {
                resolve();
                return;
            }

            reject(new ProcessFailedError(path.basename(file), code, signal, killed, tail.trim()));
        });
    });
