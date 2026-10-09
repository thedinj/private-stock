import type { Database } from "better-sqlite3";

/**
 * The probe becomes a registry stage (§7b), and the library's existing probes are recorded as
 * done under it.
 *
 * Data only. Without it the sweep reads every probed item as owing a probe and re-reads the
 * whole library -- and each probe chains a cover, a hash and an index job behind it, so that
 * would have been the library's covers rendered a second time for nothing. `probedAt` is the
 * record of what already happened, so it is copied rather than redone.
 *
 * Items with no `probedAt` get no row, which is what makes the sweep try them: the ones whose
 * probe dead-lettered before a failure was remembered anywhere are exactly the ones owed.
 *
 * Idempotent through `INSERT OR IGNORE` on the (mediaId, stage) key.
 */
export function up(db: Database): void {
    db.exec(
        `INSERT OR IGNORE INTO "MediaStage" ("mediaId", "stage", "version", "state", "attempts", "at")
         SELECT "id", 'probe', 1, 'done', 1, "probedAt" FROM "Media" WHERE "probedAt" IS NOT NULL;`
    );
}

export function down(db: Database): void {
    db.exec(`DELETE FROM "MediaStage" WHERE "stage" = 'probe';`);
}
