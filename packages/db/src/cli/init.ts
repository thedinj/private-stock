/**
 * `pnpm db:init` — build the current schema directly on an empty database.
 *
 * A freshly initialised database already reflects every migration ever written, so every
 * migration is stamped as applied. Skipping that would leave `db:migrate` trying to
 * re-apply changes the schema already has.
 *
 * Unlike `db:reset` this deletes nothing. It will, however, say so when it has just created
 * an empty database beside a `/data` full of artifacts belonging to a database that no longer
 * exists — because that is drift (§13d), and drift nobody mentions is drift nobody fixes.
 */

import { countDerivedFiles, loadConfig } from "@private-stock/core/server";

import { db } from "../db.js";
import { initializeDatabase } from "../init.js";
import { markAllMigrationsApplied } from "../migrate.js";

try {
    const fresh = (db.prepare(`SELECT count(*) AS n FROM sqlite_master`).get() as { n: number }).n;

    initializeDatabase(db);
    markAllMigrationsApplied(db);

    console.log("✓ Database initialised");

    // Only worth saying for a database that had nothing in it: re-running init over a
    // populated one is a no-op, and its artifacts belong to it.
    if (fresh === 0) {
        const stray = countDerivedFiles(loadConfig());

        if (stray > 0) {
            console.log(
                `\n  Note: ${stray.toLocaleString()} derived file(s) are already under your data` +
                    ` directory,\n  and this database references none of them. The worker's orphan` +
                    ` sweep will\n  remove them shortly after it starts. Use \`pnpm db:reset\` to` +
                    ` clear them now.`
            );
        }
    }

    process.exit(0);
} catch (error) {
    console.error("Database initialisation failed:", error);
    process.exit(1);
}
