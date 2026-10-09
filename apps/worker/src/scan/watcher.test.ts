import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Filesystem watching, one watch per directory (§7, §20 "The worker's own memory").
 *
 * The memory claim is the first test: a library of files costs a watch per *directory*. The
 * rest is that nothing was lost by dropping chokidar's per-file watches -- a new file still
 * queues a scan of its own directory, a directory that appears is watched from then on, and
 * the files a NAS scatters about are not worth a scan.
 *
 * Real filesystem events, so these wait on the real quiet period (a few seconds each).
 */

const queued: { subPath?: string; rootId: string }[] = [];

vi.mock("@private-stock/db", () => ({ db: {} }));
vi.mock("../queue.js", () => ({
    enqueue: (_db: unknown, options: { payload: { subPath?: string; rootId: string } }) => {
        queued.push(options.payload);
        return true;
    },
}));
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();

    return { ...actual, watch: vi.fn(actual.watch) };
});

const { expectRemoval, startWatchers } = await import("./watcher.js");

let library: string;
let close: (() => Promise<void>) | null = null;

const root = () => ({ id: "root", label: "Test", path: library, enabled: true });

const until = async (done: () => boolean, ms = 10_000): Promise<void> => {
    const deadline = Date.now() + ms;

    while (!done()) {
        if (Date.now() > deadline) {
            throw new Error("timed out waiting");
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

const watchedDirs = (): string[] =>
    vi
        .mocked(fs.watch)
        .mock.calls.map((call) => path.relative(library, String(call[0])).replace(/\\/g, "/"));

beforeEach(() => {
    library = mkdtempSync(path.join(tmpdir(), "ps-watch-"));
    queued.length = 0;
    vi.mocked(fs.watch).mockClear();

    for (const dir of ["a", "a/b", "c", "@eaDir"]) {
        mkdirSync(path.join(library, dir), { recursive: true });
    }

    for (let i = 0; i < 40; i += 1) {
        const dir = ["", "a", "a/b", "c"][i % 4];
        writeFileSync(path.join(library, dir, `clip-${i}.mp4`), "");
    }
});

afterEach(async () => {
    await close?.();
    close = null;
    rmSync(library, { recursive: true, force: true });
});

describe("startWatchers", () => {
    it("watches each directory once and no file at all", async () => {
        close = (await startWatchers([root() as never])).close;

        expect(watchedDirs().sort()).toEqual(["", "a", "a/b", "c"]);
    });

    it("queues a scan of the directory a file appeared in, and not for NAS litter", async () => {
        close = (await startWatchers([root() as never])).close;

        writeFileSync(path.join(library, "a/b", "new.mp4"), "x");
        writeFileSync(path.join(library, "c", "Thumbs.db"), "x");

        await until(() => queued.length > 0);
        // Past the quiet period, so anything else would have arrived with it.
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(queued).toEqual([{ rootId: "root", subPath: "a/b" }]);
    });

    it("does not scan for a file the app removed itself, and does for anybody else's", async () => {
        close = (await startWatchers([root() as never])).close;

        fs.unlinkSync(path.join(library, "a", "clip-1.mp4"));
        expectRemoval(path.join(library, "a", "clip-1.mp4"));
        fs.unlinkSync(path.join(library, "c", "clip-3.mp4"));

        await until(() => queued.length > 0);
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(queued).toEqual([{ rootId: "root", subPath: "c" }]);
    });

    it("watches a directory that appears, and what is put in it", async () => {
        close = (await startWatchers([root() as never])).close;

        mkdirSync(path.join(library, "c", "d"));
        await until(() => watchedDirs().includes("c/d"));
        writeFileSync(path.join(library, "c", "d", "new.mp4"), "x");

        await until(() => queued.length >= 2);

        expect(queued.map((change) => change.subPath).sort()).toEqual(["c", "c/d"]);
    });
});
