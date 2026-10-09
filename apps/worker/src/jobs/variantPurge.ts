import { rm } from "node:fs/promises";
import * as path from "node:path";

import { assertSafeRelativePath } from "@private-stock/core";
import { dataPaths, loadConfig } from "@private-stock/core/server";
import { db, jobRepo, variantRepo } from "@private-stock/db";

import type { JobRow } from "../queue.js";

/**
 * The `variantPurge` job: remove every web-safe rendition (§8).
 *
 * Queued when an admin switches transcoding off. Switching it off and leaving the renditions
 * where they are would be the worst of both: the feature is gone, and the disk it was
 * spending is still spent — which is usually the reason somebody switched it off.
 *
 * A job rather than work done inside the settings request. There can be tens of thousands of
 * these files; unlinking them one by one is not something a PUT should hold a connection
 * open for, and the web process has no business doing bulk filesystem work on a NAS.
 *
 * Everything here is recoverable by definition: a variant is a derived copy (§13d), and
 * turning transcoding back on re-queues whatever still cannot be played.
 */

/** Rows per pass. Small, so an interrupted purge resumes rather than restarts. */
const PURGE_BATCH = 200;

export const runVariantPurge = async (_job: JobRow, signal: AbortSignal): Promise<void> => {
    /**
     * Stop the encoders first.
     *
     * A transcode that finishes mid-purge writes a new rendition behind the sweep, and the
     * loop below would have already passed that row. Cancelling first means the only work
     * that can still land is the one job already inside its final rename, which the next pass
     * of the loop catches.
     */
    const cancelled = jobRepo.cancelAllTranscodes();

    if (cancelled > 0) {
        console.log(`Cancelled ${cancelled} transcode job(s) before purging renditions`);
    }

    const config = loadConfig();
    const variantRoot = dataPaths(config).variants;
    let removed = 0;
    let bytes = 0;

    for (;;) {
        if (signal.aborted) {
            console.log(`Variant purge stopped after ${removed} rendition(s)`);
            return;
        }

        const batch = variantRepo.listAny(PURGE_BATCH);

        if (batch.length === 0) {
            break;
        }

        for (const row of batch) {
            const absolutePath = path.resolve(config.dataDir, assertSafeRelativePath(row.relPath));

            /**
             * Never unlink outside the variants tree.
             *
             * The path comes out of the database, and a path read back from storage is
             * checked exactly like one that arrived over HTTP (§18.1). The row is dropped
             * either way: a variant pointing somewhere it should not is one this app must
             * stop believing in, whatever it names.
             */
            if (absolutePath.startsWith(variantRoot + path.sep)) {
                // `force` because the file being gone already is the outcome we want. A
                // half-restored backup, or a purge resumed after a crash, both land here.
                await rm(absolutePath, { force: true });
                bytes += row.bytes ?? 0;
            } else {
                console.warn(`Refusing to delete a variant outside ${variantRoot}: ${row.relPath}`);
            }

            removed += 1;
        }

        // One transaction per batch rather than one for the whole library: the files are
        // already gone, so the rows must follow promptly, and a long write transaction would
        // block the web process reading the same database.
        db.transaction(() => {
            for (const row of batch) {
                variantRepo.removeById(row.id);
            }
        })();
    }

    if (removed > 0) {
        console.log(
            `Purged ${removed} rendition(s), reclaiming about ${Math.round(bytes / 1_048_576)} MB`
        );
    }
};
