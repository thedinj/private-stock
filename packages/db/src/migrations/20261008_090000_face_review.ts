import type { Database } from "better-sqlite3";

/**
 * What the face and name reviews remember (§5f "Review › Faces", §5d "Find untagged").
 *
 * - **`Face.skippedAt`**: "can't tell", said of a face in the Unnamed review, so a group nobody
 *   can name stops heading the list every visit. On the face, as every decision about faces is,
 *   so it survives the groups changing around it.
 * - **`MentionRefusal`**: "not them", said of an item whose filename, title or burned-in text
 *   names a tag. The name match is a stored fact (`MediaMention`) and stays; this says it is the
 *   wrong person, so "Find untagged" and "Likely" stop offering it.
 * - **`FaceGroupKin`**: for each face group, the groups most like it, written by the grouping job.
 *   One person is often several groups; a group like one confirmed as somebody is proposed as
 *   them. Replaced whole on every run, so no foreign key: a group is not a row.
 *
 * Nothing to backfill. Idempotent: a database built by `init.ts` already has all three, and is
 * then stamped by replaying the history.
 */
const hasColumn = (db: Database, column: string): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('Face') WHERE "name" = ?`).get(column) !==
    undefined;

export function up(db: Database): void {
    if (!hasColumn(db, "skippedAt")) {
        db.exec(`ALTER TABLE "Face" ADD COLUMN "skippedAt" DATETIME;`);
    }

    if (!hasColumn(db, "skippedByUserId")) {
        db.exec(
            `ALTER TABLE "Face" ADD COLUMN "skippedByUserId" TEXT
                 REFERENCES "User" ("id") ON DELETE SET NULL;`
        );
    }

    db.exec(
        `CREATE TABLE IF NOT EXISTS "MentionRefusal" (
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY ("tagId", "mediaId")
        ) WITHOUT ROWID;

        CREATE TABLE IF NOT EXISTS "FaceGroupKin" (
            "groupId" TEXT NOT NULL CHECK(length("groupId") <= 64),
            "kinGroupId" TEXT NOT NULL CHECK(length("kinGroupId") <= 64),
            "similarity" REAL NOT NULL,
            PRIMARY KEY ("groupId", "kinGroupId")
        ) WITHOUT ROWID;`
    );
}

export function down(db: Database): void {
    db.exec(`DROP TABLE IF EXISTS "FaceGroupKin"; DROP TABLE IF EXISTS "MentionRefusal";`);

    if (hasColumn(db, "skippedByUserId")) {
        db.exec(`ALTER TABLE "Face" DROP COLUMN "skippedByUserId";`);
    }

    if (hasColumn(db, "skippedAt")) {
        db.exec(`ALTER TABLE "Face" DROP COLUMN "skippedAt";`);
    }
}
