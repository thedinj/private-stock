import { db } from "../db.js";

/**
 * Runtime settings (§12b).
 *
 * Everything an admin might change lives here rather than in `config.json`, so nobody has
 * to SSH into a NAS to alter a scan interval. Values are JSON; callers validate with a zod
 * schema on the way in and out.
 */

export const getRaw = (key: string): string | undefined => {
    const row = db.prepare(`SELECT "value" FROM "Setting" WHERE "key" = ?`).get(key) as
        { value: string } | undefined;

    return row?.value;
};

export const get = <T>(key: string, fallback: T): T => {
    const raw = getRaw(key);
    if (raw === undefined) {
        return fallback;
    }

    try {
        return JSON.parse(raw) as T;
    } catch {
        // A corrupt value must not take the app down; the fallback keeps it serving and the
        // admin page shows the stored text.
        return fallback;
    }
};

export const set = (key: string, value: unknown): void => {
    db.prepare(
        `INSERT INTO "Setting" ("key", "value", "updatedAt")
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT("key") DO UPDATE SET "value" = excluded."value", "updatedAt" = CURRENT_TIMESTAMP`
    ).run(key, JSON.stringify(value));
};

export const all = (): Record<string, string> => {
    const rows = db.prepare(`SELECT "key", "value" FROM "Setting"`).all() as {
        key: string;
        value: string;
    }[];

    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
};
