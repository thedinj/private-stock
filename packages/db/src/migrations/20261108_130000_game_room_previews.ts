import type { Database } from "better-sqlite3";

/**
 * The Game Room's hover previews are cut again, from each recording's last seconds (§21 "Where a
 * room looks first").
 *
 * Data only. A recipe version bump would have re-rendered every preview in every room -- the
 * Cellar's whole library, for a change that is not about it. So only the outcomes of items in a
 * `games` library are marked below every version, which is how the sweep reads "owed again"
 * (`o."version" >= :version` in `stageRepo`). The old preview stays on its tile until the new one
 * replaces it.
 *
 * Idempotent: a row already at 0 is set to 0. Nothing to undo -- the previews it causes to be
 * rebuilt are the current recipe's either way.
 */
export function up(db: Database): void {
    db.exec(
        `UPDATE "MediaStage" SET "version" = 0
          WHERE "stage" = 'preview'
            AND "mediaId" IN (
                SELECT m."id" FROM "Media" m
                  JOIN "MediaRoot" r ON r."id" = m."listRootId"
                 WHERE r."domain" = 'games'
            );`
    );
}

export function down(): void {
    // Nothing to put back: see above.
}
