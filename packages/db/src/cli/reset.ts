/**
 * `pnpm db:reset` — throw the local database away and rebuild it, derived files included.
 *
 * It used to be a `rimraf` of the three SQLite files, which left `art`, `variants` and `hls`
 * exactly as they were. Nothing ever read them again: media ids are fresh UUIDs, so a rescan
 * writes entirely new paths and the old tree becomes litter that only grows — 2.2 GB of it
 * after a handful of schema changes, referenced by nothing and reclaimed by nothing, because
 * the orphan sweep was only ever enqueued when a library was forgotten.
 *
 * So the invariant this command exists to restore is stated plainly: **after a reset, the
 * only files under `dataDir` are the ones the new database could account for** — which, for
 * an empty database, means none of the derived ones (§13d).
 *
 * **Captures go too, and they are irreplaceable.** They are emptied not in spite of that but
 * because of it: a reset destroys every `Media` row, media ids are fresh UUIDs, so no still
 * written before this point can ever be named again. They are not merely unreferenced
 * afterwards — they are unreferenceable, and the orphan sweep will never reclaim them
 * because it only visits items that exist. Keeping them produces exactly the growing litter
 * described above, with the added cruelty that it looks like the files were saved.
 *
 * So they are destroyed, and *counted and reported on their own line*. Destroying somebody's
 * work and destroying it silently are different failures, and only the first is intended.
 *
 * The bin is the one thing that survives, and it is the dangerous one: resetting destroys
 * the `TrashEntry` rows while leaving the bytes, and those bytes were removed from a media
 * root and exist nowhere else. Losing a capture loses work; losing a trashed file loses the
 * only copy of something the app did not create. An entry-less file in the bin can never be
 * restored or purged by anything — so rather than quietly producing that state, this
 * refuses and says what to do about it.
 */

import { rmSync } from "node:fs";

import { countFilesUnder, dataPaths, loadConfig, resetDataDirs } from "@private-stock/core/server";

import { initializeDatabase } from "../init.js";
import { markAllMigrationsApplied } from "../migrate.js";
import { HAS_RELEASED } from "../released.js";

if (HAS_RELEASED) {
    console.error(
        [
            "Refusing to reset: HAS_RELEASED is true.",
            "",
            "Databases exist on real installs holding real ratings, tags and clips, and this",
            "command deletes one without asking twice. Delete the file by hand if that is",
            "genuinely what you want.",
        ].join("\n")
    );
    process.exit(1);
}

const force = process.argv.includes("--force");
const config = loadConfig();
const paths = dataPaths(config);

const trashed = countFilesUnder(paths.trash);

if (trashed > 0 && !force) {
    console.error(
        [
            `Refusing to reset: ${trashed} file(s) are sitting in ${paths.trash}.`,
            "",
            "Those were moved out of a media root and exist nowhere else. Only a TrashEntry",
            "row knows where each one came from, and this command deletes those rows — after",
            "which the files can never be restored, and never purged either.",
            "",
            "Restore or empty the bin in the app first, or pass --force to accept the loss.",
        ].join("\n")
    );
    process.exit(1);
}

/**
 * The database first.
 *
 * Order matters if this is interrupted. A database with no artifacts rebuilds them; a tree of
 * artifacts with no database is the litter this command exists to stop producing.
 */
for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${paths.database}${suffix}`, { force: true });
}

// Counted before anything is deleted, so the line printed at the end describes what was
// actually lost rather than what a second walk of an emptied tree would find.
const captured = countFilesUnder(paths.captures);

let removed = 0;

for (const dir of resetDataDirs(config)) {
    removed += countFilesUnder(dir);
    // The directory itself goes too; `ensureDataDirs` recreates it on the next boot, and
    // leaving an empty tree of fan-out directories behind serves nobody.
    rmSync(dir, { recursive: true, force: true });
}

/**
 * Imported here rather than at the top, and this is load-bearing.
 *
 * `../db` opens the connection as a side effect of being imported, which creates the file. A
 * static import would therefore run *before* the deletions above and the script would delete
 * the database it had just made — leaving a live handle onto a path with nothing at it.
 */
const { db } = await import("../db.js");

try {
    initializeDatabase(db);
    markAllMigrationsApplied(db);

    console.log(`✓ Database reset; removed ${removed.toLocaleString()} file(s)`);

    if (captured > 0) {
        // On its own line because it is the only thing here that nothing can rebuild. The
        // derived count is housekeeping; this one is somebody's work.
        console.log(
            `  ${captured.toLocaleString()} of those were captured frames, which nothing regenerates.`
        );
    }

    if (trashed > 0) {
        console.log(
            `  ${trashed.toLocaleString()} trashed file(s) were kept and are now unreferenced.\n` +
                `  Delete ${paths.trash} by hand if they are not wanted.`
        );
    }

    process.exit(0);
} catch (error) {
    console.error("Database reset failed:", error);
    process.exit(1);
}
