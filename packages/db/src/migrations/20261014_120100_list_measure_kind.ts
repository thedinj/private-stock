import type { Database } from "better-sqlite3";

/**
 * The five measure indexes carry `kind` after `id`, so a walk filtered by a measure never reads a
 * row (§14e, §20 "The disk, not the CPU").
 *
 * `idx_Media_list_duration`, `_size`, `_resolution`, `_bitrate` and `_fps` serve their sort and
 * their range filter, and held the sort value and `id` alone. Everything that also asks the item's
 * kind -- a shuffle's kept order, which keeps each slot's kind; a kind tab's count; a kind tab
 * sorted by one of them -- therefore read each candidate's row for one column. On the production
 * replica a shuffle of anything over ten minutes was 1,177 pages, over 1080p 1,584, over 5 Mbps
 * 1,593, over 500 MB 1,106 and over 50 fps 595, against 275 for the videos with no filter at all.
 *
 * After `id`, not before it: `id` is unique, so a column after it changes nothing about the order
 * the index is walked in, and every sort these serve keeps its plan.
 *
 * Idempotent: each index is replaced under its own name, so nothing that names one changes, and a
 * database built by `init.ts` simply has them rebuilt as they already were.
 */
const INDEXES: [name: string, column: string][] = [
    ["idx_Media_list_duration", `"durationMs"`],
    ["idx_Media_list_size", `"listSize"`],
    ["idx_Media_list_resolution", `MIN("width", "height")`],
    ["idx_Media_list_bitrate", `"bitrate"`],
    ["idx_Media_list_fps", `"fps"`],
];

const rebuild = (db: Database, trailing: string): void => {
    for (const [name, column] of INDEXES) {
        db.exec(
            `DROP INDEX IF EXISTS "${name}";
             CREATE INDEX IF NOT EXISTS "${name}"
                 ON "Media" ("listRootId", ${column}, "id"${trailing}) WHERE "listable" = 1;`
        );
    }
};

export function up(db: Database): void {
    rebuild(db, `, "kind"`);
}

export function down(db: Database): void {
    rebuild(db, "");
}
