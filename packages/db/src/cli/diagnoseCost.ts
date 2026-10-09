/**
 * `pnpm db:diagnose --cost` — how many database pages each hot statement touches.
 *
 * On the NAS a statement's cost is roughly proportional to the pages it reads: every query is a
 * few milliseconds when its pages are cached, and a page that is not costs on the order of 100 ms
 * on a disk ffmpeg is saturating (§20). So timings alone mislead — the same statement is 3 ms on
 * one run and 17 s on the next, depending on what the page cache happened to hold — while the
 * page count is the same every time and is what the timing is made of.
 *
 * The count comes from `rchar` in `/proc/self/io`: bytes this process asked the kernel for, cached
 * by the OS or not. With mmap off (so reads are `pread` calls rather than page faults nobody
 * counts), SQLite's own cache shrunk to 1 MiB, and that cache released before every statement,
 * `rchar / page_size` is the number of pages the statement touched. Where `/proc/self/io` does not
 * exist — the Windows dev box — page counts are reported as unavailable rather than guessed, and
 * the timings and plans are still printed.
 *
 * Instrumentation lives here and only here. `db.ts`'s `timeStatements` is the always-available
 * production instrument; this is a measuring rig for one CLI process, which owns its connection
 * and may set what it likes on it.
 */

import { readFileSync } from "node:fs";

import {
    DEFAULT_HOME_LAYOUT,
    homeLayoutSchema,
    isViewerRelative,
    LOOKS_LIKE,
    LOOKS_LIKE_MARGIN,
    mediaQuerySchema,
    PROGRESS_STAGE_NAMES,
    savedQuerySchema,
    SETTING_KEYS,
    type HomeLayout,
    type MediaQuery,
    type Shelf,
} from "@private-stock/core";

import { cacheKibibytes, getDb, type Db } from "../db.js";
import {
    artifactRepo,
    clipRepo,
    dupeRepo,
    faceRepo,
    homeLayoutRepo,
    jobRepo,
    mediaRepo,
    mediaRootRepo,
    mediaTextRepo,
    playlistRepo,
    reelRepo,
    refreshTokenRepo,
    savedFilterRepo,
    scanRepo,
    settingRepo,
    stageRepo,
    tagRepo,
    userRepo,
} from "../repos/index.js";

const CACHE_KIB = 1024;

/** The cache size the app itself runs with, kept for the endpoints measured as one snapshot. */
let appCacheSize = -CACHE_KIB;

/** Bytes requested through `read`/`pread` so far, or null where the kernel does not say. */
const readBytes = (): number | null => {
    try {
        const match = /^rchar:\s*(\d+)/m.exec(readFileSync("/proc/self/io", "utf8"));

        return match ? Number(match[1]) : null;
    } catch {
        return null;
    }
};

/**
 * What reading the counter costs in the counter.
 *
 * Reading `/proc/self/io` is itself a `read`, so every before/after pair includes one read of the
 * file. Measured rather than assumed, and the smallest of a few, because the file's length
 * depends on how many digits the numbers in it have reached.
 */
const counterOverhead = (): number => {
    let smallest = Infinity;

    for (let i = 0; i < 5; i++) {
        const before = readBytes();
        const after = readBytes();

        if (before === null || after === null) {
            return 0;
        }

        smallest = Math.min(smallest, after - before);
    }

    return smallest;
};

/** One run of an endpoint: what it executed, how long it all took, and whether it failed. */
interface Pass {
    samples: Sample[];
    ms: number;
    error: string | null;
}

/** One executed statement, as measured. */
interface Sample {
    sql: string;
    ms: number;
    bytes: number | null;
    plan: string[] | null;
}

/**
 * The connection the CLI measures through, and what it was changed to.
 *
 * `getDb()` rather than a second handle: the repos use the process-wide connection, and in a CLI
 * process that connection is this process's alone, so changing its pragmas touches nothing the
 * app is using. `query_only` makes the read-only promise enforced rather than intended — this is
 * meant to be run against the live database while the app is serving — and `NEXT_RUNTIME` is
 * cleared first so that a `docker exec` inheriting it cannot turn reads in a transaction into
 * `BEGIN IMMEDIATE`, which would take the write lock (see `immediateTransactions` in db.ts).
 */
export const openCostConnection = (): Db => {
    delete process.env.NEXT_RUNTIME;

    const database = getDb();

    // The web process's cache, which is what an endpoint shares across one snapshot. Not this
    // connection's: with `NEXT_RUNTIME` cleared it was opened with the worker's smaller one.
    appCacheSize = -cacheKibibytes(true);

    database.pragma("mmap_size = 0");
    database.pragma(`cache_size = -${CACHE_KIB}`);
    database.pragma("query_only = ON");

    return database;
};

/** Collapses a statement to one line, because a NAS console is the reader. */
const flat = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/** The plan as SQLite prints it, indented by depth. */
const planFor = (prepare: Db["prepare"], sql: string, args: unknown[]): string[] => {
    try {
        const steps = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as {
            id: number;
            parent: number;
            detail: string;
        }[];
        const depth = new Map<number, number>([[0, -1]]);

        return steps.map((step) => {
            const level = (depth.get(step.parent) ?? -1) + 1;

            depth.set(step.id, level);

            return `${"  ".repeat(level)}${step.detail}`;
        });
    } catch (error) {
        return [`(no plan: ${error instanceof Error ? error.message : String(error)})`];
    }
};

/**
 * Wraps `prepare` so every `get`, `all` and `run` is measured while a recorder is open.
 *
 * Methods that return the statement for chaining (`pluck`, `raw`, `expand`, `bind`) hand back
 * the proxy rather than the bare statement, or `prepare(sql).pluck().get()` would slip past
 * unmeasured. `iterate` is passed through unmeasured: its cost is spent in the caller's loop.
 * Plans are taken through the unwrapped `prepare`, after the measurement, so an `EXPLAIN` is
 * never counted against the endpoint.
 */
const instrument = (database: Db) => {
    const prepare = database.prepare.bind(database) as Db["prepare"];
    const overhead = counterOverhead();
    let recorder: { samples: Sample[]; plans: boolean; isolate: boolean } | null = null;

    const measured = (
        sql: string,
        target: object,
        run: (...args: unknown[]) => unknown,
        args: unknown[]
    ): unknown => {
        if (!recorder) {
            return run.apply(target, args);
        }

        // Every statement starts from an empty SQLite cache, so its count is its own and does
        // not depend on what the statement before it happened to leave behind -- unless the
        // endpoint is measured as one snapshot, where sharing that cache is the point.
        if (recorder.isolate) {
            database.pragma("shrink_memory");
        }

        const before = readBytes();
        const started = process.hrtime.bigint();
        const result = run.apply(target, args);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const after = readBytes();

        recorder.samples.push({
            sql,
            ms,
            bytes:
                before === null || after === null ? null : Math.max(0, after - before - overhead),
            plan: recorder.plans ? planFor(prepare, sql, args) : null,
        });

        return result;
    };

    database.prepare = ((sql: string) => {
        const statement = prepare(sql);

        return new Proxy(statement, {
            get: (target, property, receiver) => {
                const value = Reflect.get(target, property, target);

                if (typeof value !== "function") {
                    return value;
                }

                if (property === "get" || property === "all" || property === "run") {
                    return (...args: unknown[]) =>
                        measured(sql, target, value as (...a: unknown[]) => unknown, args);
                }

                return (...args: unknown[]) => {
                    const result = (value as (...a: unknown[]) => unknown).apply(target, args);

                    return result === target ? receiver : result;
                };
            },
        });
    }) as Db["prepare"];

    return {
        countsPages: readBytes() !== null,
        /**
         * Runs one pass with the recorder open. Never throws: a failing endpoint still reports
         * what it ran before failing, and the statement that threw is often the interesting one.
         */
        record: (plans: boolean, run: () => void, isolate = true): Pass => {
            const pass: Pass = { samples: [], ms: 0, error: null };

            database.pragma("shrink_memory");
            recorder = { samples: pass.samples, plans, isolate };

            const started = process.hrtime.bigint();

            try {
                run();
            } catch (error) {
                pass.error = error instanceof Error ? error.message : String(error);
            } finally {
                recorder = null;
            }

            pass.ms = Number(process.hrtime.bigint() - started) / 1e6;

            return pass;
        },
    };
};

/** What the endpoints are measured as: a real viewer, and what their grid showed. */
interface Viewer {
    userId: string;
    displayName: string;
    admin: boolean;
    rootIds: string[];
    gridIds: string[];
}

interface Endpoint {
    name: string;
    run: (viewer: Viewer) => void;
    /**
     * Measured as the request really runs: in one read transaction, with the app's own cache
     * size and nothing released between statements, so a page shared by two statements is
     * counted once. Every other endpoint isolates its statements instead, which is each one's
     * worst case and what a statement costs when the worker's commits keep emptying the cache.
     */
    snapshot?: boolean;
}

/**
 * The web process's hot read paths, as the repo calls their services make.
 *
 * A mirror, not an import: the services live in `apps/web` and this package cannot depend on it.
 * The cost of that is drift — a service that grows a query will not show it here until this list
 * is told — and the direction of the error is safe: a stale list under-reports an endpoint, it
 * never invents cost. Writes on read paths (the evicted-rendition enqueue in the detail) are left
 * out; `query_only` would refuse them anyway.
 */
const ENDPOINTS: Endpoint[] = [
    {
        // Every request that misses the auth cache: the cookie path's token lookup (with a
        // token that matches nothing, which walks the same index), the user, their libraries.
        name: "auth (cookie, uncached)",
        run: (viewer) => {
            refreshTokenRepo.findLive("diagnose-cost-not-a-real-token");
            userRepo.findById(viewer.userId);
            viewer.rootIds = mediaRootRepo.accessibleRootIds(viewer.userId);
        },
    },
    {
        name: "GET /api/library/stats",
        run: () => {
            mediaRootRepo.listRoots();
            scanRepo.isAnyRunning();
        },
    },
    {
        // `librarySummaries`: per enabled, accessible library, its count and its newest item
        // (which, through mediaService, also fetches that item's tile tags).
        name: "GET /api/library/roots (per-library summaries)",
        run: (viewer) => {
            const visible = mediaRootRepo
                .listRoots()
                .filter((root) => root.enabled === 1 && viewer.rootIds.includes(root.id));

            for (const root of visible) {
                mediaRepo.countMedia(
                    mediaQuerySchema.parse({ rootId: root.id, limit: 1, page: 0, sort: "addedAt" }),
                    viewer.userId,
                    viewer.rootIds
                );

                const newest = mediaRepo.listMedia(
                    mediaQuerySchema.parse({
                        rootId: root.id,
                        limit: 1,
                        page: 0,
                        sort: "addedAt",
                        direction: "desc",
                    }),
                    viewer.userId,
                    viewer.rootIds
                );

                tagRepo.listForMediaIds(
                    newest.rows.map((row) => row.id),
                    viewer.userId
                );
            }
        },
    },
    {
        // pipelineService.getProcessingStatus when its cache is cold: every statement under the
        // one deferred transaction it opens (§13c, §20).
        name: "GET /api/admin/processing (cold, one snapshot)",
        snapshot: true,
        run: () => {
            getDb()
                .transaction(() => {
                    const running = scanRepo.currentRun();

                    if (running) {
                        mediaRootRepo.findById(running.rootId);
                        scanRepo.lastCompletedFilesSeen(running.rootId);
                    }

                    mediaRepo.countProcessable();
                    stageRepo.summary();
                    jobRepo.queueSummary();
                    settingRepo.get(SETTING_KEYS.throttle, {});
                })
                .deferred();
        },
    },
    {
        // What a request costs while an idle answer is cached: the check that work has not
        // started since.
        name: "GET /api/admin/processing (idle answer cached)",
        run: () => {
            scanRepo.isAnyRunning();
            jobRepo.anyLive();
        },
    },
    {
        // No web caller any more. Kept because it is the aggregate §20 measured at 19 s when
        // `/api/library/stats` still ran it, and `pnpm db:diagnose` without flags still times it.
        name: "mediaRepo.countVisible (former stats count; diagnose only)",
        run: (viewer) => {
            mediaRepo.countVisible(viewer.userId, viewer.rootIds);
        },
    },
    {
        name: "GET /api/media (default grid page)",
        run: (viewer) => {
            const result = mediaRepo.listMedia(
                mediaQuerySchema.parse({}),
                viewer.userId,
                viewer.rootIds
            );

            viewer.gridIds = result.rows.map((row) => row.id);
            tagRepo.listForMediaIds(viewer.gridIds, viewer.userId);
        },
    },
    {
        name: "GET /api/media/count (default filter)",
        run: (viewer) => {
            mediaRepo.countMedia(mediaQuerySchema.parse({}), viewer.userId, viewer.rootIds);
        },
    },
    {
        // A grid page asks for every tile's cover at once, on the one thread.
        name: "GET /api/art (a cover per grid tile)",
        run: (viewer) => {
            for (const id of viewer.gridIds) {
                mediaRepo.findVisibleArtifact(
                    id,
                    viewer.rootIds,
                    { effectiveCover: true },
                    { includeTrashed: viewer.admin }
                );
            }
        },
    },
    {
        name: "GET /api/media/[id] (first grid item)",
        run: (viewer) => {
            const id = viewer.gridIds[0];

            if (!id) {
                return;
            }

            mediaRepo.findDetail(id, viewer.userId, viewer.rootIds);
            tagRepo.listForMedia(id, viewer.userId);
            artifactRepo.findEffectiveCover(id);
            artifactRepo.listForMedia(id, ["cover", "poster", "capture"]);
            // clipService.listClipsFor checks readability with a second findDetail.
            mediaRepo.findDetail(id, viewer.userId, viewer.rootIds);
            clipRepo.listForMedia(id, viewer.userId);
            stageRepo.listForMedia(id);
            jobRepo.liveForMedia(id, PROGRESS_STAGE_NAMES);
            dupeRepo.activeCopies(id);
            reelRepo.clipsAtRiskFor(id, viewer.userId);
            mediaTextRepo.listForMedia(id, { includeDismissed: viewer.admin });
        },
    },
    {
        name: "GET /api/tags?kind=performer",
        run: () => {
            tagRepo.listByKind("performer", null, 500);
        },
    },
    {
        // Review › Faces' pairs (§5f): every group in the library, every request.
        name: "GET /api/faces/review (pairs, library-wide)",
        run: (viewer) => {
            faceRepo.groupEvidence(viewer.rootIds);
            faceRepo.groupRefusals();
            faceRepo.groupSizes(viewer.rootIds, 1);
            faceRepo.groupLikenesses(viewer.rootIds, LOOKS_LIKE, LOOKS_LIKE_MARGIN);
        },
    },
    {
        // A performer's Organise page (§5f): the same pairs, asked of only their groups. The
        // performer with the most confirmed faces, the costliest there is.
        name: "GET /api/tags/:id/faces + /likely (pairs, one performer)",
        run: (viewer) => {
            const busiest = getDb()
                .prepare(
                    `SELECT "tagId" FROM "Face" WHERE "tagId" IS NOT NULL
                      GROUP BY "tagId" ORDER BY count(*) DESC LIMIT 1`
                )
                .get() as { tagId: string } | undefined;

            if (!busiest) {
                return;
            }

            const groupIds = [
                ...new Set([
                    ...faceRepo.performerGroupIds(busiest.tagId),
                    ...faceRepo.likenessGroupIds(busiest.tagId, LOOKS_LIKE, LOOKS_LIKE_MARGIN),
                ]),
            ];

            faceRepo.groupEvidence(viewer.rootIds, groupIds);
            faceRepo.groupRefusals(groupIds);
            faceRepo.groupSizes(viewer.rootIds, 1, groupIds);
            faceRepo.groupLikenesses(viewer.rootIds, LOOKS_LIKE, LOOKS_LIKE_MARGIN, groupIds);
            faceRepo.untaggedInGroups(groupIds, busiest.tagId, viewer.rootIds);
        },
    },
];

/**
 * The layout `/api/home` would render for this viewer: theirs, else the admin default, then
 * their own pinned filters — `homeService.getHome`'s order, capped as it caps it.
 */
const homeShelves = (viewer: Viewer): Shelf[] => {
    const parse = (raw: string | undefined): HomeLayout | null => {
        try {
            const parsed = homeLayoutSchema.safeParse(raw === undefined ? null : JSON.parse(raw));

            return parsed.success ? parsed.data : null;
        } catch {
            return null;
        }
    };
    const layout =
        parse(homeLayoutRepo.find(viewer.userId)) ??
        parse(settingRepo.getRaw(SETTING_KEYS.homeLayout)) ??
        DEFAULT_HOME_LAYOUT;
    const placed = new Set(
        layout.filter((shelf) => shelf.source === "filter").map((shelf) => shelf.filterId)
    );
    const pinned = savedFilterRepo
        .listVisibleTo(viewer.userId)
        .filter((row) => row.pinned === 1 && row.userId === viewer.userId && !placed.has(row.id))
        .sort((left, right) => left.position - right.position)
        .map((row): Shelf => ({ source: "filter", filterId: row.id, limit: 12 }));

    return [...layout, ...pinned].slice(0, 20);
};

/** A shelf's list query, as `homeService.runQuery` builds it. */
const shelfQuery = (query: Partial<MediaQuery>, limit: number): MediaQuery =>
    mediaQuerySchema.parse({ sort: "addedAt", direction: "desc", page: 0, ...query, limit });

const BUILTIN_SHELF_QUERIES: Record<string, Partial<MediaQuery>> = {
    recentlyAdded: { sort: "addedAt", direction: "desc" },
    topRated: { sort: "rating", direction: "desc", minRating: 1 },
    favorites: { favorite: true, sort: "addedAt", direction: "desc" },
    random: { sort: "random" },
};

/**
 * `/api/home`, one endpoint per shelf (§6, §20), so the shelf that costs is named.
 *
 * Built per viewer because the shelves are: the layout is theirs or the admin's, and pinned
 * filters are appended. Each mirrors `homeService.resolveShelf` — the repo calls a shelf of
 * that source makes, tile tags included.
 */
const homeEndpoints = (viewer: Viewer): Endpoint[] => {
    const shelves = homeShelves(viewer).map((shelf, index): Endpoint => {
        const list = (partial: Partial<MediaQuery>, overlayUserId?: string) => {
            const query = shelfQuery(partial, shelf.limit);
            // A shuffled shelf as it costs when its cached sample has expired: the shuffle that
            // refills the sample, then a dozen of it hydrated by id.
            const rows =
                query.sort === "random"
                    ? mediaRepo.listByIds(
                          mediaRepo
                              .shuffledIds(
                                  query,
                                  viewer.userId,
                                  viewer.rootIds,
                                  query.limit * 20,
                                  1,
                                  overlayUserId
                              )
                              .slice(0, query.limit),
                          viewer.userId,
                          viewer.rootIds
                      )
                    : mediaRepo.listMedia(query, viewer.userId, viewer.rootIds, overlayUserId).rows;

            tagRepo.listForMediaIds(
                rows.map((row) => row.id),
                viewer.userId
            );
        };
        const label =
            shelf.source === "builtin"
                ? shelf.builtin
                : shelf.source === "filter"
                  ? `filter ${shelf.filterId.slice(0, 8)}`
                  : shelf.source === "playlist"
                    ? `playlist ${shelf.playlistId.slice(0, 8)}`
                    : `tag ${shelf.tagId.slice(0, 8)}`;

        return {
            name: `GET /api/home shelf ${index}: ${label}`,
            run: () => {
                if (shelf.source === "builtin") {
                    if (shelf.builtin === "recentlyViewed") {
                        const rows = mediaRepo.listRecentlyViewed(
                            viewer.userId,
                            viewer.rootIds,
                            shelf.limit
                        );

                        tagRepo.listForMediaIds(
                            rows.map((row) => row.id),
                            viewer.userId
                        );
                    } else {
                        list(BUILTIN_SHELF_QUERIES[shelf.builtin] ?? {});
                    }
                } else if (shelf.source === "filter") {
                    const row = savedFilterRepo.findVisibleTo(shelf.filterId, viewer.userId);
                    const parsed = row
                        ? savedQuerySchema.safeParse(JSON.parse(row.queryJson))
                        : null;

                    if (row && parsed?.success) {
                        list(
                            parsed.data,
                            row.resolveAs === "owner" &&
                                row.userId !== viewer.userId &&
                                isViewerRelative(parsed.data)
                                ? row.userId
                                : undefined
                        );
                    }
                } else if (shelf.source === "playlist") {
                    const ids = playlistRepo.findSummary(shelf.playlistId)
                        ? playlistRepo.listItemIds(shelf.playlistId, shelf.limit, 0)
                        : [];
                    const rows = mediaRepo.listByIds(ids, viewer.userId, viewer.rootIds);

                    tagRepo.listForMediaIds(
                        rows.map((row) => row.id),
                        viewer.userId
                    );
                } else if (tagRepo.findById(shelf.tagId)) {
                    list({ tags: [shelf.tagId], sort: "addedAt", direction: "desc" });
                }
            },
        };
    });

    return [
        ...shelves,
        {
            // What the request costs: every shelf under the one snapshot `getHome` opens.
            name: "GET /api/home (whole request, one snapshot)",
            snapshot: true,
            run: (who) => {
                getDb()
                    .transaction(() => {
                        for (const shelf of shelves) {
                            shelf.run(who);
                        }
                    })
                    .deferred();
            },
        },
    ];
};

/** One statement within an endpoint, its repeats folded together. */
interface Row {
    sql: string;
    calls: number;
    coldMs: number;
    warmMs: number;
    pages: number | null;
    plan: string[];
}

const fold = (cold: Sample[], warm: Sample[], pageSize: number): Row[] => {
    const rows = new Map<string, Row>();

    for (const sample of cold) {
        const row = rows.get(sample.sql) ?? {
            sql: sample.sql,
            calls: 0,
            coldMs: 0,
            warmMs: 0,
            pages: sample.bytes === null ? null : 0,
            plan: sample.plan ?? [],
        };

        row.calls += 1;
        row.coldMs += sample.ms;

        if (row.pages !== null && sample.bytes !== null) {
            row.pages += sample.bytes / pageSize;
        }

        rows.set(sample.sql, row);
    }

    for (const sample of warm) {
        const row = rows.get(sample.sql);

        if (row) {
            row.warmMs += sample.ms;
        }
    }

    return [...rows.values()];
};

const pad = (value: string, width: number): string => value.padStart(width);
const num = (value: number | null): string => (value === null ? "—" : value.toFixed(0));

/** Worst first: by pages where they are known, by cold time where they are not. */
const weight = (row: { pages: number | null; coldMs: number }): number => row.pages ?? row.coldMs;

export const runCost = (who: string | undefined): void => {
    const database = openCostConnection();
    const pageSize = database.pragma("page_size", { simple: true }) as number;
    const rig = instrument(database);

    console.log("Cost per endpoint — pages touched per statement");
    console.log(
        `  mmap_size=${database.pragma("mmap_size", { simple: true })}` +
            `  cache_size=${database.pragma("cache_size", { simple: true })}` +
            `  page_size=${pageSize}  query_only=on  SQLite cache released before each statement`
    );
    console.log(
        rig.countsPages
            ? "  pages = bytes read (/proc/self/io rchar) / page_size, OS cache or not"
            : "  Page counts are UNAVAILABLE on this platform (no /proc/self/io). Timings and" +
                  " plans only — run it in the container for pages."
    );

    const users = userRepo.listUsers();
    const user = who
        ? users.find((candidate) => candidate.id === who || candidate.email === who)
        : users[0];

    if (!user) {
        console.log(who ? `\nNo user with id or email ${who}.` : "\nNo users yet.");

        return;
    }

    const viewer: Viewer = {
        userId: user.id,
        displayName: user.displayName,
        admin: user.scopes.split(",").includes("admin"),
        rootIds: [],
        gridIds: [],
    };

    // The shelves are read now, unmeasured; each one runs after the auth endpoint has filled
    // in the viewer's libraries, because the list is mapped in order.
    const results = [...ENDPOINTS, ...homeEndpoints(viewer)].map((endpoint) => {
        const isolate = !endpoint.snapshot;

        database.pragma(`cache_size = ${isolate ? -CACHE_KIB : appCacheSize}`);

        const cold = rig.record(true, () => endpoint.run(viewer), isolate);
        const warm = rig.record(false, () => endpoint.run(viewer), isolate);
        const rows = fold(cold.samples, warm.samples, pageSize).sort(
            (a, b) => weight(b) - weight(a)
        );
        const pages = rig.countsPages ? rows.reduce((sum, row) => sum + (row.pages ?? 0), 0) : null;

        return {
            endpoint,
            rows,
            pages,
            coldMs: cold.ms,
            warmMs: warm.ms,
            error: cold.error ?? warm.error,
        };
    });

    console.log(
        `\nAs ${viewer.displayName}${viewer.admin ? " (admin)" : ""} over` +
            ` ${viewer.rootIds.length} accessible root(s), ${viewer.gridIds.length} grid item(s)`
    );

    results.sort((a, b) => weight(b) - weight(a));

    for (const result of results) {
        console.log(
            `\n${result.endpoint.name} — ` +
                (result.pages === null ? "" : `${result.pages.toFixed(0)} pages, `) +
                `cold ${result.coldMs.toFixed(1)} ms, warm ${result.warmMs.toFixed(1)} ms`
        );

        if (result.error) {
            console.log(`  FAILED: ${result.error}`);
        }

        if (result.rows.length === 0) {
            console.log("  (no statements)");
            continue;
        }

        console.log(`  ${pad("pages", 7)} ${pad("cold ms", 9)} ${pad("warm ms", 9)}  calls  sql`);

        for (const row of result.rows) {
            console.log(
                `  ${pad(num(row.pages), 7)} ${pad(row.coldMs.toFixed(1), 9)}` +
                    ` ${pad(row.warmMs.toFixed(1), 9)}  ${pad(String(row.calls), 5)}` +
                    `  ${flat(row.sql).slice(0, 110)}`
            );

            for (const step of row.plan) {
                console.log(`${" ".repeat(38)}${step}`);
            }
        }
    }

    const worst = results
        .flatMap((result) => result.rows.map((row) => ({ ...row, endpoint: result.endpoint.name })))
        .sort((a, b) => weight(b) - weight(a))
        .slice(0, 10);

    console.log(`\nWorst statements${rig.countsPages ? " by pages" : " by cold time"}`);

    for (const row of worst) {
        console.log(
            `  ${pad(num(row.pages), 7)} ${pad(row.coldMs.toFixed(1), 9)} ms  ${row.endpoint}:` +
                ` ${flat(row.sql).slice(0, 80)}`
        );
    }

    console.log(
        "\nReading it: on a busy NAS disk a page not in cache costs ~100 ms, so pages × 100 ms is" +
            "\nwhat a request can cost when the cache has nothing; warm ms is the same work cached."
    );
};

/**
 * Times one pasted statement with real values, twice, and counts its pages.
 *
 * For `--explain` when values are supplied: the plan does not need them, but a page count of a
 * statement bound to nulls would measure a query that matches nothing.
 */
export const measureStatement = (database: Db, sql: string, bindings: unknown[]): void => {
    const pageSize = database.pragma("page_size", { simple: true }) as number;
    const rig = instrument(database);

    if (!database.prepare(sql).reader) {
        console.log("  not measured: only a statement that returns rows is run here");

        return;
    }

    for (const label of ["cold", "warm"]) {
        const pass = rig.record(false, () => {
            database.prepare(sql).all(...bindings);
        });
        const sample = pass.samples[0];

        if (pass.error) {
            console.log(`  ${label}: failed — ${pass.error}`);
        } else if (sample) {
            console.log(
                `  ${label}: ${sample.ms.toFixed(1)} ms, ` +
                    (sample.bytes === null
                        ? "pages unavailable on this platform (no /proc/self/io)"
                        : `${(sample.bytes / pageSize).toFixed(0)} pages`)
            );
        }
    }
};
