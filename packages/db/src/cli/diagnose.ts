/**
 * `pnpm db:diagnose` — where the time actually goes, measured on the box that is slow.
 *
 * In the container: `node packages/db/dist/cli/diagnose.js`, the same shape the entrypoint uses
 * for migrations.
 *
 * This exists because §20's instruments stop one level short. Request timing said
 * `/api/library/stats` took 19 seconds; event-loop delay said the process was blocked for
 * 19,025 ms, so the work was real rather than starved. Neither can say **which of that
 * endpoint's four queries** it was, and reasoning from the schema was already wrong twice — the
 * box's I/O, the page cache it is denied by a memory cap, and the size its tables have actually
 * reached are not knowable from here.
 *
 * So: row counts, file sizes, and each query the summary makes, timed separately — twice, because
 * the first run of one is partly a measurement of a cold page cache. Read-only, and it opens the
 * ordinary connection, so a number it reports is a number the app would have got. `--explain`
 * prints the plan for a statement pasted in from a `[sql]` log line, and `--cost` counts the
 * pages each hot endpoint's statements touch (diagnoseCost.ts) — the number that the timings
 * on the NAS are made of.
 */

import { db } from "../db.js";
import { mediaRepo, jobRepo, mediaRootRepo, scanRepo, userRepo } from "../repos/index.js";
import { measureStatement, openCostConnection, runCost } from "./diagnoseCost.js";

const ms = (nanoseconds: bigint): string => (Number(nanoseconds) / 1e6).toFixed(1).padStart(9);

/** Times one call and prints what it cost, rather than collecting results nobody reads. */
const timed = <T>(label: string, run: () => T): T => {
    const started = process.hrtime.bigint();
    const result = run();

    console.log(`  ${ms(process.hrtime.bigint() - started)} ms  ${label}`);

    return result;
};

const countRows = (table: string): number =>
    (db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;

/**
 * The tables that can plausibly be large, and the ones a slow aggregate would be scanning.
 *
 * Not every table: a list of forty numbers is a thing to skim rather than read, and the point is
 * to notice the one that is a thousand times bigger than expected.
 */
const TABLES = [
    "Media",
    "MediaFile",
    "MediaFileLink",
    "UserMedia",
    "Job",
    "Artifact",
    "ChangeLog",
    "TrashEntry",
    "DupeMember",
    "DupeGroup",
    "DupeClustered",
    "PhashImage",
    "PhashVideo",
    "MediaSearch",
    "Variant",
    "ErrorLog",
];

const main = (): void => {
    console.log("Row counts");

    for (const table of TABLES) {
        try {
            console.log(`  ${String(countRows(table)).padStart(9)}  ${table}`);
        } catch {
            // A table this build does not have. Nothing to report and nothing wrong.
            console.log(`          —  ${table} (absent)`);
        }
    }

    /**
     * The queue, by state.
     *
     * The row count alone said 97,717 and left the important question open: whether that is
     * finished work nobody swept (a retention bug, now fixed) or a pile of failures being
     * rediscovered every five minutes (a loop that no amount of indexing would fix). Those want
     * opposite responses, so the breakdown is worth its four lines.
     */
    console.log("\nJob queue");

    const states = db
        .prepare(
            `SELECT "state", count(*) AS n FROM "Job"
              GROUP BY "state" ORDER BY n DESC`
        )
        .all() as { state: string; n: number }[];

    for (const row of states) {
        console.log(`  ${String(row.n).padStart(9)}  ${row.state}`);
    }

    const failing = db
        .prepare(
            `SELECT "kind", count(*) AS n FROM "Job"
              WHERE "state" = 'failed' GROUP BY "kind" ORDER BY n DESC LIMIT 5`
        )
        .all() as { kind: string; n: number }[];

    if (failing.length > 0) {
        console.log("  failures by kind:");

        for (const row of failing) {
            console.log(`  ${String(row.n).padStart(9)}  ${row.kind}`);
        }
    }

    /**
     * Whether the indexes in the running image are the ones the source describes.
     *
     * "No pending migrations" is what the container prints either way, so an index migration that
     * did not take looks exactly like one that did — and the symptom is a query that is still
     * slow, which is indistinguishable from every other reason a query is slow on this box.
     */
    console.log("\nJob indexes, as the database actually has them");

    const indexes = db
        .prepare(
            `SELECT "name", "sql" FROM "sqlite_master"
              WHERE "type" = 'index' AND "tbl_name" = 'Job' AND "sql" IS NOT NULL
              ORDER BY "name"`
        )
        .all() as { name: string; sql: string }[];

    for (const index of indexes) {
        console.log(`  ${index.sql.replace(/\s+/g, " ").trim()}`);
    }

    const pageSize = db.pragma("page_size", { simple: true }) as number;
    const pageCount = db.pragma("page_count", { simple: true }) as number;
    const journal = db.pragma("journal_mode", { simple: true }) as string;
    const cacheSize = db.pragma("cache_size", { simple: true }) as number;

    console.log("\nDatabase");
    console.log(`  ${((pageSize * pageCount) / 1024 / 1024).toFixed(1)} MiB in ${pageCount} pages`);
    console.log(`  journal_mode=${journal}  cache_size=${cacheSize}  page_size=${pageSize}`);

    /**
     * Whichever account exists, because the summary's expensive query is per-viewer and a
     * userId that matches nothing would measure an empty result rather than the real one.
     */
    const user = userRepo.listUsers()[0];
    const roots = mediaRootRepo.listRoots();
    const rootIds = roots.map((root) => root.id);

    if (!user) {
        console.log("\nNo users yet — nothing to measure the summary against.");

        return;
    }

    console.log(`\n/api/library/stats, as ${user.displayName} over ${rootIds.length} root(s)`);
    timed("mediaRepo.countVisible", () => mediaRepo.countVisible(user.id, rootIds));
    timed("jobRepo.queueSummary", () => jobRepo.queueSummary());
    timed("scanRepo.isAnyRunning", () => scanRepo.isAnyRunning());
    timed("mediaRootRepo.listRoots", () => mediaRootRepo.listRoots());

    /**
     * Second pass, because the first one is partly a measurement of the page cache being cold.
     * A query that is slow twice is slow; one that is slow once was reading from the disk, which
     * on this box is the answer to a different question — and the one a memory cap decides.
     */
    console.log("\nAgain, warm");
    timed("mediaRepo.countVisible", () => mediaRepo.countVisible(user.id, rootIds));
    timed("jobRepo.queueSummary", () => jobRepo.queueSummary());

    console.log("\nFor the plan behind a slow statement, paste what a [sql] line printed:");
    console.log(`  node packages/db/dist/cli/diagnose.js --explain "SELECT ..." ['[values]']`);
    console.log("For the pages each hot endpoint's statements touch:");
    console.log("  node packages/db/dist/cli/diagnose.js --cost [user email or id]");
};

/**
 * The plan for one statement, taken from the command line rather than from a copy kept here.
 *
 * A diagnostic that holds its own duplicate of a query eventually describes a query the app no
 * longer runs. `PRIVATE_STOCK_SQL_SLOW_MS` already prints the text of whatever was slow, so
 * pasting that text in is what makes the statement examined provably the one measured.
 */
const explain = (sql: string, values: string | undefined): void => {
    // The measuring connection, so a statement given values can be counted as well as planned.
    const database = openCostConnection();

    console.log(sql.replace(/\s+/g, " ").trim());

    const statement = database.prepare(`EXPLAIN QUERY PLAN ${sql}`);

    /**
     * Nulls for whatever the statement takes.
     *
     * A plan does not depend on the values — but `better-sqlite3` refuses to execute without
     * them, and the statement pasted in is a real one from the log, so it carries real
     * placeholders. Named ones are read out of the SQL; positional `?` are counted.
     */
    const named = [
        ...new Set([...sql.matchAll(/[:@$]([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])),
    ];
    const positional = (sql.match(/\?/g) ?? []).length;
    const bindings = named.length
        ? [Object.fromEntries(named.map((name) => [name, null]))]
        : Array.from({ length: positional }, () => null);

    for (const step of statement.all(...bindings) as { detail: string }[]) {
        console.log(`  ${step.detail}`);
    }

    /**
     * Pages and time, but only with real values: a statement bound to nulls matches nothing,
     * and its cost would describe a query nobody runs. A JSON array for positional `?`, an
     * object for named parameters — the same shapes better-sqlite3 takes.
     */
    if (values !== undefined) {
        const parsed: unknown = JSON.parse(values);

        console.log("\nCost");
        measureStatement(database, sql, Array.isArray(parsed) ? parsed : [parsed]);
    } else if (named.length === 0 && positional === 0) {
        console.log("\nCost");
        measureStatement(database, sql, []);
    }
};

if (process.argv[2] === "--explain") {
    const sql = process.argv[3];

    if (!sql) {
        console.error(`usage: diagnose.js --explain "SELECT ..." ['["value", ...]']`);
        process.exit(2);
    }

    explain(sql, process.argv[4]);
} else if (process.argv[2] === "--cost") {
    runCost(process.argv[3]);
} else {
    main();
}

process.exit(0);
