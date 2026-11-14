import type { Database } from "better-sqlite3";

/**
 * What exporting a reel to an editor needs (§14d "Editor export").
 *
 * On `Media`, the exact frame rate, a variable-rate flag and the start timecode: the rounded
 * `fps` is right for display and a frame off every sixteen seconds on a timeline. Existing rows
 * stay NULL until re-probed, and the exporter falls back to snapping `fps` meanwhile.
 *
 * On `MediaRoot`, where the editing PC finds the library: a UNC share or mapped drive, written
 * into exported timelines and never read through.
 */
const COLUMNS: { table: string; name: string; definition: string }[] = [
    {
        table: "Media",
        name: "fpsNum",
        definition: `INTEGER CHECK("fpsNum" IS NULL OR "fpsNum" > 0)`,
    },
    {
        table: "Media",
        name: "fpsDen",
        definition: `INTEGER CHECK("fpsDen" IS NULL OR "fpsDen" > 0)`,
    },
    { table: "Media", name: "isVfr", definition: `INTEGER CHECK("isVfr" IS NULL OR "isVfr" = 1)` },
    {
        table: "Media",
        name: "timecodeStart",
        definition: `TEXT CHECK("timecodeStart" IS NULL OR length("timecodeStart") <= 20)`,
    },
    {
        table: "MediaRoot",
        name: "networkPath",
        definition: `TEXT CHECK("networkPath" IS NULL OR length("networkPath") <= 1024)`,
    },
];

const hasColumn = (db: Database, table: string, name: string): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE "name" = ?`).get(table, name) !==
    undefined;

export function up(db: Database): void {
    for (const column of COLUMNS) {
        if (!hasColumn(db, column.table, column.name)) {
            db.exec(
                `ALTER TABLE "${column.table}" ADD COLUMN "${column.name}" ${column.definition};`
            );
        }
    }
}

export function down(db: Database): void {
    for (const column of [...COLUMNS].reverse()) {
        if (hasColumn(db, column.table, column.name)) {
            db.exec(`ALTER TABLE "${column.table}" DROP COLUMN "${column.name}";`);
        }
    }
}
