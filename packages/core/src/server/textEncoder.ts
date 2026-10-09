import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { NotFoundError } from "../errors.js";

/**
 * The web app's side of the text encoder child (§5e "Search runs in two passes").
 *
 * A look asked for in words becomes a vector here: the child is started on the first one and
 * killed after `IDLE_MS` without another. Killed from this side rather than timing itself out,
 * for the embedder's reason (`apps/worker/src/embed/embedder.ts`): a child that decides to exit
 * can do so just as a request is on its way to it.
 *
 * In `core/server` rather than the web app because the child has to be a file Node can run on
 * its own, and the web app's code exists only inside Next's bundle.
 */

/**
 * How long the model stays loaded with nothing to do.
 *
 * Longer than the embedder's minute: somebody trying one look after another pauses to watch
 * between them, and each start costs a model load the person waits through. Short enough that
 * the model's memory goes back to the page cache soon after they stop (§5e "Memory").
 */
export const IDLE_MS = 5 * 60_000;

/**
 * The child's V8 heap, in MB. The model's memory is native and unbounded by this; what it bounds
 * is the JavaScript side, a few KB of tokens and one vector per request.
 */
const HEAP_MB = 64;

export type TextParentMessage = { id: number; text: string };

export type TextChildMessage =
    { id: number; ok: true; vector: number[] } | { id: number; ok: false; error: string };

const CHILD_FILE = "textEncoderChild.js";

/**
 * The child's compiled entry point.
 *
 * Beside this module when it is running from `dist`, which is the worker, a test, or anything
 * else Node loads unbundled. Found by walking up from the working directory otherwise, which is
 * the web app: Next bundles this module into its own chunks, so its location says nothing, and
 * the standalone server runs from `/app/apps/web` with `/app/packages/core/dist` above it.
 */
export const textEncoderChildPath = (): string => {
    const beside = path.join(path.dirname(fileURLToPath(import.meta.url)), CHILD_FILE);

    if (existsSync(beside)) {
        return beside;
    }

    let current = path.resolve(process.cwd());

    for (;;) {
        const candidate = path.join(current, "packages", "core", "dist", "server", CHILD_FILE);

        if (existsSync(candidate)) {
            return candidate;
        }

        const parent = path.dirname(current);

        if (parent === current) break;

        current = parent;
    }

    throw new NotFoundError(
        `No ${CHILD_FILE} beside core/server or above ${process.cwd()}. Build @private-stock/core.`
    );
};

interface Waiting {
    resolve: (vector: Float32Array) => void;
    reject: (error: Error) => void;
}

let child: { process: ChildProcess; pending: Map<number, Waiting> } | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let nextId = 1;

/** Stop the child now, if there is one; anything it still owes fails. */
export const stopTextEncoder = (): void => {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }

    if (child) {
        const stopping = child;

        child = null;
        stopping.process.kill();
    }
};

const start = (): NonNullable<typeof child> => {
    const started = {
        // None of the parent's flags: the child is plain JavaScript and needs no loader, and the
        // web app's `--inspect` would have it fight for the same debugger port.
        //
        // `spawn` of Node with an IPC channel, which is all `fork` is, because Turbopack reads a
        // `fork` as an import: it tries to bundle whatever the path evaluates to, fails, and takes
        // every route that imports `core/server` down with it in `pnpm dev`. No value of the path
        // satisfies it, and `turbopackIgnore` does not reach `fork`. Webpack, which makes the
        // production build, never looked.
        process: spawn(
            process.execPath,
            [`--max-old-space-size=${HEAP_MB}`, textEncoderChildPath()],
            { stdio: ["ignore", "inherit", "inherit", "ipc"] }
        ),
        pending: new Map<number, Waiting>(),
    };

    started.process.on("message", (message: TextChildMessage) => {
        const waiting = started.pending.get(message.id);

        if (!waiting) {
            return;
        }

        started.pending.delete(message.id);

        if (message.ok) {
            waiting.resolve(Float32Array.from(message.vector));
        } else {
            waiting.reject(new Error(message.error));
        }

        if (started.pending.size === 0 && child === started) {
            idleTimer = setTimeout(stopTextEncoder, IDLE_MS);
            idleTimer.unref();
        }
    });

    started.process.on("exit", (code, signal) => {
        if (child === started) {
            child = null;
        }

        for (const { reject } of started.pending.values()) {
            reject(
                new Error(
                    `The text encoder stopped (${signal ?? `exit ${code}`}) before it answered`
                )
            );
        }

        started.pending.clear();
    });

    return started;
};

/** Words as a look vector: unit length, comparable with the frames' (§5e). */
export const encodeLookText = (text: string): Promise<Float32Array> => {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }

    child ??= start();

    const running = child;
    const id = nextId++;
    const promise = new Promise<Float32Array>((resolve, reject) =>
        running.pending.set(id, { resolve, reject })
    );

    running.process.send({ id, text } satisfies TextParentMessage);

    return promise;
};

// A process that exits must not leave a model resident behind it.
process.on("exit", stopTextEncoder);
