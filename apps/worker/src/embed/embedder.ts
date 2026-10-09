import { fork, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { lowerPriority } from "../media/politeSpawn.js";

import type {
    ChildMessage,
    EmbedRequest,
    EmbedResult,
    FacesRequest,
    FacesResult,
    ModelFamily,
    ModelRequest,
} from "./protocol.js";

/**
 * The worker's side of the model child (§5e, §5f).
 *
 * **One child, one family of models at a time.** `embed` and `faces` each hold a few hundred MB
 * of model while they work, and two children at once would be half a gigabyte of a container
 * whose cap includes the database's page cache (§20). So a request for the other family waits for
 * the child to finish what it is doing, retires it, and starts a fresh one — a model load, about a
 * second, on each switch, against holding both.
 *
 * The child is started on the first request and killed after `IDLE_MS` without one. Killing
 * from here rather than letting the child time itself out is deliberate: a child that decides to
 * exit can do so just as a request is on its way, and that request would wait for an answer that
 * is never coming.
 *
 * A child that dies mid-request fails that request, and the next one starts another. A native
 * crash in the model therefore costs one job's attempt, not the worker. So does a child that
 * outgrows its memory ceiling: it is stopped from here and its request fails, rather than being
 * left to push the web process's pages into swap (§20).
 */

/**
 * How long the model stays loaded with nothing to do.
 *
 * Long enough to bridge the gap between one queued job and the next — the claim loop's poll, a
 * sweep refilling the queue — so a backlog loads the model once rather than once per item. Short
 * enough that its quarter of a gigabyte is back with the page cache soon after the work stops
 * (§5e "Memory").
 */
export const IDLE_MS = 60_000;

const MB = 1024 * 1024;

/**
 * The child's V8 heap, in MB. The model's memory is native and this does not bound it; what it
 * bounds is the JavaScript side — the squares, the vectors, the moments of one item — which
 * runs in a few MB, so a runaway there ends the child (and fails one job) long before it
 * matters to the container.
 */
export const HEAP_MB = 64;

/**
 * Resident size past which the child is replaced once it has answered, in bytes.
 *
 * Measured in the container with real sprite sheets: the model alone holds ~210 MB, and a child
 * working through items climbs slowly past that as glibc keeps what each item freed — ~285 MB
 * after forty. A process that never goes idle would keep climbing, so one past this line is
 * retired between items, roughly every forty: the next item pays a model load (~0.3 s) and
 * nothing fails.
 */
export const RECYCLE_BYTES = 288 * MB;

/**
 * The faces family's lines, by the same reasoning (§5f), from the container rather than the
 * desktop: the desktop's ~230 MB was Windows', and the first lines drawn from it stopped every
 * faces job in the container at 459–507 MB. Measured there with the graph kept `basic`, the pair
 * loads at ~290 MB and settles at ~440 MB after a few items. The lines were 480 and 576 until a
 * large item stopped the child at 578 MB in the first pass (2026-10-08): 544 and 640 now, which
 * the container's 1.5 GB still holds beside the web (~140–230 MB) and the worker (~170 MB).
 */
export const FACES_RECYCLE_BYTES = 544 * MB;
export const FACES_CEILING_BYTES = 640 * MB;

/**
 * Resident size at which a child working on a request is stopped, failing that request.
 *
 * The container's 1536 MiB holds the web process (~140 MB, peaks ~230), the worker (~170, peaks
 * ~230) and the page cache the database lives in (§20); the child stays under `RECYCLE_BYTES`
 * between items, and had been seen at 411 MB before its memory settings changed. This leaves it room for a large sheet
 * and stops anything beyond that before it reaches the web process's pages.
 */
export const CEILING_BYTES = 384 * MB;

const LIMITS: Record<ModelFamily, { recycle: number; ceiling: number }> = {
    embed: { recycle: RECYCLE_BYTES, ceiling: CEILING_BYTES },
    faces: { recycle: FACES_RECYCLE_BYTES, ceiling: FACES_CEILING_BYTES },
};

/** How often a working child's resident size is read, where the platform allows (Linux). */
export const WATCH_MS = 1_000;

/**
 * The child's entry point: compiled JavaScript in the container, TypeScript under tsx in
 * development. `fork` inherits `execArgv`, so the tsx loader comes along when it is in use.
 */
const childPath = (): string =>
    fileURLToPath(
        new URL(import.meta.url.endsWith(".ts") ? "./child.ts" : "./child.js", import.meta.url)
    );

/**
 * The worker's Node flags, minus the ones that would break a second process, plus the child's
 * heap ceiling.
 *
 * `fork` passes the parent's flags on by default, and that is wanted for one reason: under tsx
 * they carry the loader that lets the child be TypeScript. Everything else is the parent's own
 * business. `--inspect` from the VS Code debug configuration would have the child try to open the
 * same debugger port and die; `--input-type` or `--eval` from a one-off script makes Node refuse
 * to load a file at all — which is how this was found.
 */
export const childExecArgv = (execArgv: string[]): string[] => {
    const kept: string[] = [];

    for (let i = 0; i < execArgv.length; i += 1) {
        const flag = execArgv[i];

        if (/^--(inspect|debug)/.test(flag) || /^--(input-type|eval|print)(=|$)/.test(flag)) {
            // A value given as the next argument goes with its flag.
            if (/^--(inspect-port|input-type|eval|print)$/.test(flag)) i += 1;
            continue;
        }

        if (flag === "-e" || flag === "-p") {
            i += 1;
            continue;
        }

        // The worker's own heap size is the worker's; the child gets `HEAP_MB` below.
        if (/^--max-old-space-size(=|$)/.test(flag)) {
            if (flag === "--max-old-space-size") i += 1;
            continue;
        }

        kept.push(flag);
    }

    kept.push(`--max-old-space-size=${HEAP_MB}`);

    return kept;
};

/**
 * The flags plus tsx's loader, when the child is TypeScript and nothing else brought one.
 *
 * Under `pnpm dev` the worker runs in tsx and its flags carry the loader to the child. A test
 * runner does not: Node strips the child's types itself, but cannot resolve its `./faces.js`
 * to `faces.ts`, which tsx does. Compiled, the child is JavaScript and needs nothing.
 */
export const withTypeScriptLoader = (entry: string, execArgv: string[]): string[] =>
    entry.endsWith(".ts") && !execArgv.some((flag) => flag.includes("tsx"))
        ? ["--import", "tsx", ...execArgv]
        : execArgv;

/**
 * The worker's environment minus the glibc allocator settings `entrypoint.sh` gives the worker.
 *
 * Those pin glibc's mmap and trim thresholds so the worker's freed memory goes back to the
 * system (§20 "The worker's own memory"). The child is the opposite case: onnxruntime frees and
 * re-allocates the same large tensors on every model run, and with the thresholds pinned each of
 * them became an `mmap` and `munmap` with fresh page faults -- measured at 12-15 s an item instead
 * of 11 s, for 65 MB less resident. The child is already bounded by being replaced (`RECYCLE_BYTES`), so it
 * keeps glibc's defaults and its speed.
 */
export const childEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const kept = { ...env };

    delete kept.MALLOC_MMAP_THRESHOLD_;
    delete kept.MALLOC_TRIM_THRESHOLD_;

    return kept;
};

interface Waiting {
    resolve: (result: EmbedResult | FacesResult) => void;
    reject: (error: Error) => void;
}

/**
 * One child and the requests it owes answers to.
 *
 * Per child rather than module-wide, because a child can now be replaced while the worker
 * carries on: the old one's exit arrives after the next has started, and must fail only what
 * *it* was asked.
 */
interface Running {
    family: ModelFamily;
    process: ChildProcess;
    pending: Map<number, Waiting>;
    watch: NodeJS.Timeout;
    /** Called once nothing is pending: a request for the other family waits on these. */
    drained: (() => void)[];
}

let current: Running | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let nextId = 1;

const mb = (bytes: number): number => Math.round(bytes / MB);

/** A process's resident size from `/proc`, or null where there is no `/proc` to read. */
const residentBytes = async (pid: number): Promise<number | null> => {
    try {
        const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(await readFile(`/proc/${pid}/status`, "utf8"));

        return match ? Number(match[1]) * 1024 : null;
    } catch {
        // Windows, or the child has just exited.
        return null;
    }
};

const settle = (running: Running): void => {
    for (const resume of running.drained.splice(0)) {
        resume();
    }
};

const failAll = (running: Running, reason: string): void => {
    for (const { reject } of running.pending.values()) {
        reject(new Error(reason));
    }

    running.pending.clear();
    settle(running);
};

/**
 * Stop a child and forget it. With a reason, what it still owes fails with that reason now;
 * without one, its exit fails anything left, as for any other death.
 */
const retire = (running: Running, reason?: string): void => {
    if (current === running) {
        current = null;
    }

    clearInterval(running.watch);

    if (reason) {
        failAll(running, reason);
    }

    running.process.kill();
};

/**
 * Stop the child now, if there is one. Called when it has been idle for `IDLE_MS`, and when the
 * worker exits: a model must not stay resident with nobody left to send it work.
 */
export const stopModelChild = (): void => {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }

    if (current) {
        retire(current);
    }
};

const start = (family: ModelFamily): Running => {
    const entry = childPath();
    const started = fork(entry, [], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        execArgv: withTypeScriptLoader(entry, childExecArgv(process.execArgv)),
        env: childEnv(process.env),
    });

    // Lowered always, not only for background work (§7c). The child outlives any one job and the
    // window opening or closing, and its priority can be lowered but never raised again — so a
    // per-job answer was whichever job started it, for hours. Lowered, it still has its core
    // whenever the web process is not asking for it; a request someone made pays only when the
    // two are contending, which is when the page should win anyway.
    lowerPriority(started);

    const { recycle, ceiling } = LIMITS[family];
    const running: Running = {
        family,
        process: started,
        pending: new Map(),
        drained: [],
        watch: setInterval(() => {
            if (running.pending.size === 0 || started.pid === undefined) {
                return;
            }

            void residentBytes(started.pid).then((rss) => {
                if (rss !== null && rss > ceiling && current === running) {
                    console.error(
                        `Model child (${family}) at ${mb(rss)} MB, past its ${mb(ceiling)} MB ceiling: stopping it`
                    );
                    retire(
                        running,
                        `The model child grew to ${mb(rss)} MB, past its ${mb(ceiling)} MB ceiling, and was stopped`
                    );
                }
            });
        }, WATCH_MS),
    };

    running.watch.unref();

    started.on("message", (message: ChildMessage) => {
        const waiting = running.pending.get(message.id);

        if (!waiting) {
            return;
        }

        running.pending.delete(message.id);

        // Grown past what it should hold: replaced before the next item, so the next request
        // starts a fresh child rather than finding this one on its way out.
        const outgrown = message.rss > recycle;

        if (outgrown) {
            retire(running);
        }

        if (message.ok) {
            waiting.resolve(message.result);
        } else {
            waiting.reject(new Error(message.error));
        }

        if (running.pending.size === 0) {
            settle(running);
        }

        if (!outgrown && running.pending.size === 0 && current === running) {
            idleTimer = setTimeout(stopModelChild, IDLE_MS);
            idleTimer.unref();
        }
    });

    started.on("exit", (code, signal) => {
        if (current === running) {
            current = null;
        }

        clearInterval(running.watch);
        failAll(
            running,
            `The model child stopped (${signal ?? `exit ${code}`}) before it answered`
        );
    });

    return running;
};

/**
 * Send one request to the child, starting it if it is not running.
 *
 * A child holding the other family is retired first — at once when it is idle, otherwise once
 * what it is doing is done — so the two families never hold their models together.
 */
const inChild = (request: ModelRequest): Promise<EmbedResult | FacesResult> => {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }

    if (current && current.family !== request.kind) {
        const other = current;

        if (other.pending.size > 0) {
            return new Promise<void>((resume) => other.drained.push(resume)).then(() =>
                inChild(request)
            );
        }

        retire(other);
    }

    current ??= start(request.kind);

    const running = current;
    const id = nextId++;
    const promise = new Promise<EmbedResult | FacesResult>((resolve, reject) =>
        running.pending.set(id, { resolve, reject })
    );

    running.process.send({ id, request });

    return promise;
};

/** Embed one item in the child (§5e). */
export const embedInChild = (request: EmbedRequest): Promise<EmbedResult> =>
    inChild({ kind: "embed", ...request }) as Promise<EmbedResult>;

/** Which family the child holds now, or null when there is no child (`affinity.ts`). */
export const heldFamily = (): ModelFamily | null => current?.family ?? null;

/** Find and recognise one item's faces in the child (§5f). */
export const facesInChild = (request: FacesRequest): Promise<FacesResult> =>
    inChild({ kind: "faces", ...request }) as Promise<FacesResult>;

// A worker that exits must not leave a model resident behind it.
process.on("exit", stopModelChild);
