import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Refresh tokens: rotation, and the few seconds of grace after it (§12).
 *
 * The grace is the part that is easy to get subtly wrong in the dangerous direction. It exists
 * so two requests racing on one cookie do not sign somebody out, and it must never become a way
 * back in after a deliberate sign-out or a password change — so most of these tests are about
 * what it refuses.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const refreshTokenRepo = await import("./refreshTokenRepo.js");
const { db: sharedDb } = await import("../db.js");

const USER = "99999999-0000-4000-8000-000000000000";
const OTHER = "88888888-0000-4000-8000-000000000000";
const GRACE = 30;

beforeEach(() => {
    db = sharedDb as Database.Database;
    db.pragma("foreign_keys = OFF");

    const tables = db
        .prepare(
            `SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[];

    for (const table of tables) {
        db.exec(`DROP TABLE IF EXISTS "${table.name}"`);
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);

    for (const [id, email] of [
        [USER, "me@example.test"],
        [OTHER, "them@example.test"],
    ]) {
        db.prepare(
            `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
             VALUES (?, ?, ?, 'x', CURRENT_TIMESTAMP)`
        ).run(id, email, email);
    }
});

/** Pretend the rotation happened `seconds` ago. */
const age = (token: string, seconds: number) =>
    db
        .prepare(`UPDATE "RefreshToken" SET "rotatedAt" = datetime('now', ?) WHERE "tokenHash" = ?`)
        .run(`-${seconds} seconds`, refreshTokenRepo.hashToken(token));

describe("rotate", () => {
    it("replaces a live token with a new live one", () => {
        const first = refreshTokenRepo.issue(USER, 30);
        const next = refreshTokenRepo.rotate(first.token, USER, 30);

        expect(next).not.toBeNull();
        expect(refreshTokenRepo.findLive(first.token)).toBeUndefined();
        expect(refreshTokenRepo.findLive(next!.token)?.userId).toBe(USER);
    });

    it("rotates a token once: the second attempt finds it already gone", () => {
        const first = refreshTokenRepo.issue(USER, 30);

        expect(refreshTokenRepo.rotate(first.token, USER, 30)).not.toBeNull();
        expect(refreshTokenRepo.rotate(first.token, USER, 30)).toBeNull();
    });
});

describe("findRecentlyRotated", () => {
    it("accepts a token a refresh replaced moments ago", () => {
        const first = refreshTokenRepo.issue(USER, 30);
        refreshTokenRepo.rotate(first.token, USER, 30);

        expect(refreshTokenRepo.findRecentlyRotated(first.token, GRACE)?.userId).toBe(USER);
    });

    it("stops accepting it once the grace has passed", () => {
        const first = refreshTokenRepo.issue(USER, 30);
        refreshTokenRepo.rotate(first.token, USER, 30);
        age(first.token, GRACE + 5);

        expect(refreshTokenRepo.findRecentlyRotated(first.token, GRACE)).toBeUndefined();
    });

    it("never accepts a token that was signed out rather than rotated", () => {
        const first = refreshTokenRepo.issue(USER, 30);
        refreshTokenRepo.revoke(first.token);

        expect(refreshTokenRepo.findRecentlyRotated(first.token, GRACE)).toBeUndefined();
    });

    it("closes the grace on signing out, so the token before cannot sign back in", () => {
        const first = refreshTokenRepo.issue(USER, 30);
        const next = refreshTokenRepo.rotate(first.token, USER, 30)!;

        refreshTokenRepo.revoke(next.token);

        expect(refreshTokenRepo.findLive(next.token)).toBeUndefined();
        expect(refreshTokenRepo.findRecentlyRotated(first.token, GRACE)).toBeUndefined();
    });

    it("leaves another account's grace alone when one account signs out", () => {
        const mine = refreshTokenRepo.issue(USER, 30);
        const theirs = refreshTokenRepo.issue(OTHER, 30);
        const myNext = refreshTokenRepo.rotate(mine.token, USER, 30)!;
        refreshTokenRepo.rotate(theirs.token, OTHER, 30);

        refreshTokenRepo.revoke(myNext.token);

        expect(refreshTokenRepo.findRecentlyRotated(theirs.token, GRACE)?.userId).toBe(OTHER);
    });

    it("closes every grace on the account when all sessions are revoked", () => {
        const first = refreshTokenRepo.issue(USER, 30);
        const next = refreshTokenRepo.rotate(first.token, USER, 30)!;

        refreshTokenRepo.revokeAllForUser(USER);

        expect(refreshTokenRepo.findLive(next.token)).toBeUndefined();
        expect(refreshTokenRepo.findRecentlyRotated(first.token, GRACE)).toBeUndefined();
    });

    it("never revives an expired token", () => {
        const first = refreshTokenRepo.issue(USER, 30);
        refreshTokenRepo.rotate(first.token, USER, 30);
        db.prepare(
            `UPDATE "RefreshToken" SET "expiresAt" = datetime('now', '-1 minute')
              WHERE "tokenHash" = ?`
        ).run(refreshTokenRepo.hashToken(first.token));

        expect(refreshTokenRepo.findRecentlyRotated(first.token, GRACE)).toBeUndefined();
    });

    it("does not know a token it never issued", () => {
        expect(refreshTokenRepo.findRecentlyRotated("made-up", GRACE)).toBeUndefined();
    });
});
