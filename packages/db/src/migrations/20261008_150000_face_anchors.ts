import type { Database } from "better-sqlite3";

/**
 * One face, one score (§5f): every library performer's reference, and every face's best match
 * among them, written whole by the `faceAnchors` job.
 *
 * - **`FaceAnchor`**: what each reference is built from — items, and of those how many a person
 *   confirmed and how many the face their tagged items share. The vectors themselves are in
 *   `faces/anchors.bin`, beside the faces they came from.
 * - **`FaceMatch`**: each face's best match and the next best, for "looks like them", the review's
 *   order and, later, tagging by itself.
 * - **`FaceGroupKin` goes.** Groups likened to groups by their drifting sums, at a line nobody
 *   measured, was a second way of asking "is this them" that disagreed with the first; a face
 *   against a performer's reference is the one way now.
 *
 * Idempotent; the definitions are written out as `init.ts` writes them.
 */
export function up(db: Database): void {
    db.exec(
        `DROP TABLE IF EXISTS "FaceGroupKin";

        CREATE TABLE IF NOT EXISTS "FaceAnchor" (
            "tagId" TEXT NOT NULL PRIMARY KEY REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "items" INTEGER NOT NULL,
            "confirmedItems" INTEGER NOT NULL,
            "sharedItems" INTEGER NOT NULL,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS "FaceMatch" (
            "faceId" TEXT NOT NULL PRIMARY KEY REFERENCES "Face" ("id") ON DELETE CASCADE,
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "score" REAL NOT NULL,
            "second" REAL NOT NULL
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS "idx_FaceMatch_tag" ON "FaceMatch" ("tagId", "score");`
    );
}

export function down(db: Database): void {
    db.exec(
        `DROP TABLE IF EXISTS "FaceMatch";
        DROP TABLE IF EXISTS "FaceAnchor";

        CREATE TABLE IF NOT EXISTS "FaceGroupKin" (
            "groupId" TEXT NOT NULL CHECK(length("groupId") <= 64),
            "kinGroupId" TEXT NOT NULL CHECK(length("kinGroupId") <= 64),
            "similarity" REAL NOT NULL,
            PRIMARY KEY ("groupId", "kinGroupId")
        ) WITHOUT ROWID;`
    );
}
