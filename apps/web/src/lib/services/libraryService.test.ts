import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../auth/withAuth";

/**
 * Adding and moving libraries (§12b).
 *
 * Paths are typed by a person, so the two guardrails are what is worth testing: a path that
 * cannot be read is refused at the moment it is typed rather than becoming a library that
 * mysteriously never finds anything, and libraries cannot be nested — which would catalogue
 * one file twice, count it twice, and report it as a duplicate of itself.
 */

interface Row {
    id: string;
    path: string;
    label: string;
    enabled: number | null;
    writable?: number | null;
    lastScanAt: string | null;
}

let rows: Row[] = [];
/** What repointing did besides changing the path, so the test can assert on it. */
let effects: string[] = [];
/** Each count the summaries asked for: which library, for which viewer, through which roots. */
let counted: { rootId: string | undefined; userId: string; rootIds: string[] }[] = [];
/** How many times the scanning flag was read, which is what the stats cache changes. */
let scanChecks = 0;

/**
 * Directories that behave as a `:ro` mount would.
 *
 * Simulated rather than made with chmod, which Windows ignores for directories and root
 * ignores everywhere — the two places this suite actually runs.
 */
let readOnly = new Set<string>();

vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();

    return {
        ...actual,
        access: async (target: string, mode?: number) => {
            if (readOnly.has(target) && mode !== undefined && mode & actual.constants.W_OK) {
                throw Object.assign(new Error("read-only file system"), { code: "EROFS" });
            }

            return actual.access(target, mode);
        },
    };
});

/**
 * The counts go through `mediaService`, the one place the access and hidden-item filters live.
 * Five items in every library, and a cover named after it, so a total says how many were summed.
 */
vi.mock("./mediaService", () => ({
    countMedia: (query: { rootId?: string }, auth: AuthContext) => {
        counted.push({
            rootId: query.rootId,
            userId: auth.userId,
            rootIds: auth.accessibleRootIds,
        });

        return { total: 5, pageCount: 5 };
    },
    listMedia: (query: { rootId?: string }) => ({ items: [{ id: `cover-${query.rootId}` }] }),
}));

/**
 * No `mediaRepo` and no `jobRepo.queueSummary` here, on purpose: the polled summary must reach
 * neither (§20), and a call to either would throw rather than quietly cost a thousand pages.
 */
vi.mock("@private-stock/db", () => ({
    scanRepo: {
        isAnyRunning: () => {
            scanChecks += 1;

            return false;
        },
    },
    jobRepo: {
        enqueueKind: (kind: string) => effects.push(`enqueue:${kind}`),
        enqueueRootScan: (id: string) => effects.push(`scan:${id}`),
        cancelPendingForRoot: (id: string) => {
            effects.push(`cancel:${id}`);

            return 0;
        },
    },
    mediaRootRepo: {
        markUnverified: (id: string) => {
            effects.push(`hide:${id}`);

            return 0;
        },
        listRoots: () => rows,
        findById: (id: string) => rows.find((row) => row.id === id),
        create: (rootPath: string, label: string) => {
            const row = {
                id: `r${rows.length + 1}`,
                path: rootPath,
                label,
                enabled: 1,
                lastScanAt: null,
            };
            rows.push(row);

            return row;
        },
        setWritable: (id: string, writable: boolean) => {
            const row = rows.find((entry) => entry.id === id)!;
            row.writable = writable ? 1 : null;
        },
        setPath: (id: string, rootPath: string) => {
            const row = rows.find((entry) => entry.id === id)!;
            row.path = rootPath;
        },
        remove: (id: string) => {
            rows = rows.filter((row) => row.id !== id);
        },
    },
}));

const {
    addLibrary,
    browseDirectories,
    checkLibraryPath,
    clearLibraryCaches,
    isMountWritable,
    librarySummaries,
    libraryStats,
    repointLibrary,
    setLibraryWritable,
} = await import("./libraryService");

let base = "";

beforeEach(async () => {
    rows = [];
    effects = [];
    readOnly = new Set();
    counted = [];
    scanChecks = 0;
    // Both summaries are cached (§20), and a suite runs well inside either lifetime. Without
    // this, one test's counts are answered from the previous test's library.
    clearLibraryCaches();
    base = await mkdtemp(path.join(tmpdir(), "ps-lib-"));
    await mkdir(path.join(base, "videos", "season one"), { recursive: true });
    await mkdir(path.join(base, "photos"), { recursive: true });
    await writeFile(path.join(base, "notes.txt"), "not a directory");
});

describe("adding", () => {
    it("accepts a real directory and names it after the folder", async () => {
        const root = await addLibrary(path.join(base, "videos"));

        expect(root.label).toBe("videos");
        expect(root.path).toBe(path.join(base, "videos"));
    });

    /**
     * The check that earns its place in a container.
     *
     * A host path nobody mounted is the single most likely way to configure this wrongly, and
     * without this it would look like it worked and then find nothing forever.
     */
    it("refuses a directory that does not exist", async () => {
        await expect(addLibrary(path.join(base, "nope"))).rejects.toThrow(/No such directory/);
        expect(rows).toEqual([]);
    });

    it("refuses a file", async () => {
        await expect(addLibrary(path.join(base, "notes.txt"))).rejects.toThrow(/not a directory/);
    });

    it("refuses a relative path, which would mean whatever the process happened to be in", async () => {
        await expect(addLibrary("videos")).rejects.toThrow(/absolute/);
    });
});

describe("nesting", () => {
    it("refuses the same directory twice", async () => {
        await addLibrary(path.join(base, "videos"));

        await expect(addLibrary(path.join(base, "videos"))).rejects.toThrow(/already uses/);
    });

    /**
     * A file inside two libraries is catalogued twice, counted twice, and offered as a
     * duplicate of itself — and the two rows can disagree about whether deletion is allowed.
     */
    it("refuses a directory inside an existing library", async () => {
        await addLibrary(path.join(base, "videos"));

        await expect(addLibrary(path.join(base, "videos", "season one"))).rejects.toThrow(
            /already inside/
        );
    });

    it("refuses a directory that contains an existing library", async () => {
        await addLibrary(path.join(base, "videos"));

        await expect(addLibrary(base)).rejects.toThrow(/already contains/);
    });

    /**
     * The app's own directory holds the database, the signing key and the trash. As a
     * deletable library, all of it would be one trash action away from gone.
     */
    it("refuses the data directory, anything inside it, and anything containing it", async () => {
        const previous = process.env.PRIVATE_STOCK_DATA_DIR;
        process.env.PRIVATE_STOCK_DATA_DIR = path.join(base, "videos");

        try {
            await expect(addLibrary(path.join(base, "videos"))).rejects.toThrow(/own data/);
            await expect(addLibrary(path.join(base, "videos", "season one"))).rejects.toThrow(
                /own data/
            );
            await expect(addLibrary(base)).rejects.toThrow(/own data/);
            expect(rows).toEqual([]);

            await addLibrary(path.join(base, "photos"));
            expect(rows).toHaveLength(1);
        } finally {
            if (previous === undefined) {
                delete process.env.PRIVATE_STOCK_DATA_DIR;
            } else {
                process.env.PRIVATE_STOCK_DATA_DIR = previous;
            }
        }
    });

    it("allows siblings", async () => {
        await addLibrary(path.join(base, "videos"));
        await addLibrary(path.join(base, "photos"));

        expect(rows).toHaveLength(2);
    });
});

/**
 * Deletion needs the flag and a writable mount (§18.1).
 *
 * The flag is the app's to set; the mount is docker-compose's, and nothing in the app can
 * change it. So the flag is refused where the mount says no, instead of offering a delete
 * button that fails file by file in the trash job.
 */
describe("deletable", () => {
    it("can be allowed when the library is added", async () => {
        const root = await addLibrary(path.join(base, "videos"), undefined, true);

        expect(rows[0]?.writable).toBe(1);
        expect(root.id).toBe(rows[0]?.id);
    });

    it("refuses to add a deletable library on a read-only mount, and adds nothing", async () => {
        readOnly.add(path.join(base, "videos"));

        await expect(addLibrary(path.join(base, "videos"), undefined, true)).rejects.toThrow(
            /mounted read-only.*:rw/
        );
        expect(rows).toEqual([]);
    });

    it("adds a read-only library that is not asked to be deletable", async () => {
        readOnly.add(path.join(base, "videos"));

        await addLibrary(path.join(base, "videos"));

        expect(rows[0]?.writable).toBeUndefined();
    });

    it("refuses to switch deletion on over a read-only mount", async () => {
        const root = await addLibrary(path.join(base, "videos"));
        readOnly.add(root.path);

        await expect(setLibraryWritable(root.id, true)).rejects.toThrow(/mounted read-only/);
        expect(rows[0]?.writable).toBeUndefined();
    });

    it("always lets deletion be switched off, mount or no mount", async () => {
        const root = await addLibrary(path.join(base, "videos"), undefined, true);
        readOnly.add(root.path);

        await setLibraryWritable(root.id, false);

        expect(rows[0]?.writable).toBeNull();
    });

    it("tells the dialog which paths could be deletable", async () => {
        readOnly.add(path.join(base, "photos"));

        expect(await isMountWritable(path.join(base, "videos"))).toBe(true);
        expect(await isMountWritable(path.join(base, "photos"))).toBe(false);
    });
});

describe("moving", () => {
    it("points a library somewhere else", async () => {
        const root = await addLibrary(path.join(base, "videos"));

        await repointLibrary(root.id, path.join(base, "photos"));

        expect(rows[0]?.path).toBe(path.join(base, "photos"));
    });

    /**
     * The three things a repoint must do beyond changing the path.
     *
     * Hiding, because nobody has looked at the new directory yet. Cancelling, because a queued
     * job resolves its path when it runs and would write the new file's metadata onto the old
     * item. Scanning, because hiding without it would leave the library dark indefinitely.
     */
    it("hides the library, cancels queued work and starts a scan", async () => {
        const root = await addLibrary(path.join(base, "videos"));
        effects = [];

        await repointLibrary(root.id, path.join(base, "photos"));

        expect(effects).toEqual([`hide:${root.id}`, `cancel:${root.id}`, `scan:${root.id}`]);
    });

    it("does none of that when the path is refused", async () => {
        const root = await addLibrary(path.join(base, "videos"));
        effects = [];

        await expect(repointLibrary(root.id, path.join(base, "nope"))).rejects.toThrow();

        expect(effects).toEqual([]);
    });

    /**
     * A library must not collide with itself.
     *
     * Overlap is checked against every *other* library, so re-saving the same path is a no-op
     * rather than an error the admin has to puzzle over.
     */
    it("lets a library keep its own path", async () => {
        const root = await addLibrary(path.join(base, "videos"));

        await expect(repointLibrary(root.id, path.join(base, "videos"))).resolves.toBeDefined();
    });

    it("refuses to move onto another library", async () => {
        const root = await addLibrary(path.join(base, "videos"));
        await addLibrary(path.join(base, "photos"));

        await expect(repointLibrary(root.id, path.join(base, "photos"))).rejects.toThrow(
            /already uses/
        );
    });

    it("leaves the old path in place when the new one is bad", async () => {
        const root = await addLibrary(path.join(base, "videos"));

        await expect(repointLibrary(root.id, path.join(base, "nope"))).rejects.toThrow();
        // Nothing is stored until the path checks out, so a typo cannot leave a library
        // pointing nowhere.
        expect(rows[0]?.path).toBe(path.join(base, "videos"));
    });
});

describe("checking a path without writing", () => {
    /**
     * The live check and the write must agree.
     *
     * A form that approves a path the server then rejects is worse than no check at all,
     * because it teaches people to trust it. Both go through `checkLibraryPath`, and this is
     * what says so.
     */
    it("gives the same reason the write would", async () => {
        await addLibrary(path.join(base, "videos"));

        const checked = await checkLibraryPath(path.join(base, "videos", "season one"));

        expect(checked.ok).toBe(false);
        expect(checked.ok === false && checked.reason).toMatch(/already inside/);
        await expect(addLibrary(path.join(base, "videos", "season one"))).rejects.toThrow(
            /already inside/
        );
    });

    it("reports a usable path without creating anything", async () => {
        const checked = await checkLibraryPath(path.join(base, "videos"));

        expect(checked.ok).toBe(true);
        expect(rows).toEqual([]);
    });

    /** A library being moved must not collide with where it already is. */
    it("lets a library keep its own path when it is excluded", async () => {
        const root = await addLibrary(path.join(base, "videos"));

        expect((await checkLibraryPath(path.join(base, "videos"))).ok).toBe(false);
        expect((await checkLibraryPath(path.join(base, "videos"), root.id)).ok).toBe(true);
    });
});

describe("browsing", () => {
    it("lists subdirectories, not files", async () => {
        const result = await browseDirectories(base);

        expect(result.entries.map((entry) => entry.name).sort()).toEqual(["photos", "videos"]);
    });

    it("descends", async () => {
        const result = await browseDirectories(path.join(base, "videos"));

        expect(result.entries.map((entry) => entry.name)).toEqual(["season one"]);
        expect(result.path).toBe(path.join(base, "videos"));
    });

    it("offers a way back up", async () => {
        const result = await browseDirectories(path.join(base, "videos"));

        expect(result.parent).toBe(base);
    });

    it("refuses a path that is not a directory", async () => {
        await expect(browseDirectories(path.join(base, "notes.txt"))).rejects.toThrow();
    });

    /** The top of the tree has no parent, so "Up" has to stop rather than loop. */
    it("stops at the top", async () => {
        const root = path.parse(base).root;
        const result = await browseDirectories(root);

        expect(result.parent).toBeNull();
    });

    it("offers starting points when given nothing", async () => {
        const result = await browseDirectories();

        expect(result.path).toBeNull();
        expect(result.entries.length).toBeGreaterThan(0);
    });
});

describe("the polled summary", () => {
    /**
     * Root counts answer "why is this empty?", so they are not filtered by access — a viewer
     * who can reach none of three libraries needs to be told there are three.
     */
    it("reports every root, not only the reachable ones", async () => {
        await addLibrary(path.join(base, "videos"));
        await addLibrary(path.join(base, "photos"));
        rows[1]!.enabled = null;

        expect(libraryStats()).toEqual({
            scanning: false,
            rootsTotal: 2,
            rootsEnabled: 1,
            everScanned: false,
        });
    });

    /**
     * The point of the split (§20). The shell polls this every ten seconds, and the item counts
     * it used to include were 466 pages on the NAS — the whole web process stopped, per poll.
     */
    it("counts no items", async () => {
        await addLibrary(path.join(base, "videos"));

        libraryStats();

        expect(counted).toEqual([]);
    });

    it("answers a repeated ask, from anyone, without querying again", () => {
        libraryStats();
        libraryStats();
        libraryStats();

        expect(scanChecks).toBe(1);
    });

    it("is thrown away when the libraries change", async () => {
        expect(libraryStats().rootsTotal).toBe(0);

        await addLibrary(path.join(base, "photos"));

        expect(libraryStats().rootsTotal).toBe(1);
        expect(scanChecks).toBe(2);
    });
});

describe("the library counts", () => {
    const AUTH = { userId: "u1", accessibleRootIds: ["r1", "r2"] } as AuthContext;

    /**
     * The counts are the viewer's, not the database's.
     *
     * The nav sits beside the grid it describes, so it has to ask the same question the grid
     * asks — `listable`, not hidden, in an accessible root — which is what going through
     * `mediaService` buys. A library this viewer was denied is not counted at all.
     */
    it("counts each library this viewer can reach, as this viewer", async () => {
        await addLibrary(path.join(base, "videos"));
        await addLibrary(path.join(base, "photos"));
        rows.push({ id: "r9", path: "/elsewhere", label: "Denied", enabled: 1, lastScanAt: null });

        const summaries = librarySummaries(AUTH);

        expect(counted).toEqual([
            { rootId: "r1", userId: "u1", rootIds: ["r1", "r2"] },
            { rootId: "r2", userId: "u1", rootIds: ["r1", "r2"] },
        ]);
        expect(summaries.total).toBe(10);
        expect(summaries.libraries.map((library) => [library.id, library.items])).toEqual([
            ["r1", 5],
            ["r2", 5],
        ]);
        expect(summaries.libraries[1]?.cover).toEqual({ id: "cover-r2" });
    });

    it("leaves out a disabled library", async () => {
        await addLibrary(path.join(base, "videos"));
        await addLibrary(path.join(base, "photos"));
        rows[1]!.enabled = null;

        expect(librarySummaries(AUTH).libraries.map((library) => library.id)).toEqual(["r1"]);
    });
});

/**
 * The cache in front of the counts (§20).
 *
 * The counts walk an index entry per item, and on the NAS one answer measured seconds of
 * synchronous query. So the property worth pinning is that repeated asking — tabs, the change
 * feed's refetches during a scan — costs one answer, and that the actions which change the
 * numbers a person is watching do not wait for it to expire.
 */
describe("the cache in front of the counts", () => {
    const AUTH = { userId: "u1", accessibleRootIds: ["r1", "r2"] } as AuthContext;

    beforeEach(async () => {
        await addLibrary(path.join(base, "videos"));
        counted = [];
    });

    it("answers a repeated ask without querying again", () => {
        expect(librarySummaries(AUTH).total).toBe(5);
        expect(librarySummaries(AUTH).total).toBe(5);
        expect(librarySummaries(AUTH).total).toBe(5);

        expect(counted).toHaveLength(1);
    });

    it("gives a different viewer their own answer", () => {
        librarySummaries(AUTH);
        librarySummaries({ userId: "u2", accessibleRootIds: ["r1"] } as AuthContext);

        expect(counted).toHaveLength(2);
        expect(counted[1]).toEqual({ rootId: "r1", userId: "u2", rootIds: ["r1"] });
    });

    /** Access is part of the answer, so the same person with a different reach is not a hit. */
    it("does not reuse an answer across a change in reach", () => {
        librarySummaries(AUTH);
        librarySummaries({ userId: "u1", accessibleRootIds: ["r1"] } as AuthContext);

        expect(counted).toHaveLength(2);
    });

    /** Order must not matter: the same reach listed differently is the same reach. */
    it("reuses an answer when the roots arrive in another order", () => {
        librarySummaries(AUTH);
        librarySummaries({ userId: "u1", accessibleRootIds: ["r2", "r1"] } as AuthContext);

        expect(counted).toHaveLength(1);
    });

    it("is thrown away when the libraries change", async () => {
        librarySummaries(AUTH);

        await addLibrary(path.join(base, "photos"));

        expect(librarySummaries(AUTH).total).toBe(10);
    });

    /** Trashing and hiding call this; the person who did it is watching the number. */
    it("is thrown away on request", () => {
        librarySummaries(AUTH);
        clearLibraryCaches();
        librarySummaries(AUTH);

        expect(counted).toHaveLength(2);
    });

    /** The worker's changes reach no cache in this process, so they wait for this. */
    it("expires on its own after a minute", () => {
        vi.useFakeTimers();

        try {
            librarySummaries(AUTH);
            vi.advanceTimersByTime(59_000);
            librarySummaries(AUTH);
            expect(counted).toHaveLength(1);

            vi.advanceTimersByTime(2_000);
            librarySummaries(AUTH);
            expect(counted).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });
});
