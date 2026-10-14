/**
 * Does a reader thread start and answer, from compiled output? (§20 "Reads off the thread")
 *
 *     node packages/db/dist/cli/readPoolCheck.js       # run by docker/smoke.sh
 *
 * The thread is loaded by plain Node from `dist/readThread.js`, through the same relative
 * imports and the same `better-sqlite3` resolution the container uses -- the combination vitest
 * never exercises, because under vitest the pool runs inline. A thread that cannot load fails
 * every plan sent to it, which is every grid page, so this is a boot check rather than a test.
 *
 * Asks one plan of each driver and requires the same answer, then one plan that begins by waiting
 * on another's work (`join`), which only a thread-backed driver can do. Exits non-zero otherwise.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { mediaQuerySchema } from "@private-stock/core";

import { getDb } from "../db.js";
import { runOffThread } from "../readPool.js";
import { join, read, runNow } from "../reads.js";

const entry = fileURLToPath(new URL("../readThread.js", import.meta.url));

if (!existsSync(entry)) {
    console.error(`no reader thread entry at ${entry}; run this from compiled output`);
    process.exit(1);
}

function* plan() {
    const total = yield* read("countMedia", mediaQuerySchema.parse({}), "smoke-user", [
        "smoke-root",
    ]);
    const tags = yield* read("tagsForMediaIds", ["smoke-item"], "smoke-user");

    return { total, tags };
}

const inline = getDb()
    .transaction(() => runNow(plan()))
    .deferred();
const offThread = await runOffThread(plan());

if (JSON.stringify(inline) !== JSON.stringify(offThread)) {
    console.error("the reader thread answered differently", { inline, offThread });
    process.exit(1);
}

console.log("reader thread answered", offThread);

function* sharing(other: Promise<string>) {
    return (yield* join(other)) ?? "did not wait";
}

const shared = await runOffThread(sharing(Promise.resolve("waited")));

if (shared !== "waited") {
    console.error("a plan off the thread did not wait on another's work", { shared });
    process.exit(1);
}

console.log("a plan off the thread waited on another's work");
