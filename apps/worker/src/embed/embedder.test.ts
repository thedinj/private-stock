import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POLITE_PRIORITY } from "../throttle.js";

import {
    CEILING_BYTES,
    FACES_RECYCLE_BYTES,
    HEAP_MB,
    RECYCLE_BYTES,
    WATCH_MS,
    childEnv,
    childExecArgv,
    embedInChild,
    facesInChild,
    stopModelChild,
    withTypeScriptLoader,
} from "./embedder.js";
import type { EmbedRequest, FacesRequest } from "./protocol.js";

/** A stand-in for the forked child: records what it is sent and whether it was killed. */
class FakeChild extends EventEmitter {
    static nextPid = 1000;
    readonly pid = FakeChild.nextPid++;
    readonly send = vi.fn();
    readonly kill = vi.fn(() => true);

    /** Answer the request it was sent last, as the real child would. */
    answer(rss: number): void {
        const { id } = this.send.mock.calls.at(-1)![0] as { id: number };

        this.emit("message", { id, ok: true, result: { moments: 1, kept: 1, vectors: 2 }, rss });
    }
}

const mocks = vi.hoisted(() => ({
    children: [] as unknown[],
    fork: vi.fn(),
    readFile: vi.fn(),
    setPriority: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:child_process")>()),
    fork: mocks.fork,
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:fs/promises")>()),
    readFile: mocks.readFile,
}));

vi.mock("node:os", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:os")>()),
    setPriority: mocks.setPriority,
}));

const children = (): FakeChild[] => mocks.children as FakeChild[];

const request: EmbedRequest = {
    model: "clip-b32-vision-uint8",
    stageVersion: 1,
    threads: 1,
    sources: [],
    outPath: "/data/embed/aa/x.vec",
};

const facesRequest: FacesRequest = {
    detector: "face-det-scrfd-10g",
    recogniser: "face-rec-arcface-r50",
    stageVersion: 1,
    threads: 1,
    sources: [],
    outPath: "/data/faces/aa/x.vec",
};

/** What `/proc/<pid>/status` says about a process of this resident size. */
const status = (bytes: number): string =>
    `Name:\tnode\nVmHWM:\t${bytes / 1024} kB\nVmRSS:\t${bytes / 1024} kB\nThreads:\t11\n`;

describe("the flags the embedder child inherits", () => {
    it("keeps tsx's loader, so the child can be TypeScript in development", () => {
        const tsx = ["--require", "/x/tsx/preflight.cjs", "--import", "file:///x/tsx/loader.mjs"];

        expect(childExecArgv(tsx)).toEqual([...tsx, `--max-old-space-size=${HEAP_MB}`]);
    });

    it("drops the debugger, which would fight the parent for its port", () => {
        expect(childExecArgv(["--inspect=9229", "--import", "loader"])).toEqual([
            "--import",
            "loader",
            `--max-old-space-size=${HEAP_MB}`,
        ]);
        expect(childExecArgv(["--inspect-brk", "--inspect-port", "9230"])).toEqual([
            `--max-old-space-size=${HEAP_MB}`,
        ]);
    });

    it("drops flags that make Node refuse to load a file", () => {
        expect(childExecArgv(["--input-type=module", "-e", "code"])).toEqual([
            `--max-old-space-size=${HEAP_MB}`,
        ]);
        expect(childExecArgv(["--input-type", "module"])).toEqual([
            `--max-old-space-size=${HEAP_MB}`,
        ]);
    });

    it("gives the child its own heap ceiling rather than the worker's", () => {
        expect(childExecArgv(["--max-old-space-size=512"])).toEqual([
            `--max-old-space-size=${HEAP_MB}`,
        ]);
        expect(childExecArgv(["--max-old-space-size", "512", "--import", "x"])).toEqual([
            "--import",
            "x",
            `--max-old-space-size=${HEAP_MB}`,
        ]);
    });
});

describe("a TypeScript child", () => {
    it("is given tsx's loader when nothing else brought one", () => {
        expect(withTypeScriptLoader("/w/child.ts", ["--max-old-space-size=64"])).toEqual([
            "--import",
            "tsx",
            "--max-old-space-size=64",
        ]);
    });

    it("is left alone when the flags already carry tsx, and so is a compiled child", () => {
        const tsx = ["--import", "file:///x/tsx/loader.mjs"];

        expect(withTypeScriptLoader("/w/child.ts", tsx)).toEqual(tsx);
        expect(withTypeScriptLoader("/w/child.js", [])).toEqual([]);
    });
});

describe("the environment the embedder child inherits", () => {
    it("drops the worker's pinned allocator thresholds and keeps everything else", () => {
        expect(
            childEnv({
                PATH: "/usr/bin",
                MALLOC_ARENA_MAX: "2",
                MALLOC_MMAP_THRESHOLD_: "131072",
                MALLOC_TRIM_THRESHOLD_: "131072",
                PRIVATE_STOCK_DATA_DIR: "/data",
            })
        ).toEqual({ PATH: "/usr/bin", MALLOC_ARENA_MAX: "2", PRIVATE_STOCK_DATA_DIR: "/data" });
    });

    it("leaves the worker's own environment alone", () => {
        const env = { MALLOC_MMAP_THRESHOLD_: "131072" };

        childEnv(env);

        expect(env).toEqual({ MALLOC_MMAP_THRESHOLD_: "131072" });
    });
});

/**
 * The child's memory (§5e "Memory", §20): a ceiling that fails the one job, a softer line that
 * replaces the child between items, and neither of them taking the worker down.
 */
describe("the embedder child", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.children.length = 0;
        mocks.fork.mockReset().mockImplementation(() => {
            const child = new FakeChild();

            mocks.children.push(child);
            return child;
        });
        mocks.readFile.mockReset().mockResolvedValue(status(200 * 1024 * 1024));
        mocks.setPriority.mockReset();
    });

    afterEach(() => {
        stopModelChild();
        vi.useRealTimers();
    });

    it("is started with its heap ceiling and at a lowered priority", async () => {
        const done = embedInChild(request);
        const [child] = children();

        const options = mocks.fork.mock.calls[0][2] as { execArgv: string[] };
        expect(options.execArgv).toContain(`--max-old-space-size=${HEAP_MB}`);
        // Background or not: the child outlives the job that started it.
        expect(mocks.setPriority).toHaveBeenCalledWith(child.pid, POLITE_PRIORITY);
        // The thread count goes to the child as the request states it.
        expect(child.send.mock.calls[0][0]).toMatchObject({ request: { threads: 1 } });

        child.answer(200 * 1024 * 1024);
        await expect(done).resolves.toMatchObject({ vectors: 2 });
    });

    it("keeps one child across items while it stays small", async () => {
        for (let i = 0; i < 3; i += 1) {
            const done = embedInChild(request);

            children()[0].answer(200 * 1024 * 1024);
            await done;
        }

        expect(mocks.fork).toHaveBeenCalledTimes(1);
        expect(children()[0].kill).not.toHaveBeenCalled();
    });

    it("fails the request, and only the request, when the child passes its ceiling", async () => {
        const done = embedInChild(request);
        const [first] = children();
        const failed = expect(done).rejects.toThrow(/past its \d+ MB ceiling/);

        mocks.readFile.mockResolvedValue(status(CEILING_BYTES + 1024 * 1024));
        await vi.advanceTimersByTimeAsync(WATCH_MS);

        await failed;
        expect(first.kill).toHaveBeenCalled();
        expect(mocks.readFile).toHaveBeenCalledWith(`/proc/${first.pid}/status`, "utf8");

        // The next item gets a fresh child; the worker carried on.
        mocks.readFile.mockResolvedValue(status(200 * 1024 * 1024));
        const next = embedInChild(request);

        expect(mocks.fork).toHaveBeenCalledTimes(2);
        children()[1].answer(200 * 1024 * 1024);
        await expect(next).resolves.toMatchObject({ vectors: 2 });
    });

    it("does not read memory while the child is idle", async () => {
        const done = embedInChild(request);

        children()[0].answer(200 * 1024 * 1024);
        await done;
        mocks.readFile.mockClear();

        await vi.advanceTimersByTimeAsync(WATCH_MS * 5);

        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it("replaces a child that has grown, after it answers, without failing anything", async () => {
        const done = embedInChild(request);
        const [first] = children();

        first.answer(RECYCLE_BYTES + 1024 * 1024);

        await expect(done).resolves.toMatchObject({ vectors: 2 });
        expect(first.kill).toHaveBeenCalled();

        embedInChild(request);
        expect(mocks.fork).toHaveBeenCalledTimes(2);
    });

    it("does not let a replaced child's exit fail its successor's request", async () => {
        const done = embedInChild(request);
        const [first] = children();

        first.answer(RECYCLE_BYTES + 1024 * 1024);
        await done;

        const next = embedInChild(request);
        const [, second] = children();

        // The old process's exit arrives only now, while the new one is working.
        first.emit("exit", null, "SIGTERM");

        second.answer(200 * 1024 * 1024);
        await expect(next).resolves.toMatchObject({ vectors: 2 });
    });

    it("fails the request when the child dies, as any crash does", async () => {
        const done = embedInChild(request);
        const failed = expect(done).rejects.toThrow(/stopped \(SIGABRT\)/);

        children()[0].emit("exit", null, "SIGABRT");

        await failed;
    });

    /**
     * One family of models at a time (§5f): `embed` and `faces` each hold a few hundred MB, and
     * the two together would crowd out the database's page cache.
     */
    it("retires an idle child before starting one for the other family", async () => {
        const embedded = embedInChild(request);
        const [first] = children();

        first.answer(200 * 1024 * 1024);
        await embedded;

        facesInChild(facesRequest);

        expect(first.kill).toHaveBeenCalled();
        expect(mocks.fork).toHaveBeenCalledTimes(2);
        expect(children()[1].send.mock.calls[0][0]).toMatchObject({ request: { kind: "faces" } });
    });

    it("lets a busy child finish before switching families", async () => {
        const embedded = embedInChild(request);
        const [first] = children();
        const faces = facesInChild(facesRequest);

        // Still working on the embed: nothing is started, and nothing is killed.
        expect(mocks.fork).toHaveBeenCalledTimes(1);
        expect(first.kill).not.toHaveBeenCalled();

        first.answer(200 * 1024 * 1024);
        await embedded;
        await vi.advanceTimersByTimeAsync(0);

        expect(first.kill).toHaveBeenCalled();

        const [, second] = children();

        second.emit("message", {
            id: (second.send.mock.calls[0][0] as { id: number }).id,
            ok: true,
            result: { regions: 3, detected: 1, faces: [] },
            rss: 300 * 1024 * 1024,
        });

        await expect(faces).resolves.toMatchObject({ regions: 3 });
    });

    it("holds the faces family to its own, higher memory line", async () => {
        const faces = facesInChild(facesRequest);
        const [child] = children();

        // Past CLIP's line, short of the faces line: kept.
        child.emit("message", {
            id: (child.send.mock.calls[0][0] as { id: number }).id,
            ok: true,
            result: { regions: 1, detected: 0, faces: [] },
            rss: FACES_RECYCLE_BYTES - 1024 * 1024,
        });
        await faces;

        expect(child.kill).not.toHaveBeenCalled();
    });
});
