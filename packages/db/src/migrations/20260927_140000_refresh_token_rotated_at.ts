import type { Database } from "better-sqlite3";

/**
 * Record *why* a refresh token stopped being live: rotated, or revoked (§12).
 *
 * Refresh tokens rotate on every use with no grace, so two requests carrying the same cookie —
 * two tabs reloading together, or a reload that aborts a refresh the server has already
 * completed, so the browser never stores the new cookie — left the loser holding a revoked
 * token, and the person was signed out. The fix accepts a token for a short window after it was
 * *rotated*, and that needs to be told apart from a token that was *revoked* by signing out or
 * changing a password, which must stop working at once. `revokedAt` alone cannot say which.
 *
 * Nullable, no default: existing revoked rows are treated as revoked, never as rotated, so the
 * migration cannot bring any old token back to life.
 */
const hasColumn = (db: Database): boolean =>
    db
        .prepare(`SELECT 1 FROM pragma_table_info('RefreshToken') WHERE "name" = 'rotatedAt'`)
        .get() !== undefined;

/**
 * Idempotent, as every migration here has to be: a database built by `init.ts` already has the
 * column and is then stamped by replaying the history (`docker/smoke.sh` exercises exactly
 * that), and SQLite has no `ADD COLUMN IF NOT EXISTS`.
 */
export function up(db: Database): void {
    if (!hasColumn(db)) {
        db.exec(`ALTER TABLE "RefreshToken" ADD COLUMN "rotatedAt" DATETIME;`);
    }
}

export function down(db: Database): void {
    if (hasColumn(db)) {
        db.exec(`ALTER TABLE "RefreshToken" DROP COLUMN "rotatedAt";`);
    }
}
