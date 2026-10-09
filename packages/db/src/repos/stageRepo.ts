import { randomUUID } from "node:crypto";

import {
    prerequisiteOf,
    requestedPriority,
    type StageDefinition,
    type StageRow,
    type StageState,
} from "@private-stock/core";

import { db } from "../db.js";

/**
 * What has been done to each item (§7b).
 *
 * The single place the pipeline records an outcome and the single place it asks what is left,
 * replacing four conventions and five hand-written queries. Adding a capability is a registry
 * entry and a job handler; nothing here changes.
 */

export interface RecordStageInput {
    mediaId: string;
    stage: string;
    version: number;
    state: StageState;
    /** Short reason, shown in the admin view. Truncated rather than rejected. */
    detail?: string | null;
    requestedByUserId?: string | null;
    /**
     * A floor under the failure count, for a failure retrying cannot fix. Set to the stage's
     * `maxAttempts`, it settles the stage now rather than leaving the sweep to offer the item
     * again until the count gets there on its own.
     */
    minimumAttempts?: number;
    /** Which configuration produced the outcome, where that varies (`StageRow.recipe`). */
    recipe?: string | null;
}

/**
 * Records how an attempt ended.
 *
 * `attempts` accumulates only across *failures*. A success that follows two failures resets
 * it, because the count exists to stop retrying something that cannot work — and a stage that
 * has just worked plainly can. Without the reset, a file that failed twice for a transient
 * reason would be permanently one failure away from being abandoned.
 */
export const record = (input: RecordStageInput): void => {
    db.prepare(
        `INSERT INTO "MediaStage"
             ("mediaId", "stage", "version", "state", "attempts", "detail",
              "requestedByUserId", "recipe", "at")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT("mediaId", "stage") DO UPDATE SET
             "version" = excluded."version",
             "state" = excluded."state",
             "attempts" = CASE
                 WHEN excluded."state" = 'failed'
                     THEN MAX("MediaStage"."attempts" + 1, excluded."attempts")
                 ELSE 0
             END,
             "detail" = excluded."detail",
             "requestedByUserId" = excluded."requestedByUserId",
             -- A failure says nothing about which settings the stored output came from.
             "recipe" = CASE WHEN excluded."state" = 'failed'
                             THEN "MediaStage"."recipe" ELSE excluded."recipe" END,
             "at" = CURRENT_TIMESTAMP`
    ).run(
        input.mediaId,
        input.stage,
        input.version,
        input.state,
        input.state === "failed" ? Math.max(1, input.minimumAttempts ?? 1) : 0,
        input.detail?.slice(0, 500) ?? null,
        input.requestedByUserId ?? null,
        input.recipe ?? null
    );
};

/**
 * Forgets an item's failures, because the file behind them has changed.
 *
 * A failure is evidence about particular bytes. When the scanner sees different ones, the
 * record describes a file that is no longer there — most often a download that was caught
 * half-written and has since finished — and leaving it would keep the sweep away from the item
 * for good. Only failures: a finished stage is the probe chain's business, and redoing every
 * artifact whenever a file's mtime moves is a different decision.
 */
export const clearFailures = (mediaId: string): void => {
    db.prepare(`DELETE FROM "MediaStage" WHERE "mediaId" = ? AND "state" = 'failed'`).run(mediaId);
};

export const find = (mediaId: string, stage: string): StageRow | undefined =>
    db
        .prepare(
            `SELECT "mediaId", "stage", "version", "state", "attempts", "detail",
                    "requestedByUserId", "at", "recipe"
               FROM "MediaStage" WHERE "mediaId" = ? AND "stage" = ?`
        )
        .get(mediaId, stage) as StageRow | undefined;

/** Everything known about one item, for the detail and admin views. */
export const listForMedia = (mediaId: string): StageRow[] =>
    db
        .prepare(
            `SELECT "mediaId", "stage", "version", "state", "attempts", "detail",
                    "requestedByUserId", "at", "recipe"
               FROM "MediaStage" WHERE "mediaId" = ? ORDER BY "stage"`
        )
        .all(mediaId) as StageRow[];

export interface PendingItem {
    id: string;
    fileId: string;
    kind: "image" | "video";
}

/**
 * The conditions shared by "which items need this stage" and "how many of them are there".
 *
 * Shared fragments, because the two must select the same population. A count that disagreed with
 * the work would put a number on the admin screen that the sweep then contradicts, and the
 * screen is the only thing telling somebody how large a commitment they are about to make
 * (§7b).
 *
 * **The items owing the stage are found first, from indexes, before any row is read** (§20).
 * Once a library has caught up nearly every item has a current outcome, and the plain join
 * walked every file, link, `Media` row and stage row to discover that — ~5,000 pages per stage
 * on the real library, every five minutes, 4–5 s each on the NAS for an empty answer. `owing` is
 * the listable items' id index probed against `idx_MediaStage_stage_mediaId` in id order, ~390
 * pages, and only what survives is joined. `MATERIALIZED` keeps the planner from flattening it
 * back into the walk, and `INDEXED BY` from choosing the primary key and then reading every stage
 * row for its version.
 *
 * `owing` is the whole rule about the stage row: the exact negation of "a row at the current
 * version that is not a retryable failure", for the one row an item can have per stage. The
 * `needsWork` agreement test holds it to that. There used to be a second, positive statement of
 * the same rule joined on afterwards, which re-read every owed item's stage row to learn nothing.
 *
 * `listable` narrows the walk to the items the file conditions below can accept — it is the
 * trigger-maintained copy of exactly those conditions (§20) — and the conditions still run on
 * what survives, so they remain the definition.
 *
 * **The sweep also leaves out what is already queued** (`unqueued`), since enqueuing it again is
 * a no-op. While a stage drains, nearly everything it owes is in the queue: production read the
 * Media, link and file rows of 500 queued items every five minutes to enqueue none of them. The
 * probe is phrased against `idx_Job_pending_unique`, which holds only live jobs; the unary `+`
 * drops the column's affinity so the comparison can use the index's expression. The count does
 * not leave them out — a queued item still owes the stage until its job lands.
 *
 * A stage for one kind walks `idx_Media_listable_id_kind`, so the other kind is left out from
 * the index too. Filtered after the walk, every photograph owed a preview — none ever has a row,
 * since the stage does not apply — and each one's row was read to learn its kind: ~1,500 pages
 * for the preview and sprite sweeps on the replica, every pass, against ~350 this way.
 */
const listableWalk = (stage: StageDefinition): string => {
    if (stage.appliesTo === "all") {
        return `"Media" e INDEXED BY "idx_Media_listable_id" WHERE e."listable" = 1`;
    }

    // From the registry, never user input -- the same as `registryClause`.
    const kind = stage.appliesTo === "video" ? "video" : "image";

    return `"Media" e INDEXED BY "idx_Media_listable_id_kind"
             WHERE e."listable" = 1 AND e."kind" = '${kind}'`;
};

const owing = (stage: StageDefinition, unqueued: boolean): string => `
    WITH "owing" AS MATERIALIZED (
        SELECT e."id" FROM ${listableWalk(stage)}
           AND NOT EXISTS (
             SELECT 1 FROM "MediaStage" o INDEXED BY "idx_MediaStage_stage_mediaId"
              WHERE o."stage" = :stage AND o."mediaId" = e."id"
                AND o."version" >= :version
                AND NOT (o."state" = 'failed'
                         AND (:maxAttempts < 0 OR o."attempts" < :maxAttempts)))
           ${
               unqueued
                   ? `AND NOT EXISTS (
             SELECT 1 FROM "Job" q INDEXED BY "idx_Job_pending_unique"
              WHERE q."kind" = :stage AND COALESCE(q."mediaId", '') = +e."id"
                AND q."state" IN ('pending', 'claimed'))`
                   : ""
           })
`;

/** The file conditions, which `owing` only approximates through `listable`. */
const ORIGINAL_FILE = `
    CROSS JOIN "MediaFileLink" fl ON fl."mediaId" = m."id" AND fl."role" = 'original'
    CROSS JOIN "MediaFile" f ON f."id" = fl."fileId"
   WHERE f."state" = 'active' AND f."classification" = 'media'
`;

/**
 * The registry's own filters -- the item's kind, and whether it must be probed first -- inlined
 * because they come from the registry and can never be user input.
 *
 * An item waiting on its probe is not counted as owing the stage: it does not, yet, and a file
 * the probe cannot read never will. Counting it would hold a progress bar short of done by
 * exactly the files nothing can be made from.
 */
const registryClause = (stage: StageDefinition): string =>
    [
        stage.appliesTo === "all"
            ? ""
            : `AND m."kind" = '${stage.appliesTo === "video" ? "video" : "image"}'`,
        stage.needsProbe ? `AND m."probedAt" IS NOT NULL` : "",
        prerequisiteClause(stage),
    ].join(" ");

/**
 * An item whose prerequisite (`requires`) has not settled does not owe the stage yet — the
 * same reasoning as the probe above, and the same consequence if it were counted: a bar held
 * short by items nothing can be made from yet.
 *
 * Settled is `needsWork`'s negation for the prerequisite: a row at its current version that is
 * not a retryable failure. One clause per kind the stage names a prerequisite for; a kind it
 * names none for passes. Inlined from the registry, like the rest of this clause.
 */
const prerequisiteClause = (stage: StageDefinition): string =>
    (["image", "video"] as const)
        .map((kind) => {
            const prerequisite = prerequisiteOf(stage, kind);

            if (!prerequisite) {
                return "";
            }

            const maxAttempts = prerequisite.maxAttempts ?? -1;

            return `AND (m."kind" <> '${kind}' OR EXISTS (
                SELECT 1 FROM "MediaStage" p
                 WHERE p."mediaId" = m."id" AND p."stage" = '${prerequisite.name}'
                   AND p."version" >= ${prerequisite.version}
                   AND NOT (p."state" = 'failed'
                            AND (${maxAttempts} < 0 OR p."attempts" < ${maxAttempts}))))`;
        })
        .join(" ");

/**
 * Parameters both queries bind. `maxAttempts` uses a negative sentinel rather than NULL:
 * SQL comparisons against NULL are never true, so `attempts < NULL` would silently mean
 * "never retry" -- the exact opposite of what `maxAttempts: null` asks for.
 */
const stageParams = (stage: StageDefinition) => ({
    stage: stage.name,
    version: stage.version,
    maxAttempts: stage.maxAttempts ?? -1,
});

/**
 * How many items still need this stage (§7b).
 *
 * For the admin screen, which has to show the size of the commitment before somebody agrees
 * to it: "enable OCR" and "enable OCR on eighteen thousand files" are different decisions.
 *
 * An exact count is a scan of the matching set (§20), which is why the caller asks for it
 * only where a decision is actually pending rather than for every stage on the page.
 */
export const countMediaNeedingStage = (stage: StageDefinition): number =>
    (
        db
            .prepare(
                `${owing(stage, false)}
                 SELECT COUNT(*) AS n
                   FROM "owing" w
                  CROSS JOIN "Media" m ON m."id" = w."id"
                  ${ORIGINAL_FILE} ${registryClause(stage)}`
            )
            .get(stageParams(stage)) as { n: number }
    ).n;

/**
 * Items still needing a stage, and not already queued for it.
 *
 * One query for every capability, where there used to be one per capability. The conditions
 * are the SQL form of `needsWork` in `@private-stock/core`, and the two are checked against
 * each other by a test — a divergence would mean the sweep selects work the worker then
 * declines to do, which spins without ever reporting an error.
 *
 * `appliesTo` is enforced here rather than by recording `skipped` for every photograph in the
 * library: a sprite sheet for a still image is not work that was skipped, it is work that was
 * never applicable, and writing 200k rows to say so would be worse than useless.
 *
 * **Ordered and cut before the link and file are read** (§20). Newest first needs every owed
 * item's `addedAt`, so each owed row is read once; the link and file are read only for the batch
 * that survives the cut. Joined all the way first, a stage owing 1,700 items read three rows for
 * each to keep 500 — ~2,000 pages a pass on the replica, ~1,050 this way. The file conditions
 * are rechecked on the batch, so an item whose `listable` were ever wrong would be left out of
 * this pass rather than queued.
 */
export const mediaIdsNeedingStage = (stage: StageDefinition, limit = 500): PendingItem[] =>
    db
        .prepare(
            `${owing(stage, true)},
             "picked" AS MATERIALIZED (
                 SELECT m."id", m."kind", m."addedAt"
                   FROM "owing" w
                  CROSS JOIN "Media" m ON m."id" = w."id"
                  WHERE 1 ${registryClause(stage)}
                  ORDER BY m."addedAt" DESC
                  LIMIT :limit)
             SELECT m."id", fl."fileId", m."kind"
               FROM "picked" m
               ${ORIGINAL_FILE}
              ORDER BY m."addedAt" DESC`
        )
        .all({ ...stageParams(stage), limit }) as PendingItem[];

/**
 * The newest item's rowid: the sweep's sign that items have arrived since it last looked.
 *
 * One descent to the end of the table. A new item owes every stage that does not wait for the
 * probe the moment it exists, and the rest once its probe lands (`newestOutcome`).
 */
export const newestItem = (): number =>
    (
        db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS "mark" FROM "Media"`).get() as {
            mark: number;
        }
    ).mark;

/**
 * The newest rowid among one stage's outcomes of one state, at one version.
 *
 * One descent of `idx_MediaStage_stage_state_version`, whose entries for a (stage, state,
 * version) are in rowid order — the rowid is every index's implicit last column — so the maximum
 * is the last entry of that range. No index of its own: one on `("stage")` would give the same
 * answer and cost a write on every new stage row, which is every job's first outcome. A new
 * outcome is always written at the registry's version, so the current version is the only one
 * a new row can appear under.
 */
export const newestOutcome = (stage: string, state: StageState, version: number): number =>
    (
        db
            .prepare(
                `SELECT COALESCE(MAX(rowid), 0) AS "mark"
                   FROM "MediaStage" INDEXED BY "idx_MediaStage_stage_state_version"
                  WHERE "stage" = ? AND "state" = ? AND "version" = ?`
            )
            .get(stage, state, version) as { mark: number }
    ).mark;

export interface StageSummaryRow {
    stage: string;
    state: StageState;
    version: number;
    count: number;
}

/**
 * How the library stands, per stage (§13c).
 *
 * The number an admin page exists to show: how much is done, how much produced nothing, and
 * how much failed — which was not answerable at all before, because "not done" and "nothing
 * to do" looked identical.
 *
 * `version` is grouped rather than ignored because it is what makes the answer stay true
 * after a recipe improves. The sweep redoes any row below the registry's current version, so
 * without this column every one of those still reads as settled and the bar sits at 100% for
 * the entire duration of the resweep. `stageProgress` in @private-stock/core does that
 * comparison; this just has to avoid summing the distinction away.
 *
 * **Only items the library still shows**, which is the population `countProcessable` divides
 * by. A `MediaStage` row outlives its item being trashed or archived, and counting those put
 * `13,209 / 13,028` on the index bar.
 *
 * Read from `MediaStageTally`, which the schema's triggers keep per (stage, state, version) for
 * listable items only, rather than counted. Counting was a scan of every stage row plus a
 * subtraction of the unlisted items' rows -- ~3,200 pages on the real library, 10 s on the NAS,
 * on the thread that serves every request. The tally is a page or two at any library size, and
 * the stage-row writes that maintain it touch one row of a ~20-row table (§13c, §20).
 */
export const summary = (): StageSummaryRow[] =>
    db
        .prepare(
            `SELECT "stage", "state", "version", "count"
               FROM "MediaStageTally"
              WHERE "count" > 0
              ORDER BY "stage", "state", "version"`
        )
        .all() as StageSummaryRow[];

/**
 * Runs a stage for one item, because someone asked.
 *
 * Deliberately ignores whatever was recorded before. An explicit request is a new decision,
 * not a retry -- so a stage that previously found nothing, was skipped, or exhausted its
 * attempts runs again on request, and the attempt counter starts clean.
 *
 * **The outcome row is kept until the new one replaces it.** This used to delete it, which
 * made asking look like nothing had happened -- the ledger fell back to "on request", exactly
 * what it said before the click -- and made asking *again* look like losing the answer: the
 * text already read out of a file vanished from its panel until the new pass finished, though
 * nothing had removed it. What is on its way is the queue's to say (`jobRepo.liveForMedia`);
 * what last happened stays true until something else has.
 *
 * A job the sweep already queued for this item is taken over rather than duplicated. The
 * queue allows one live job per kind and item, so without this a request for an item the
 * backfill had reached would wait behind the rest of the backfill at the sweep's priority,
 * and still under the throttle -- asked for, and not treated as asked for.
 *
 * This is the path an on-demand capability uses, and the reason the registry distinguishes
 * `onDemand` from `automatic`: an expensive stage can exist and be runnable per item long
 * before -- or without ever -- being swept across the library.
 */
export const requestStage = (
    mediaId: string,
    stage: StageDefinition,
    fileId: string | null,
    requestedByUserId: string
): void => {
    // Ahead of all automatic work, not only this stage's sweep (`requestedPriority`).
    const priority = requestedPriority(stage);

    db.transaction(() => {
        // Counter only: the state and its time are the last real outcome, and the new one
        // overwrites them through `record` when it lands.
        db.prepare(
            `UPDATE "MediaStage" SET "attempts" = 0 WHERE "mediaId" = ? AND "stage" = ?`
        ).run(mediaId, stage.name);

        // Still pending only: a claimed job is already running, and will be finished before
        // anything done to its row here could matter.
        db.prepare(
            `UPDATE "Job"
                SET "priority" = min("priority", ?),
                    "requestedByUserId" = COALESCE("requestedByUserId", ?),
                    "updatedAt" = CURRENT_TIMESTAMP
              WHERE "kind" = ? AND "mediaId" = ? AND "state" = 'pending'`
        ).run(priority, requestedByUserId, stage.name, mediaId);

        db.prepare(
            `INSERT INTO "Job"
                 ("id", "kind", "mediaId", "fileId", "payloadJson", "priority",
                  "requestedByUserId", "mediaAddedAt", "updatedAt")
             -- The same ordering key the sweep's own jobs carry (§7d). A requested job
             -- outranks them on priority anyway; this keeps two requests for different items
             -- in the order the library shows them.
             SELECT ?, ?, ?, ?, ?, ?, ?,
                    (SELECT "addedAt" FROM "Media" WHERE "id" = ?), CURRENT_TIMESTAMP
              WHERE NOT EXISTS (
                  SELECT 1 FROM "Job"
                   WHERE "kind" = ? AND "mediaId" = ?
                     AND "state" IN ('pending', 'claimed')
              )`
        ).run(
            randomUUID(),
            stage.name,
            mediaId,
            fileId,
            // Carried on the job rather than written now: the row records an *outcome*, and
            // "queued" is not one. Writing a placeholder state would either lie about having
            // run or, worse, mark it failed -- which is what an earlier draft of this did, and
            // it would have shown every requested pass as a failure in the admin view.
            JSON.stringify({ requestedByUserId }),
            // Ahead of every kind of automatic work: someone is waiting for this one.
            priority,
            // The same fact as a column, because the throttle has to read it before the job
            // is claimed (§7c): requested work is exempt, and the payload is opaque to the
            // claim query. Priority cannot stand in for it: it decides the order work is
            // claimed in, not which limits apply, and a priority band is not a fact about who
            // asked.
            requestedByUserId,
            mediaId,
            stage.name,
            mediaId
        );
    })();
};

/**
 * Outcomes produced under a configuration that has since changed (§5d "What happens when OCR
 * settings change"), counted for the settings page.
 *
 * Only settled outcomes: a failure produced nothing to be out of date. An outcome from before
 * recipes were recorded counts as `unrecordedAs` — for OCR, the revision the defaults are —
 * rather than as older by definition. Only items still in the library, because re-reading what
 * has been trashed would be work for nothing.
 *
 * `reviewed` is how many of those carry text somebody has reviewed, which a re-read keeps.
 */
export const countOutdated = (
    stage: string,
    recipe: string,
    unrecordedAs: string
): { items: number; reviewed: number } =>
    db
        .prepare(
            `SELECT COUNT(*) AS "items",
                    COALESCE(SUM(EXISTS (
                        SELECT 1 FROM "MediaText" t
                         WHERE t."mediaId" = s."mediaId" AND t."reviewState" IS NOT NULL
                    )), 0) AS "reviewed"
               FROM "MediaStage" s
               JOIN "Media" m ON m."id" = s."mediaId" AND m."listable" = 1
              WHERE s."stage" = ? AND s."state" IN ('done', 'empty')
                AND COALESCE(s."recipe", ?) != ?`
        )
        .get(stage, unrecordedAs, recipe) as { items: number; reviewed: number };

/**
 * Queue a batch of out-of-date outcomes to be produced again, continuing after `after`.
 *
 * **Background work, not a request.** At the stage's own priority and with no requester, so
 * the jobs wait their turn behind everything else and respect the working window (§7c). A
 * library-wide re-read is exactly the work the window exists for, and marking it requested
 * would put hours of CPU ahead of covers somebody is waiting on.
 *
 * Keyed on `mediaId`, so a caller loops batch by batch and can stop between them. Items that
 * already have a job queued or running are skipped by the queue's own uniqueness.
 */
export const queueOutdated = (
    stage: StageDefinition,
    recipe: string,
    unrecordedAs: string,
    after: string | null,
    limit: number
): { queued: number; next: string | null } => {
    const rows = db
        .prepare(
            `SELECT s."mediaId" AS "mediaId", fl."fileId" AS "fileId"
               FROM "MediaStage" s
               JOIN "Media" m ON m."id" = s."mediaId" AND m."listable" = 1
               JOIN "MediaFileLink" fl ON fl."mediaId" = s."mediaId" AND fl."role" = 'original'
              WHERE s."stage" = ? AND s."state" IN ('done', 'empty')
                AND COALESCE(s."recipe", ?) != ?
                AND s."mediaId" > ?
              ORDER BY s."mediaId"
              LIMIT ?`
        )
        .all(stage.name, unrecordedAs, recipe, after ?? "", limit + 1) as {
        mediaId: string;
        fileId: string;
    }[];

    const batch = rows.slice(0, limit);
    const insert = db.prepare(
        `INSERT INTO "Job"
             ("id", "kind", "mediaId", "fileId", "priority", "mediaAddedAt", "updatedAt")
         VALUES (?, ?, ?, ?, ?, (SELECT "addedAt" FROM "Media" WHERE "id" = ?), CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING`
    );

    let queued = 0;

    db.transaction(() => {
        for (const row of batch) {
            queued += insert.run(
                randomUUID(),
                stage.name,
                row.mediaId,
                row.fileId,
                stage.priority,
                row.mediaId
            ).changes;
        }
    })();

    return {
        queued,
        next: rows.length > limit ? (batch[batch.length - 1]?.mediaId ?? null) : null,
    };
};

export interface SettledFailureRow {
    mediaId: string;
    fileId: string;
    /** The open trash entry, on the trash side. */
    entryId: string | null;
    title: string;
    rootLabel: string;
    relPath: string;
    bytes: number;
    detail: string | null;
    at: string;
    writable: 1 | null;
    /** Trash tab only: the open entry's move has not finished. */
    moving: 0 | 1;
}

export interface SettledFailureFilter {
    /** In the library, or moved to the trash and not yet purged or restored. */
    place: "library" | "trash";
    rootIds: string[];
    /** Only these items, for acting on a selection with the list's own rules. */
    mediaIds?: string[];
}

/** Resume after this row, in the list's order: largest first, then by id. */
export interface SettledFailureCursor {
    bytes: number;
    mediaId: string;
}

/**
 * The FROM and WHERE both queries share, so the summary counts what the list pages through.
 *
 * Driven from `idx_MediaStage_failed`, which holds only failures, so the cost is the failures
 * and not the library; everything else joins by key. Settled is the sweep's own rule turned
 * round: at the current version, out of attempts. A row below the version is about to be tried
 * again and is not settled at all. A stage with no attempt limit never settles, and is never
 * listed.
 *
 * The trash side requires an open entry that is the bin's -- an identical copy's entry (§10e)
 * is deleted outright by its own job and is not anyone's to purge.
 */
const settledFailureFrom = (
    stage: StageDefinition,
    filter: SettledFailureFilter
): { sql: string; params: Record<string, unknown> } => {
    const roots = filter.rootIds.map((_, i) => `:root${i}`).join(", ") || "NULL";
    const only = filter.mediaIds
        ? `AND s."mediaId" IN (${filter.mediaIds.map((_, i) => `:media${i}`).join(", ") || "NULL"})`
        : "";
    const placeClause =
        filter.place === "library"
            ? `AND f."state" = 'active'`
            : `AND f."state" = 'trashed' AND t."id" IS NOT NULL AND t."twinFileId" IS NULL`;

    return {
        sql: `
            FROM "MediaStage" s INDEXED BY "idx_MediaStage_failed"
            JOIN "MediaFileLink" fl ON fl."mediaId" = s."mediaId" AND fl."role" = 'original'
            JOIN "MediaFile" f ON f."id" = fl."fileId"
            JOIN "Media" m ON m."id" = s."mediaId"
            JOIN "MediaRoot" r ON r."id" = f."rootId"
            LEFT JOIN "TrashEntry" t INDEXED BY "idx_TrashEntry_open_fileId"
                   ON t."fileId" = f."id" AND t."restoredAt" IS NULL AND t."purgedAt" IS NULL
           WHERE s."stage" = :stage AND s."state" = 'failed'
             AND s."attempts" >= :maxAttempts AND s."version" >= :version
             AND f."rootId" IN (${roots})
             ${placeClause}
             ${only}`,
        params: {
            stage: stage.name,
            // A stage that never stops retrying never settles: no attempt count reaches this.
            maxAttempts: stage.maxAttempts ?? Number.MAX_SAFE_INTEGER,
            version: stage.version,
            ...Object.fromEntries(filter.rootIds.map((id, i) => [`root${i}`, id])),
            ...Object.fromEntries((filter.mediaIds ?? []).map((id, i) => [`media${i}`, id])),
        },
    };
};

/**
 * Items whose stage failed and will not be tried again, largest first (§10g).
 *
 * Largest first because the list exists to give space back, and the cursor is the size and id
 * of the last row so a page resumes where the last one ended whatever was removed meanwhile.
 * One row more than asked for says whether there is a next page.
 */
export const listSettledFailures = (
    stage: StageDefinition,
    filter: SettledFailureFilter,
    after: SettledFailureCursor | null,
    limit: number
): { rows: SettledFailureRow[]; next: SettledFailureCursor | null } => {
    const { sql, params } = settledFailureFrom(stage, filter);
    const rows = db
        .prepare(
            `SELECT m."id" AS "mediaId", f."id" AS "fileId", t."id" AS "entryId", m."title",
                    r."label" AS "rootLabel", f."relPath", f."size" AS "bytes", s."detail",
                    s."at", r."writable",
                    CASE WHEN t."id" IS NOT NULL AND t."movedAt" IS NULL
                         THEN 1 ELSE 0 END AS "moving"
             ${sql}
             ${after ? `AND (f."size" < :afterBytes OR (f."size" = :afterBytes AND m."id" > :afterId))` : ""}
             ORDER BY f."size" DESC, m."id"
             LIMIT :limit`
        )
        .all({
            ...params,
            // Bound as a number: a size compared against text sorts as text (§4).
            ...(after ? { afterBytes: after.bytes, afterId: after.mediaId } : {}),
            limit: limit + 1,
        }) as SettledFailureRow[];

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
        rows: page,
        next: rows.length > limit && last ? { bytes: last.bytes, mediaId: last.mediaId } : null,
    };
};

/** How many there are and how much they hold, over the same population the list pages. */
export const summarizeSettledFailures = (
    stage: StageDefinition,
    filter: SettledFailureFilter
): { count: number; bytes: number } => {
    const { sql, params } = settledFailureFrom(stage, filter);

    return db
        .prepare(`SELECT count(*) AS "count", COALESCE(sum(f."size"), 0) AS "bytes" ${sql}`)
        .get(params) as { count: number; bytes: number };
};
