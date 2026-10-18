import type { Database } from "better-sqlite3";

/**
 * What a person said about two look-alikes, per pair (§10i).
 *
 * A look-alike group could only be reviewed whole, so five copies holding two duplicate pairs
 * and one stranger had no answer: marking it reviewed hid the real duplicates, and leaving it
 * open kept the stranger coming back. A group is only its member set and is rebuilt whenever
 * clustering touches it (§10b), so the decision is stored against pairs of items instead, which
 * no regrouping changes. Clustering never joins a 'different' pair into one group.
 *
 * Idempotent; the definitions are written out as `init.ts` writes them.
 */
export function up(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS "DupeVerdict" (
            "aId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "bId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "verdict" TEXT NOT NULL CHECK("verdict" IN ('same', 'different')),
            "decisionId" TEXT NOT NULL CHECK(length("decisionId") <= 64),
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY ("aId", "bId"),
            CHECK ("aId" < "bId")
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS "idx_DupeVerdict_bId" ON "DupeVerdict" ("bId");
        CREATE INDEX IF NOT EXISTS "idx_DupeVerdict_decision" ON "DupeVerdict" ("decisionId");
    `);
}

export function down(db: Database): void {
    db.exec(`DROP TABLE IF EXISTS "DupeVerdict";`);
}
