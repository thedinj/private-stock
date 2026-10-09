import type { Database } from "better-sqlite3";

/**
 * Transcoding's on/off moves into the stage policy (§7b, §8).
 *
 * It was `enabled` inside the `transcode` setting, saved with the encoder's quality and preset;
 * every other "does this run across the library" decision is an entry in `stages.policy`. The
 * flag becomes the `transcode` entry there, and leaves the transcode setting, which now describes
 * only the output.
 *
 * Data only: no table changes, so `init.ts` and the schema snapshot are untouched -- a fresh
 * database has no setting rows, and the default (off) is the same either way.
 *
 * A library that never switched transcoding on has no `enabled` to move and nothing changes;
 * one that switched it on keeps it on. Only a `true` is written, because only a deviation from
 * the default is stored in the policy (§7b).
 */

const TRANSCODE = "transcode";
const POLICY = "stages.policy";

const readJson = (db: Database, key: string): Record<string, unknown> | null => {
    const row = db.prepare(`SELECT "value" FROM "Setting" WHERE "key" = ?`).get(key) as
        { value: string } | undefined;

    if (!row) return null;

    try {
        const value: unknown = JSON.parse(row.value);

        return value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        // A corrupt value is left exactly as it is: the app already reads it as defaults.
        return null;
    }
};

const writeJson = (db: Database, key: string, value: Record<string, unknown>): void => {
    db.prepare(
        `INSERT INTO "Setting" ("key", "value", "updatedAt")
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT("key") DO UPDATE SET "value" = excluded."value",
                                          "updatedAt" = CURRENT_TIMESTAMP`
    ).run(key, JSON.stringify(value));
};

export function up(db: Database): void {
    const transcode = readJson(db, TRANSCODE);

    if (!transcode || !("enabled" in transcode)) return;

    const { enabled, ...rest } = transcode;

    writeJson(db, TRANSCODE, rest);

    if (enabled === true) {
        writeJson(db, POLICY, { ...(readJson(db, POLICY) ?? {}), [TRANSCODE]: true });
    }
}

export function down(db: Database): void {
    const policy = readJson(db, POLICY);

    if (!policy || !(TRANSCODE in policy)) return;

    const { [TRANSCODE]: enabled, ...rest } = policy;

    writeJson(db, POLICY, rest);
    writeJson(db, TRANSCODE, { ...(readJson(db, TRANSCODE) ?? {}), enabled: enabled === true });
}
