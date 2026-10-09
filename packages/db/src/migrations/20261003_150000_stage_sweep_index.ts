import type { Database } from "better-sqlite3";

/**
 * The stage sweep's index, made covering and keyed the way the sweep actually asks (§20).
 *
 * The five-minute sweep asks, per stage, "which items have no current outcome?". The plain join
 * answered that by walking every active file, its link, its `Media` row and its stage row — about
 * 5,000 pages per stage on the real library, eight stages a pass, 4–5 s each on the NAS for an
 * answer that was almost always nothing. `mediaIdsNeedingStage` now finds the items owing a stage
 * first, by probing this index once per item in id order: one stage's slice of it is ~170 pages,
 * and with `Media`'s id index beside it the whole question is ~390 pages.
 *
 * It replaces `idx_MediaStage_stage_version`, which was described as the sweep's index and which
 * no plan used — the planner preferred the primary key, then read the row for the version. The
 * new one serves every `"stage" = ?` prefix the old one did, and keeps the number of indexes a
 * stage write maintains where it was. `(stage, mediaId)` never changes after insert, so an
 * upsert rewrites only the entry's trailing columns.
 */
export function up(db: Database): void {
    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_MediaStage_stage_mediaId"
            ON "MediaStage" ("stage", "mediaId", "version", "state", "attempts");
         DROP INDEX IF EXISTS "idx_MediaStage_stage_version";`
    );
}

export function down(db: Database): void {
    db.exec(
        `CREATE INDEX IF NOT EXISTS "idx_MediaStage_stage_version"
            ON "MediaStage" ("stage", "version");
         DROP INDEX IF EXISTS "idx_MediaStage_stage_mediaId";`
    );
}
