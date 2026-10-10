import type { Database } from "better-sqlite3";

/**
 * Face groups go (§5f "A person in a video"): every face surface reads people in items and new
 * people now, so `Face.groupId`, its index, `FaceGroupStat` and `FaceGroupDissolved` hold nothing
 * anybody reads. Decisions were always on faces, so none goes with them. The groups file on disk,
 * `faces/groups.bin`, is swept as an orphan.
 *
 * `down` puts the column and tables back empty: the groups were rebuilt from the faces by their
 * job, which goes too.
 *
 * Idempotent; the definitions are written out as `init.ts` writes them.
 */
const hasColumn = (db: Database): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('Face') WHERE "name" = 'groupId'`).get() !==
    undefined;

export function up(db: Database): void {
    db.exec(`DROP INDEX IF EXISTS "idx_Face_group";
             DROP TABLE IF EXISTS "FaceGroupStat";
             DROP TABLE IF EXISTS "FaceGroupDissolved";`);

    if (hasColumn(db)) {
        db.exec(`ALTER TABLE "Face" DROP COLUMN "groupId";`);
    }

    db.exec(`DELETE FROM "Job" WHERE "kind" = 'faceGroups' AND "state" IN ('pending', 'claimed');`);
}

export function down(db: Database): void {
    if (!hasColumn(db)) {
        db.exec(`ALTER TABLE "Face" ADD COLUMN "groupId" TEXT;`);
    }

    db.exec(`CREATE INDEX IF NOT EXISTS "idx_Face_group" ON "Face" ("groupId") WHERE "groupId" IS NOT NULL;

        CREATE TABLE IF NOT EXISTS "FaceGroupDissolved" (
            "groupId" TEXT NOT NULL PRIMARY KEY CHECK(length("groupId") <= 64),
            "dissolvedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) WITHOUT ROWID;

        CREATE TABLE IF NOT EXISTS "FaceGroupStat" (
            "groupId" TEXT NOT NULL PRIMARY KEY CHECK(length("groupId") <= 64),
            "cohesion" REAL NOT NULL
        ) WITHOUT ROWID;`);
}
