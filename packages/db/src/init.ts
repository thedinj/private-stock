import type { Database } from "better-sqlite3";

/**
 * The schema, as a fresh install builds it.
 *
 * This is one of two definitions of the schema; the other is the migration chain in
 * `migrations/`. `migrationDrift.test.ts` proves they agree. Per the checklist in CLAUDE.md,
 * a schema change means: write the migration, update this file, update the Zod schemas in
 * `@private-stock/core` — all three, every time.
 *
 * Conventions (inherited from basket-bot):
 *   - TEXT primary keys from `crypto.randomUUID()`
 *   - PascalCase singular table names, camelCase columns
 *   - booleans stored as 1 or NULL, never 0 — so partial indexes stay small
 *   - CHECK constraints on text length
 *   - hard deletes; `MediaFile.state` is a lifecycle, not a soft delete (§4)
 */
export function initializeDatabase(db: Database): void {
    db.exec(`
        -- ─────────────────────────────────────────────────────────────────────────────
        -- Accounts
        -- ─────────────────────────────────────────────────────────────────────────────

        -- An invitation to create an account (§12c). There is no open registration: reaching
        -- /register without one of these produces nothing.
        --
        -- The code is generated, never chosen -- see generateInvitationCode(). A code somebody
        -- picks carries whatever entropy went into picking it, which on an internet-facing
        -- deployment is the difference between a rate limiter that bounds volume and one that
        -- is the only thing between a stranger and the library.
        CREATE TABLE IF NOT EXISTS "Invitation" (
            "id" TEXT NOT NULL PRIMARY KEY,
            -- Stored in canonical form (upper case, confusions resolved, grouping stripped),
            -- and looked up by exactly that, so the typed form is forgiven in one place only.
            "code" TEXT NOT NULL UNIQUE CHECK(length("code") BETWEEN 6 AND 64),
            -- Who it is for, in the admin's words. Legibility, not a security property: six
            -- codes in a list are unreadable without it.
            "label" TEXT CHECK("label" IS NULL OR length("label") BETWEEN 1 AND 80),
            -- What the account will be granted. Carried on the invitation so a trusted person
            -- can arrive with the delete scope already, rather than being promoted afterwards.
            "scopes" TEXT NOT NULL DEFAULT '' CHECK(length("scopes") <= 200),
            -- NULL means unlimited. Compared against the count of User rows naming this row.
            "maxUses" INTEGER CHECK("maxUses" IS NULL OR "maxUses" > 0),
            -- NULL means it never expires.
            "expiresAt" DATETIME,
            -- Revocation is a timestamp rather than a flag, because "when did this stop
            -- working" is a question somebody asks and a boolean cannot answer. A revoked
            -- invitation is kept: deleting it would orphan the accounts that name it and
            -- throw away the only record of how they got in.
            "revokedAt" DATETIME,
            "createdById" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL
        );

        -- scopes: comma list drawn from "admin", "delete" (§18.1). Empty means view-only.
        CREATE TABLE IF NOT EXISTS "User" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "email" TEXT NOT NULL UNIQUE CHECK(length("email") BETWEEN 3 AND 255),
            "displayName" TEXT NOT NULL CHECK(length("displayName") BETWEEN 1 AND 100),
            "password" TEXT NOT NULL CHECK(length("password") <= 255),
            "scopes" TEXT NOT NULL DEFAULT '' CHECK(length("scopes") <= 200),
            "disabled" INTEGER CHECK("disabled" IS NULL OR "disabled" = 1),
            -- Bumped whenever the password changes. Signed media tokens (§12d) carry the
            -- value they were minted under, so a password change invalidates every one of
            -- them at once without anything having to be stored or listed.
            "tokenEpoch" INTEGER NOT NULL DEFAULT 0,
            -- Which invitation this account arrived through, or NULL for the first admin,
            -- who predates every invitation by construction (§12c).
            --
            -- This column is how an invitation's use count is worked out, rather than a
            -- counter on the invitation itself: a counter can drift from the accounts it
            -- claims to describe, and this cannot. It also answers "who let them in" for as
            -- long as both rows survive, which is why a spent invitation is revoked rather
            -- than deleted.
            "invitationId" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            FOREIGN KEY ("invitationId") REFERENCES "Invitation" ("id") ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS "idx_User_invitation"
            ON "User" ("invitationId") WHERE "invitationId" IS NOT NULL;

        -- "rotatedAt" is set with "revokedAt" when a refresh replaced the token and only then.
        -- A rotated token stays usable for REFRESH_ROTATION_GRACE_SECONDS so two requests
        -- racing on one cookie do not sign the person out. A token revoked by signing out or
        -- by a password change never is; both clear the column.
        CREATE TABLE IF NOT EXISTS "RefreshToken" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "tokenHash" TEXT NOT NULL UNIQUE CHECK(length("tokenHash") <= 255),
            "userAgent" TEXT CHECK("userAgent" IS NULL OR length("userAgent") <= 500),
            "expiresAt" DATETIME NOT NULL,
            "lastSeenAt" DATETIME,
            "revokedAt" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "rotatedAt" DATETIME,
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS "idx_RefreshToken_userId" ON "RefreshToken" ("userId");

        -- ─────────────────────────────────────────────────────────────────────────────
        -- Library: roots and physical files
        -- ─────────────────────────────────────────────────────────────────────────────

        -- A library: a directory somewhere on disk, plus what the admin decided about it
        -- (§12b). Libraries exist because an administrator added one — nothing is created
        -- because a directory appeared, so "edit this library" means the same thing for every
        -- row, and an edited path cannot be undone by the next scan.
        --
        -- "path" is the identity, not a directory name. The name was the identity once, which
        -- confined every library to a single parent directory and made two drives that each
        -- hold a "Videos" folder collide. Keying on the path is also what makes moving content
        -- a repoint rather than a re-import: files, tags, ratings and duplicate groups all
        -- hang off this row, so changing where it points keeps every one of them.
        --
        -- "writable" gates deletion and nothing else — deletion is the only write the app
        -- performs inside a library (§18.1).
        CREATE TABLE IF NOT EXISTS "MediaRoot" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "path" TEXT NOT NULL UNIQUE CHECK(length("path") BETWEEN 1 AND 1024),
            "label" TEXT NOT NULL CHECK(length("label") BETWEEN 1 AND 100),
            "enabled" INTEGER CHECK("enabled" IS NULL OR "enabled" = 1),
            "writable" INTEGER CHECK("writable" IS NULL OR "writable" = 1),
            "lastScanAt" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL
        );

        -- quickHash identifies a file cheaply on rescan; contentHash is computed lazily and
        -- is what proves an exact duplicate (§5).
        CREATE TABLE IF NOT EXISTS "MediaFile" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "rootId" TEXT NOT NULL,
            "relPath" TEXT NOT NULL CHECK(length("relPath") <= 1024),
            "size" INTEGER NOT NULL,
            "mtime" INTEGER NOT NULL,
            -- Together these identify a file independently of its name, which is what
            -- makes a rename detectable rather than looking like one file vanishing and
            -- another appearing (§7). "dev" is carried because an inode is only unique within
            -- a filesystem, and a library can span a mount point.
            --
            -- Both are null where the filesystem will not say -- FAT32 and some SMB shares
            -- report nothing usable -- so nothing may depend on them being present.
            "dev" TEXT CHECK("dev" IS NULL OR length("dev") <= 64),
            "inode" TEXT CHECK("inode" IS NULL OR length("inode") <= 64),
            "quickHash" TEXT CHECK("quickHash" IS NULL OR length("quickHash") <= 128),
            "contentHash" TEXT CHECK("contentHash" IS NULL OR length("contentHash") <= 128),
            -- Four things can be true of a file, and they are not the same thing:
            -- 'trashed' is a user decision, 'missing' and 'archived' are the filesystem's, and
            -- 'unverified' means the library was repointed and nobody has looked yet.
            --
            -- Keeping them apart is what stops a disconnected share looking like a deletion,
            -- stops any sweep over missing files becoming an unannounced purge (§10), and
            -- stops a repoint claiming that files are gone when the truth is that we have not
            -- checked. Only 'active' is listable, so the last one hides an item rather than
            -- asserting anything about it.
            "state" TEXT NOT NULL DEFAULT 'active'
                CHECK("state" IN ('active', 'missing', 'archived', 'trashed', 'unverified')),
            "classification" TEXT NOT NULL DEFAULT 'media'
                CHECK("classification" IN ('media', 'companion', 'ignored')),
            "missingScans" INTEGER NOT NULL DEFAULT 0,
            "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "lastSeenAt" DATETIME NOT NULL,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            FOREIGN KEY ("rootId") REFERENCES "MediaRoot" ("id") ON DELETE CASCADE,
            UNIQUE ("rootId", "relPath")
        );

        CREATE INDEX IF NOT EXISTS "idx_MediaFile_quickHash" ON "MediaFile" ("quickHash");
        CREATE INDEX IF NOT EXISTS "idx_MediaFile_contentHash" ON "MediaFile" ("contentHash");
        CREATE INDEX IF NOT EXISTS "idx_MediaFile_state" ON "MediaFile" ("state");
        -- Finding the file a newly seen path used to be, by identity rather than by name.
        CREATE INDEX IF NOT EXISTS "idx_MediaFile_identity"
            ON "MediaFile" ("rootId", "inode") WHERE "inode" IS NOT NULL;

        -- ─────────────────────────────────────────────────────────────────────────────
        -- Library: logical media
        -- ─────────────────────────────────────────────────────────────────────────────

        -- Objective facts only. Anything a person decides lives in UserMedia (§5).
        CREATE TABLE IF NOT EXISTS "Media" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "kind" TEXT NOT NULL CHECK("kind" IN ('image', 'video')),
            "title" TEXT CHECK("title" IS NULL OR length("title") <= 500),
            "sourceUrl" TEXT CHECK("sourceUrl" IS NULL OR length("sourceUrl") <= 2048),
            "durationMs" INTEGER,
            "width" INTEGER,
            "height" INTEGER,
            "codec" TEXT CHECK("codec" IS NULL OR length("codec") <= 40),
            "container" TEXT CHECK("container" IS NULL OR length("container") <= 40),
            "bitrate" INTEGER,
            "fps" REAL,
            -- Enough to decide whether a browser can actually play this (§8).
            --
            -- "codec = h264" is not sufficient and assuming it is produces a library where
            -- some files play and some show a black rectangle with no explanation. High 10
            -- and 4:2:2 H.264 are common in anime and camera output and no browser decodes
            -- them; HEVC plays in Safari and nowhere else. The profile and pixel format are
            -- what separate those cases from ordinary H.264.
            "videoProfile" TEXT CHECK("videoProfile" IS NULL OR length("videoProfile") <= 40),
            "videoLevel" INTEGER,
            "pixFmt" TEXT CHECK("pixFmt" IS NULL OR length("pixFmt") <= 40),
            -- The default audio track, denormalised from MediaStream. The library query needs
            -- it per row to decide playability, and joining the stream table for every tile
            -- costs more than one column.
            "audioCodec" TEXT CHECK("audioCodec" IS NULL OR length("audioCodec") <= 40),
            "audioChannels" INTEGER,
            "isAnimated" INTEGER CHECK("isAnimated" IS NULL OR "isAnimated" = 1),
            "capturedAt" DATETIME,
            "probedAt" DATETIME,
            -- A deliberate choice of cover, pointing at any "image-like" Artifact row for
            -- this media. NULL means "whatever the generator produced", which is the
            -- ordinal-0 cover. Kept here rather than in UserMedia because picking the frame
            -- that represents a video is curation of the library, not a private preference —
            -- if it were per-user, two people would see different grids and neither could
            -- fix the other's. A per-user override can still be added to UserMedia later
            -- without moving this.
            "coverArtifactId" TEXT,
            -- ───── Denormalised from the original MediaFile, for the grid (§20) ─────
            --
            -- The grid filters on the *file* (is it active, is it media, which root) and
            -- orders by the *item* (added, title, duration). Those columns lived on two
            -- tables, and no index can serve a filter and an ordering that are not on the
            -- same one -- so SQLite drove from the file side and sorted the entire matching
            -- library into a temp B-tree on every page. Measured at 200k items that was
            -- 6.0 seconds for page one, and the same for page fifty: the paging was real in
            -- the API and imaginary in the database.
            --
            -- Copying the three filter inputs here lets one partial index cover filter and
            -- order together. The same query then answers in 0.4 ms, and a deep page costs
            -- what the first one does.
            --
            -- These are maintained by triggers below, never by application code. The
            -- failure mode of a stale copy is an item that silently vanishes from the grid
            -- while still existing everywhere else, which is close to undiagnosable from a
            -- bug report -- so it must not be possible to forget.
            "listRootId" TEXT,
            "listSize" INTEGER,
            -- Carried here too, so the grid query never has to join the file table at all.
            -- It is the fallback title for an item the probe has not named yet, and joining
            -- three tables to render a placeholder string is what this whole section exists
            -- to avoid.
            "listRelPath" TEXT,
            -- 1 or NULL, per the boolean convention, so the partial indexes below hold only
            -- rows the grid can actually show.
            "listable" INTEGER CHECK("listable" IS NULL OR "listable" = 1),
            "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "lastSeenAt" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            -- Forward reference: "Artifact" is created below. SQLite resolves foreign keys
            -- when they are used rather than when the table is declared, so the order of
            -- CREATE TABLE statements does not have to break the cycle.
            FOREIGN KEY ("coverArtifactId") REFERENCES "Artifact" ("id") ON DELETE SET NULL
        );

        -- The foreign key above, seen from the other end: deleting any artifact looks here for a
        -- cover pointing at it, and without this that was a scan of every item -- once per
        -- artifact a purge cascades to, the bulk of a 7 s delete (§20). Partial, because almost
        -- no item has a chosen cover; a lookup by value implies IS NOT NULL, so the check uses it.
        CREATE INDEX IF NOT EXISTS "idx_Media_coverArtifactId"
            ON "Media" ("coverArtifactId") WHERE "coverArtifactId" IS NOT NULL;

        CREATE INDEX IF NOT EXISTS "idx_Media_kind_addedAt" ON "Media" ("kind", "addedAt");

        -- One partial index per sort the grid offers (§20).
        --
        -- Shape matters in every part: partial on "listable" so only showable rows are in
        -- the index; "listRootId" leading because access control is a filter every single
        -- query applies; the sort column next; and "id" last to break ties, which is what
        -- makes the keyset cursor a total order rather than an approximate one.
        --
        -- The sort expressions must match these exactly. Wrapping a sort column in
        -- COALESCE -- which the first version did, to order NULLs predictably -- makes the
        -- ORDER BY an expression rather than a column and silently disables the index.
        CREATE INDEX IF NOT EXISTS "idx_Media_list_addedAt"
            ON "Media" ("listRootId", "addedAt", "id") WHERE "listable" = 1;
        CREATE INDEX IF NOT EXISTS "idx_Media_list_capturedAt"
            ON "Media" ("listRootId", "capturedAt", "id") WHERE "listable" = 1;
        CREATE INDEX IF NOT EXISTS "idx_Media_list_title"
            ON "Media" ("listRootId", "title" COLLATE NOCASE, "id") WHERE "listable" = 1;
        CREATE INDEX IF NOT EXISTS "idx_Media_list_duration"
            ON "Media" ("listRootId", "durationMs", "id") WHERE "listable" = 1;
        CREATE INDEX IF NOT EXISTS "idx_Media_list_size"
            ON "Media" ("listRootId", "listSize", "id") WHERE "listable" = 1;
        -- On the expression rather than a column: the short side, which is what resolution
        -- means to the filter and the sort alike. The ORDER BY in mediaRepo spells it
        -- identically, which is what lets SQLite walk this index instead of sorting.
        CREATE INDEX IF NOT EXISTS "idx_Media_list_resolution"
            ON "Media" ("listRootId", MIN("width", "height"), "id") WHERE "listable" = 1;
        CREATE INDEX IF NOT EXISTS "idx_Media_list_bitrate"
            ON "Media" ("listRootId", "bitrate", "id") WHERE "listable" = 1;
        CREATE INDEX IF NOT EXISTS "idx_Media_list_fps"
            ON "Media" ("listRootId", "fps", "id") WHERE "listable" = 1;
        -- Kind is a filter rather than a sort, so it leads the sort column here.
        CREATE INDEX IF NOT EXISTS "idx_Media_list_kind_addedAt"
            ON "Media" ("listRootId", "kind", "addedAt", "id") WHERE "listable" = 1;

        -- The processing view's denominator (§13c): listable items by kind and by whether the
        -- probe has read them, counted from ~50 pages instead of a three-table join over the
        -- library. The expression leads so that no other query can seek on it.
        CREATE INDEX IF NOT EXISTS "idx_Media_listable_probed_kind"
            ON "Media" ("probedAt" IS NOT NULL, "kind") WHERE "listable" = 1;

        -- And the listable side, for the joins that only ask "would the library show this
        -- item?" -- every tag count (§6, §20). Without it each assignment reads the item's whole
        -- row to test one column, and on the NAS that was a thousand pages for the performer
        -- list. UNIQUE only so the planner prefers it: two unique lookups on "id" tie, and the
        -- covering one wins, where a plain index loses to the primary key every time.
        CREATE UNIQUE INDEX IF NOT EXISTS "idx_Media_listable_id"
            ON "Media" ("id") WHERE "listable" = 1;
        -- The same, for the counts split by kind (the Tags page, a tag's own numbers), which
        -- read "kind" and so fetched the row anyway. Those queries state "kind IN (every
        -- kind)" so the probe pins both columns of this unique index -- the condition for the
        -- planner to choose it. Beside the one above rather than instead of it: on a join that
        -- only tests listable, that term can turn the plan into a walk of Media by kind.
        CREATE UNIQUE INDEX IF NOT EXISTS "idx_Media_listable_id_kind"
            ON "Media" ("id", "kind") WHERE "listable" = 1;
        -- And again with the root, for the tag counts narrowed to the viewer's libraries --
        -- a tag's own numbers, the Tags page's, "Appears with" -- so a count matches the grid
        -- it opens without reading each item's row. Those statements name it. The "kind IN"
        -- term is always true and is there to fence the index off: a partial index is only
        -- usable by a query that states its WHERE, and only the tag counts state this one.
        -- Without it the library's own queries, which pin these same three columns, took it.
        -- Not instead of the one above: the stage sweeps walk that one whole, and a third
        -- column would nearly double each walk.
        CREATE INDEX IF NOT EXISTS "idx_Media_listable_id_kind_root"
            ON "Media" ("id", "kind", "listRootId")
            WHERE "listable" = 1 AND "kind" IN ('image', 'video');

        -- One Media may have several files: the original, plus companions like subtitles.
        CREATE TABLE IF NOT EXISTS "MediaFileLink" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "fileId" TEXT NOT NULL,
            "role" TEXT NOT NULL DEFAULT 'original'
                CHECK("role" IN ('original', 'companion')),
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("fileId") REFERENCES "MediaFile" ("id") ON DELETE CASCADE,
            UNIQUE ("mediaId", "fileId")
        );

        CREATE INDEX IF NOT EXISTS "idx_MediaFileLink_fileId" ON "MediaFileLink" ("fileId");

        -- Exactly one original per item.
        --
        -- "UNIQUE (mediaId, fileId)" above stops the same file being linked twice, but not
        -- two *different* files both claiming to be the original -- and every query that
        -- resolves an item to its file joins on the "original" role, so a second one makes
        -- that join return two rows. The grid would show the item twice, counts would be
        -- inflated, and which file "the" original is would depend on row order.
        --
        -- Found by the randomised drift check in listColumns.test.ts, which produced the
        -- state and then disagreed with itself about what the answer should be. The
        -- ambiguity was the bug; this makes it unrepresentable.
        CREATE UNIQUE INDEX IF NOT EXISTS "idx_MediaFileLink_one_original"
            ON "MediaFileLink" ("mediaId") WHERE "role" = 'original';

        -- ─────────────────────────────────────────────────────────────────────────────────
        -- Keeping Media's denormalised list columns true (§20)
        -- ─────────────────────────────────────────────────────────────────────────────────
        --
        -- Triggers rather than repo code, for the same reason the search index uses them:
        -- this is mechanical restatement of a fact that already exists elsewhere, and the
        -- consequence of forgetting one write path is an item that disappears from the grid
        -- while remaining present in every other view. A person reporting that bug would
        -- describe a file that "isn't in the library" while its detail page loads fine.
        --
        -- Recomputed from scratch rather than patched incrementally. The value is a small
        -- query over one item's rows, and a full recompute is correct no matter which of
        -- the inputs changed -- whereas incremental patching has to enumerate the cases and
        -- gets the rare ones wrong.

        -- A single definition, repeated by each trigger below because SQLite has no way to
        -- share a statement between them.
        CREATE TRIGGER IF NOT EXISTS "MediaFile_list_ai"
        AFTER INSERT ON "MediaFile" BEGIN
            UPDATE "Media" SET
                "listRootId" = (
                    SELECT f."rootId" FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original' LIMIT 1),
                "listSize" = (
                    SELECT f."size" FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original' LIMIT 1),
                "listRelPath" = (
                    SELECT f."relPath" FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original' LIMIT 1),
                "listable" = (
                    SELECT 1 FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original'
                       AND f."state" = 'active' AND f."classification" = 'media' LIMIT 1)
              WHERE "Media"."id" IN (
                  SELECT "mediaId" FROM "MediaFileLink" WHERE "fileId" = new."id");
        END;

        -- Only when a column the body reads actually changed. It fired on every update, on the
        -- reasoning that the subqueries were cheap -- and they are, but each firing rewrote a
        -- Media row, so a file-hash pass or a heartbeat-length scan rewrote the whole
        -- catalogue into the WAL and emptied the web process's page cache with every commit
        -- (§20). The list here is exactly the columns the body reads; a column added to the
        -- body must be added to it.
        CREATE TRIGGER IF NOT EXISTS "MediaFile_list_au"
        AFTER UPDATE ON "MediaFile"
        WHEN old."rootId" IS NOT new."rootId"
          OR old."size" IS NOT new."size"
          OR old."relPath" IS NOT new."relPath"
          OR old."state" IS NOT new."state"
          OR old."classification" IS NOT new."classification"
        BEGIN
            UPDATE "Media" SET
                "listRootId" = (
                    SELECT f."rootId" FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original' LIMIT 1),
                "listSize" = (
                    SELECT f."size" FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original' LIMIT 1),
                "listRelPath" = (
                    SELECT f."relPath" FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original' LIMIT 1),
                "listable" = (
                    SELECT 1 FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original'
                       AND f."state" = 'active' AND f."classification" = 'media' LIMIT 1)
              WHERE "Media"."id" IN (
                  SELECT "mediaId" FROM "MediaFileLink" WHERE "fileId" = new."id");
        END;

        -- The link itself is what decides which file is "the original", so creating or
        -- removing one changes the answer even though no MediaFile row moved.
        CREATE TRIGGER IF NOT EXISTS "MediaFileLink_list_ai"
        AFTER INSERT ON "MediaFileLink" BEGIN
            UPDATE "Media" SET
                "listRootId" = (
                    SELECT f."rootId" FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original' LIMIT 1),
                "listSize" = (
                    SELECT f."size" FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original' LIMIT 1),
                "listRelPath" = (
                    SELECT f."relPath" FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original' LIMIT 1),
                "listable" = (
                    SELECT 1 FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original'
                       AND f."state" = 'active' AND f."classification" = 'media' LIMIT 1)
              WHERE "Media"."id" = new."mediaId";
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaFileLink_list_ad"
        AFTER DELETE ON "MediaFileLink" BEGIN
            UPDATE "Media" SET
                "listRootId" = (
                    SELECT f."rootId" FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original' LIMIT 1),
                "listSize" = (
                    SELECT f."size" FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original' LIMIT 1),
                "listRelPath" = (
                    SELECT f."relPath" FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original' LIMIT 1),
                "listable" = (
                    SELECT 1 FROM "MediaFileLink" fl
                      JOIN "MediaFile" f ON f."id" = fl."fileId"
                     WHERE fl."mediaId" = "Media"."id" AND fl."role" = 'original'
                       AND f."state" = 'active' AND f."classification" = 'media' LIMIT 1)
              WHERE "Media"."id" = old."mediaId";
        END;

        -- Embedded tracks as ffprobe reports them (§18.4).
        CREATE TABLE IF NOT EXISTS "MediaStream" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "kind" TEXT NOT NULL CHECK("kind" IN ('video', 'audio', 'subtitle')),
            "streamIndex" INTEGER NOT NULL,
            "codec" TEXT CHECK("codec" IS NULL OR length("codec") <= 40),
            "language" TEXT CHECK("language" IS NULL OR length("language") <= 20),
            "title" TEXT CHECK("title" IS NULL OR length("title") <= 200),
            "channels" INTEGER,
            "isDefault" INTEGER CHECK("isDefault" IS NULL OR "isDefault" = 1),
            "isForced" INTEGER CHECK("isForced" IS NULL OR "isForced" = 1),
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            UNIQUE ("mediaId", "streamIndex")
        );

        -- External subtitle files found beside a video (§18.4).
        CREATE TABLE IF NOT EXISTS "MediaSubtitle" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "fileId" TEXT NOT NULL,
            "language" TEXT CHECK("language" IS NULL OR length("language") <= 20),
            "format" TEXT NOT NULL CHECK(length("format") <= 10),
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("fileId") REFERENCES "MediaFile" ("id") ON DELETE CASCADE,
            UNIQUE ("mediaId", "fileId")
        );

        -- ─────────────────────────────────────────────────────────────────────────────
        -- Derived output. Rows hold paths; the bytes live on disk (§9).
        -- ─────────────────────────────────────────────────────────────────────────────

        -- Generated imagery: covers, alternates, user captures, previews, sprite sheets.
        -- generatorVersion is what lets a changed recipe re-enqueue only stale artifacts.
        --
        -- "capture" exists for frames a person grabbed in the player. It is the same shape as
        -- a poster and deliberately a separate kind, because the two have opposite
        -- lifecycles: posters are disposable output that the generator may replace whenever
        -- the recipe changes, and captures are something a person made and expects to still
        -- be there afterwards. The "source" column states that directly, so no cleanup pass
        -- has to infer it from the kind.
        CREATE TABLE IF NOT EXISTS "Artifact" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "kind" TEXT NOT NULL
                CHECK("kind" IN ('cover', 'poster', 'capture', 'preview', 'sprite',
                                 'spriteVtt', 'subtitleVtt')),
            "ordinal" INTEGER NOT NULL DEFAULT 0,
            "relPath" TEXT NOT NULL CHECK(length("relPath") <= 1024),
            "width" INTEGER,
            "height" INTEGER,
            "tileCount" INTEGER,
            "intervalMs" INTEGER,
            "bytes" INTEGER,
            -- Where in the source this frame was taken, in milliseconds. Null for artifacts
            -- that are not a single moment (sprite sheets, previews) and for still images.
            -- Recording it is what lets the player jump to the frame a capture came from,
            -- and what lets a regenerated cover keep the position someone chose.
            "atMs" INTEGER,
            -- 'auto' may be deleted and regenerated at will; 'user' never is.
            "source" TEXT NOT NULL DEFAULT 'auto' CHECK("source" IN ('auto', 'user')),
            "createdByUserId" TEXT,
            "label" TEXT CHECK("label" IS NULL OR length("label") <= 200),
            "generatorVersion" INTEGER NOT NULL DEFAULT 1,
            "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            -- The capture outlives the account that made it; only the attribution is lost.
            FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL,
            UNIQUE ("mediaId", "kind", "ordinal")
        );

        -- No index on ("mediaId", "kind", "ordinal") here: the UNIQUE table constraint above
        -- already creates exactly that index, and declaring it twice costs a second B-tree
        -- write on every artifact the pipeline produces while buying nothing.
        -- The regeneration sweep's index: find auto artifacts left behind by an older recipe
        -- without scanning the user's captures.
        CREATE INDEX IF NOT EXISTS "idx_Artifact_stale"
            ON "Artifact" ("kind", "generatorVersion") WHERE "source" = 'auto';
        -- The Captures page: one person's stills, newest first. Partial on kind, not source, so
        -- the cover-n renderings of those stills stay out of it (§9).
        CREATE INDEX IF NOT EXISTS "idx_Artifact_capture_owner"
            ON "Artifact" ("createdByUserId", "generatedAt" DESC) WHERE "kind" = 'capture';

        CREATE TABLE IF NOT EXISTS "Variant" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "profile" TEXT NOT NULL CHECK(length("profile") <= 40),
            "relPath" TEXT NOT NULL CHECK(length("relPath") <= 1024),
            "codec" TEXT CHECK("codec" IS NULL OR length("codec") <= 40),
            "width" INTEGER,
            "height" INTEGER,
            "bitrate" INTEGER,
            "bytes" INTEGER,
            "ready" INTEGER CHECK("ready" IS NULL OR "ready" = 1),
            -- When this rendition was last served, for the retention sweep (§8).
            --
            -- Null means it has been made and never watched, which the sweep treats as
            -- "unused since it was created" rather than as "unused for ever" -- otherwise a
            -- rendition finished the moment the window closed would be reclaimed before
            -- anyone could have played it.
            --
            -- Written at most once an hour per variant, not once per request: a viewer
            -- seeking through a video issues range requests by the dozen, and a timestamp
            -- accurate to the hour answers "was this watched this week" exactly as well.
            "lastUsedAt" DATETIME,
            -- When retention reclaimed the bytes, if it has.
            --
            -- The row outlives the file on purpose. It is what tells the five-minute
            -- backfill that this item was deliberately reclaimed rather than never encoded,
            -- and so must not be queued again until somebody opens it. Set together with
            -- clearing "ready", so nothing can choose a variant whose bytes are gone.
            "evictedAt" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            UNIQUE ("mediaId", "profile")
        );

        -- The retention sweep asks for the least recently used ready renditions, which is a
        -- sort over a filtered set rather than a scan of every variant in the library.
        CREATE INDEX IF NOT EXISTS "idx_Variant_lastUsed"
            ON "Variant" ("lastUsedAt") WHERE "ready" = 1;

        -- ─────────────────────────────────────────────────────────────────────────────
        -- Duplicate detection (§10)
        -- ─────────────────────────────────────────────────────────────────────────────

        -- band0..band3 are 16-bit slices of the 64-bit hash: any pair within Hamming 8
        -- must share at least one band, which is what makes candidate lookup indexable.
        -- The 64-bit hash, plus the band index that finds candidates without scanning
        -- every row (§10).
        --
        -- **Eight bands, not four.** Candidate lookup is an equality match on a band, and
        -- the guarantee that makes it sound is pigeonhole: two hashes differing in at most
        -- D bits must share a band whenever D < the number of bands. Four bands therefore
        -- guarantee only distance 3 -- an earlier design specified four and claimed
        -- distance 8, at which roughly 70% of genuine near-duplicate pairs share no band
        -- and are never compared. That failure is invisible: the review queue simply looks
        -- emptier than the library deserves.
        --
        -- Eight 8-bit bands guarantee distance 7. The cost is selectivity -- 256 buckets per
        -- band rather than 65536 -- which is the right trade, because a candidate costs one
        -- XOR and a popcount while a missed duplicate is kept forever.
        CREATE TABLE IF NOT EXISTS "PhashImage" (
            "mediaId" TEXT NOT NULL PRIMARY KEY,
            "hash" BLOB NOT NULL,
            "band0" INTEGER NOT NULL,
            "band1" INTEGER NOT NULL,
            "band2" INTEGER NOT NULL,
            "band3" INTEGER NOT NULL,
            "band4" INTEGER NOT NULL,
            "band5" INTEGER NOT NULL,
            "band6" INTEGER NOT NULL,
            "band7" INTEGER NOT NULL,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS "idx_PhashImage_band0" ON "PhashImage" ("band0");
        CREATE INDEX IF NOT EXISTS "idx_PhashImage_band1" ON "PhashImage" ("band1");
        CREATE INDEX IF NOT EXISTS "idx_PhashImage_band2" ON "PhashImage" ("band2");
        CREATE INDEX IF NOT EXISTS "idx_PhashImage_band3" ON "PhashImage" ("band3");
        CREATE INDEX IF NOT EXISTS "idx_PhashImage_band4" ON "PhashImage" ("band4");
        CREATE INDEX IF NOT EXISTS "idx_PhashImage_band5" ON "PhashImage" ("band5");
        CREATE INDEX IF NOT EXISTS "idx_PhashImage_band6" ON "PhashImage" ("band6");
        CREATE INDEX IF NOT EXISTS "idx_PhashImage_band7" ON "PhashImage" ("band7");

        -- One row per sampled keyframe. A video matches another when enough of its frames
        -- pair within threshold, which is what catches a re-encode, a rescale, and a clip
        -- contained in a longer file (§10).
        CREATE TABLE IF NOT EXISTS "PhashVideo" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "frameIdx" INTEGER NOT NULL,
            "atMs" INTEGER NOT NULL,
            "hash" BLOB NOT NULL,
            "band0" INTEGER NOT NULL,
            "band1" INTEGER NOT NULL,
            "band2" INTEGER NOT NULL,
            "band3" INTEGER NOT NULL,
            "band4" INTEGER NOT NULL,
            "band5" INTEGER NOT NULL,
            "band6" INTEGER NOT NULL,
            "band7" INTEGER NOT NULL,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            UNIQUE ("mediaId", "frameIdx")
        );

        CREATE INDEX IF NOT EXISTS "idx_PhashVideo_band0" ON "PhashVideo" ("band0");
        CREATE INDEX IF NOT EXISTS "idx_PhashVideo_band1" ON "PhashVideo" ("band1");
        CREATE INDEX IF NOT EXISTS "idx_PhashVideo_band2" ON "PhashVideo" ("band2");
        CREATE INDEX IF NOT EXISTS "idx_PhashVideo_band3" ON "PhashVideo" ("band3");
        CREATE INDEX IF NOT EXISTS "idx_PhashVideo_band4" ON "PhashVideo" ("band4");
        CREATE INDEX IF NOT EXISTS "idx_PhashVideo_band5" ON "PhashVideo" ("band5");
        CREATE INDEX IF NOT EXISTS "idx_PhashVideo_band6" ON "PhashVideo" ("band6");
        CREATE INDEX IF NOT EXISTS "idx_PhashVideo_band7" ON "PhashVideo" ("band7");

        CREATE TABLE IF NOT EXISTS "DupeGroup" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "kind" TEXT NOT NULL CHECK("kind" IN ('exact', 'near')),
            "reviewed" INTEGER CHECK("reviewed" IS NULL OR "reviewed" = 1),
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL
        );

        CREATE TABLE IF NOT EXISTS "DupeMember" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "groupId" TEXT NOT NULL,
            "mediaId" TEXT NOT NULL,
            "distance" INTEGER,
            FOREIGN KEY ("groupId") REFERENCES "DupeGroup" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            UNIQUE ("groupId", "mediaId")
        );

        CREATE INDEX IF NOT EXISTS "idx_DupeMember_mediaId" ON "DupeMember" ("mediaId");

        -- Items whose hashes have already been compared against the library (§10b).
        --
        -- The clustering pass used to compare *everything* against everything on every run,
        -- which is a whole-library pass costing ten seconds at four thousand items and
        -- growing linearly from there -- for a handful of newly hashed rows each time.
        --
        -- This is the difference between that and an incremental pass: the seeds are the
        -- items not in here, and comparison is symmetric, so an item compared against the
        -- library when it arrived never needs comparing again. Pairs between two old items
        -- were found when the later of the two was the seed.
        --
        -- A row rather than a timestamp watermark on purpose. A "clustered through T" mark
        -- silently drops anything written during the pass that shares T -- and these
        -- timestamps have one-second granularity, while a bulk import writes hundreds of rows
        -- a second. Marking the items themselves has no such window, and a pass that dies
        -- half way simply leaves the rest unmarked for the next one.
        CREATE TABLE IF NOT EXISTS "DupeClustered" (
            "mediaId" TEXT NOT NULL PRIMARY KEY,
            "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE
        );

        -- ─────────────────────────────────────────────────────────────────────────────
        -- Descriptive metadata: faceted tags (§5b)
        -- ─────────────────────────────────────────────────────────────────────────────

        -- "kind" is an open string — genre, performer, series, studio, source, location,
        -- event. Adding a facet later is a row, not a migration.
        -- ownerId NULL is the library's vocabulary, curated by administrators; set is one
        -- person's own. The name is owned, not just the assignment: a tag nobody else can
        -- see the *use* of but everybody can see the *existence* of is not private, and the
        -- shared vocabulary is something an admin is meant to curate rather than watch fill
        -- up with other people's shorthand (§6).
        --
        -- Public and private tagging are two separate systems, not one with a flag (§6).
        -- A tag with an owner is only ever assigned with "MediaTag"."userId" equal to that
        -- owner; a tag without one is only ever assigned with "userId" NULL. The pairing is
        -- exact in both directions, which is what makes "is this private?" a question about
        -- the tag rather than about each assignment of it.
        --
        -- Enforced in tagRepo rather than by a constraint: it spans two tables, so a CHECK
        -- cannot see it and a trigger would fire on a hot write path to restate what one
        -- function already guarantees.
        --
        -- A clip's tags ("ClipTag") follow the same rule with the clip's owner in place of
        -- "userId": a tag with an owner goes only on that owner's clips (§14d).
        CREATE TABLE IF NOT EXISTS "Tag" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "kind" TEXT NOT NULL CHECK(length("kind") BETWEEN 1 AND 40),
            "name" TEXT NOT NULL CHECK(length("name") BETWEEN 1 AND 200),
            "nameNorm" TEXT NOT NULL CHECK(length("nameNorm") BETWEEN 1 AND 200),
            "colorKey" TEXT CHECK("colorKey" IS NULL OR length("colorKey") <= 40),
            "description" TEXT CHECK("description" IS NULL OR length("description") <= 1000),
            "ownerId" TEXT,
            /*
             * Who coined this name (§6).
             *
             * Distinct from "ownerId", which says whose vocabulary it is in. On a public tag
             * "ownerId" is NULL whoever created it, so without this the shared vocabulary has
             * no record of where any of its names came from -- and an open vocabulary that
             * anybody may add to is exactly the one where that question gets asked.
             *
             * The earliest "MediaTag"."createdById" was considered as a free substitute and is
             * not the same fact: a tag can be coined and never applied, applied first by
             * somebody other than its author, or have its first assignment withdrawn. A column
             * answers the question asked rather than one that usually agrees with it.
             *
             * ON DELETE SET NULL, like "MediaTag"."createdById": a public tag belongs to the
             * library, so losing the account that coined it must not take the name with it. A
             * private tag goes anyway, through "ownerId" below.
             */
            "createdById" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            -- Their tags go with their account, exactly as their assignments do.
            FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL
        );

        -- Two partial uniques rather than one table constraint, the same shape "MediaTag"
        -- uses: one "beach" in the library, and one "beach" each for as many people as want
        -- their own. A single UNIQUE ("kind", "nameNorm") would let the first person to
        -- coin a name take it from everybody else.
        CREATE UNIQUE INDEX IF NOT EXISTS "idx_Tag_unique_library"
            ON "Tag" ("kind", "nameNorm") WHERE "ownerId" IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS "idx_Tag_unique_owner"
            ON "Tag" ("kind", "nameNorm", "ownerId") WHERE "ownerId" IS NOT NULL;
        -- Listing a person's own vocabulary, which every tag picker does.
        CREATE INDEX IF NOT EXISTS "idx_Tag_owner"
            ON "Tag" ("ownerId") WHERE "ownerId" IS NOT NULL;

        -- Other names for a tag: a maiden and a married name, an old and a new domain (§5b).
        -- An alias resolves to its tag wherever a name is typed, and is searched with it.
        --
        -- "kind" and "ownerId" are read through "tagId", never copied: a copy would have to
        -- follow every scope change, facet change and merge, and a copy that drifted would
        -- quietly change what a typed name resolves to.
        --
        -- Within one vocabulary (kind + owner) a normalised name belongs to at most one tag,
        -- as its name or as an alias. That spans two tables, so like the ownership pairing
        -- above it is enforced in tagRepo rather than by a constraint. Aliases cascade with
        -- their tag, so a merged or deleted tag takes its other names with it.
        CREATE TABLE IF NOT EXISTS "TagAlias" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "tagId" TEXT NOT NULL,
            "name" TEXT NOT NULL CHECK(length("name") BETWEEN 1 AND 200),
            "nameNorm" TEXT NOT NULL CHECK(length("nameNorm") BETWEEN 1 AND 200),
            "createdById" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS "idx_TagAlias_unique"
            ON "TagAlias" ("tagId", "nameNorm");
        -- Resolving a typed name, which every tag write does before it coins anything.
        CREATE INDEX IF NOT EXISTS "idx_TagAlias_nameNorm" ON "TagAlias" ("nameNorm");

        -- A tag's picture (§6 "A tag's picture"): at most one somebody chose and one the
        -- "tagPictures" job read from a performer's confirmed faces. The chosen one wins; the
        -- automatic one is what shows until somebody chooses, and again if they take theirs back.
        --
        -- A file of its own under "tags/", not a pointer to an "Artifact": an artifact goes with
        -- its item, so purging the item -- a duplicate's purge included -- would take the
        -- picture with it. "mediaId" and "atMs" say where it came from, for as long as that item
        -- exists; the picture is shown only to viewers who can see it there. The crop is
        -- fractions of that frame, kept so the job can tell its own picture is still current.
        CREATE TABLE IF NOT EXISTS "TagPicture" (
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "source" TEXT NOT NULL CHECK("source" IN ('user', 'auto')),
            "relPath" TEXT NOT NULL CHECK(length("relPath") <= 300),
            "smallRelPath" TEXT NOT NULL CHECK(length("smallRelPath") <= 300),
            "mediaId" TEXT REFERENCES "Media" ("id") ON DELETE SET NULL,
            "atMs" INTEGER,
            "cropX" REAL NOT NULL,
            "cropY" REAL NOT NULL,
            "cropW" REAL NOT NULL,
            "cropH" REAL NOT NULL,
            "setByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY ("tagId", "source")
        ) WITHOUT ROWID;

        -- Purging an item clears the pointer to it; without this every purge reads the table.
        CREATE INDEX IF NOT EXISTS "idx_TagPicture_media"
            ON "TagPicture" ("mediaId") WHERE "mediaId" IS NOT NULL;

        -- userId NULL means library-wide; set means that user's private tag.
        -- "source" is what makes re-parsing safe: it replaces only its own assignments.
        -- One bulk tagging operation, so it can be described and withdrawn (§5d).
        --
        -- Recorded even though the MediaTag rows carry the id themselves: after an undo there
        -- are no rows left to describe, and "you tagged 4,000 items an hour ago and then
        -- changed your mind" is exactly what a person needs to see to trust doing it again.
        --
        -- "clipCount" NULL is a batch of items; set is a batch of clips, whose "mediaCount" is
        -- 0 (§14d "Tagging clips").
        CREATE TABLE IF NOT EXISTS "TagBatch" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "userId" TEXT NOT NULL,
            -- What was done, in words, as it was true at the time. Denormalised on purpose:
            -- a tag renamed or deleted afterwards must not rewrite the history of what
            -- somebody did.
            "summary" TEXT NOT NULL CHECK(length("summary") <= 500),
            "mediaCount" INTEGER NOT NULL,
            "clipCount" INTEGER,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "undoneAt" DATETIME,
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS "idx_TagBatch_user"
            ON "TagBatch" ("userId", "createdAt" DESC);

        CREATE TABLE IF NOT EXISTS "MediaTag" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "tagId" TEXT NOT NULL,
            -- Who this assignment is for: NULL is public, an id is that person's own. It
            -- always matches the tag's own "ownerId" -- see the note above "Tag".
            "userId" TEXT,
            /*
             * Who made this assignment (§6).
             *
             * Distinct from "userId", which says who it is *for*. They used to be the same
             * fact because only an administrator could write a public row; once anyone can,
             * a public assignment has no record of who made it and a collaborative
             * vocabulary has no way to review or revert one.
             *
             * ON DELETE SET NULL rather than CASCADE: a public tag belongs to the library,
             * so deleting the account that applied it must not silently untag the library.
             * The attribution outlives the account, exactly as "TrashEntry"."mediaId" does.
             */
            "createdById" TEXT,
            "source" TEXT NOT NULL DEFAULT 'user'
                CHECK("source" IN ('user', 'filename', 'scraper', 'ai', 'ocr')),
            "confidence" REAL,
            "position" INTEGER,
            -- The bulk operation that wrote this row, or NULL for a tag applied one at a
            -- time (§5d). This is what makes a bulk apply undoable: withdrawing a batch
            -- deletes exactly the rows it created, so a tag somebody typed by hand survives
            -- even when the same tag was later applied in bulk to the same item -- the
            -- second write is ignored by the unique index and never joins the batch.
            "batchId" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL,
            FOREIGN KEY ("batchId") REFERENCES "TagBatch" ("id") ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS "idx_MediaTag_unique_library"
            ON "MediaTag" ("mediaId", "tagId") WHERE "userId" IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS "idx_MediaTag_unique_user"
            ON "MediaTag" ("mediaId", "tagId", "userId") WHERE "userId" IS NOT NULL;
        CREATE INDEX IF NOT EXISTS "idx_MediaTag_tagId" ON "MediaTag" ("tagId");
        -- Undo reads by batch and nothing else does, so the index carries only the rows a
        -- bulk operation wrote.
        CREATE INDEX IF NOT EXISTS "idx_MediaTag_batchId"
            ON "MediaTag" ("batchId") WHERE "batchId" IS NOT NULL;
        -- What OCR rules tagged, newest first: the log an administrator checks them against
        -- (§5d). Only those rows, which are a sliver of the table.
        CREATE INDEX IF NOT EXISTS "idx_MediaTag_ocr"
            ON "MediaTag" ("createdAt", "id") WHERE "source" = 'ocr' AND "userId" IS NULL;

        -- Deliberate EAV escape hatch for scraped long-tail fields (§5b). For display and
        -- search only — anything the app branches on gets a real column. 'embedded' is what
        -- the file says about itself in its own tags: a title, a comment, an artist.
        CREATE TABLE IF NOT EXISTS "MediaAttribute" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "key" TEXT NOT NULL CHECK(length("key") BETWEEN 1 AND 100),
            "value" TEXT NOT NULL CHECK(length("value") <= 2000),
            "source" TEXT NOT NULL DEFAULT 'scraper'
                CHECK("source" IN ('user', 'filename', 'scraper', 'ai', 'ocr', 'embedded')),
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            UNIQUE ("mediaId", "key")
        );

        -- Text burned into the picture, reconciled across the frames it was read in (§5d).
        --
        -- One row per distinct string, never one per frame. A watermark appears in every
        -- frame sampled and is read slightly differently in most of them, so per-frame rows
        -- would make a single phrase dozens of near-identical entries and split the
        -- recurrence signal across an object's own misreadings. reconcileText in
        -- @private-stock/core does the collapsing before anything reaches here.
        CREATE TABLE IF NOT EXISTS "MediaText" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            -- The elected reading, which may be one no single frame produced.
            "text" TEXT NOT NULL CHECK(length("text") BETWEEN 1 AND 500),
            -- Lowercased and whitespace-collapsed only. Deliberately *not* glyph-folded:
            -- folding 0 onto O is a claim about what the engine gets wrong, and this form
            -- has to survive being matched against a tag name somebody typed.
            "textNorm" TEXT NOT NULL CHECK(length("textNorm") BETWEEN 1 AND 500),
            -- Where it was first and last seen. Null for a still image, which has no
            -- timeline -- the same rule "Artifact"."atMs" follows.
            "firstAtMs" INTEGER,
            "lastAtMs" INTEGER,
            "confidence" REAL NOT NULL CHECK("confidence" BETWEEN 0 AND 1),
            "occurrences" INTEGER NOT NULL CHECK("occurrences" >= 1),
            -- Fraction of sampled frames it appeared in. The number that means something:
            -- a raw count is not comparable between a three-minute clip and a three-hour
            -- film, and this is what tells a persistent watermark from a title card.
            "stability" REAL NOT NULL CHECK("stability" BETWEEN 0 AND 1),
            -- Mean position, as fractions of the frame, so the same watermark compares
            -- equal at 1080p and 720p and a change to the pre-OCR scaling cannot silently
            -- stop anything matching.
            "boxX" REAL,
            "boxY" REAL,
            "boxW" REAL,
            "boxH" REAL,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "reviewState" TEXT CHECK("reviewState" IS NULL OR "reviewState" IN ('confirmed', 'edited', 'dismissed')),
            "originalText" TEXT CHECK("originalText" IS NULL OR length("originalText") BETWEEN 1 AND 500),
            "reviewedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "reviewedAt" DATETIME,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE
        );

        -- The review columns above (§5d "Reviewing what was read"), described here because a
        -- comment inside the table would become part of its stored SQL, which the migration
        -- that added them cannot reproduce.
        --
        -- "reviewState" is what a person decided. Null is a machine finding nobody has looked
        -- at, and the only kind a re-run replaces. 'dismissed' is a lifecycle state, not a soft
        -- delete: the row has to outlive the decision, or the next run reads the same watermark
        -- and the string comes back. It is what tells a re-run "this was seen and rejected".
        --
        -- "originalText" is the engine's reading before somebody corrected it, kept so the edit
        -- can be shown and undone, and so a re-run that misreads the same way recognises it.

        -- Every read is "the text for this item", and the cascade above needs it too: without
        -- an index on the child column SQLite scans the whole table to delete one item's rows.
        --
        -- Deliberately no UNIQUE on (mediaId, textNorm). The same string in two places is
        -- two findings, not one -- a title card that repeats the site name is different
        -- evidence from the watermark, with a different timestamp -- and the reconciler is
        -- the only writer, replacing an item's rows wholesale.
        CREATE INDEX IF NOT EXISTS "idx_MediaText_mediaId" ON "MediaText" ("mediaId");

        -- Expanding one string into the items that show it, keyed on mediaId for the cursor.
        -- "reviewState" rides along so the OCR match queue's pending count, which skips
        -- dismissed findings, is answered from the index without reading a finding's row: a
        -- page per finding on the NAS, and the count runs for every pair an accept moves (§5d
        -- "Counts"). Written only by a review action, which changes the state anyway.
        CREATE INDEX IF NOT EXISTS "idx_MediaText_textNorm" ON "MediaText" ("textNorm", "mediaId", "reviewState");
        -- The per-item review queue: only items with something nobody has looked at yet.
        CREATE INDEX IF NOT EXISTS "idx_MediaText_unreviewed"
            ON "MediaText" ("mediaId") WHERE "reviewState" IS NULL;

        -- One row per distinct string across the library, for the review page (§5d).
        --
        -- The page lists strings, not findings, and a library can hold hundreds of thousands of
        -- findings: a GROUP BY over "MediaText" per scroll would cost seconds. This holds the
        -- grouping already done, so a page is an index range.
        --
        -- Maintained by the triggers below, never by application code, for the reason the
        -- "Media" list columns are: a stale summary is a string that silently drops out of
        -- review, and nothing would ever say so. Sums rather than means, because a trigger can
        -- add and subtract a value but cannot recompute an average without the rows. "text" is
        -- the display form: whichever reading was written last.
        CREATE TABLE IF NOT EXISTS "MediaTextString" (
            "textNorm" TEXT NOT NULL PRIMARY KEY,
            "text" TEXT NOT NULL,
            "rowCount" INTEGER NOT NULL,
            "unreviewedCount" INTEGER NOT NULL,
            "confirmedCount" INTEGER NOT NULL,
            "editedCount" INTEGER NOT NULL,
            "dismissedCount" INTEGER NOT NULL,
            "confidenceSum" REAL NOT NULL,
            "stabilitySum" REAL NOT NULL
        );

        -- The Rules list's order, most-seen first. Written as the negated count, the exact
        -- expression the list sorts by, so that SQLite walks it rather than sorting the table
        -- and one row-value comparison continues a page from a cursor.
        CREATE INDEX IF NOT EXISTS "idx_MediaTextString_count"
            ON "MediaTextString" (-"rowCount", "textNorm");

        CREATE TRIGGER IF NOT EXISTS "MediaText_string_ai"
        AFTER INSERT ON "MediaText"
        BEGIN
            INSERT INTO "MediaTextString" ("textNorm", "text", "rowCount", "unreviewedCount", "confirmedCount", "editedCount", "dismissedCount", "confidenceSum", "stabilitySum")
            VALUES (new."textNorm", new."text", 1, new."reviewState" IS NULL, COALESCE(new."reviewState" = 'confirmed', 0), COALESCE(new."reviewState" = 'edited', 0), COALESCE(new."reviewState" = 'dismissed', 0), new."confidence", new."stability")
            ON CONFLICT ("textNorm") DO UPDATE SET
                "text" = excluded."text",
                "rowCount" = "rowCount" + 1,
                "unreviewedCount" = "unreviewedCount" + excluded."unreviewedCount",
                "confirmedCount" = "confirmedCount" + excluded."confirmedCount",
                "editedCount" = "editedCount" + excluded."editedCount",
                "dismissedCount" = "dismissedCount" + excluded."dismissedCount",
                "confidenceSum" = "confidenceSum" + excluded."confidenceSum",
                "stabilitySum" = "stabilitySum" + excluded."stabilitySum";
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaText_string_ad"
        AFTER DELETE ON "MediaText"
        BEGIN
            UPDATE "MediaTextString" SET
                "rowCount" = "rowCount" - 1,
                "unreviewedCount" = "unreviewedCount" - (old."reviewState" IS NULL),
                "confirmedCount" = "confirmedCount" - COALESCE(old."reviewState" = 'confirmed', 0),
                "editedCount" = "editedCount" - COALESCE(old."reviewState" = 'edited', 0),
                "dismissedCount" = "dismissedCount" - COALESCE(old."reviewState" = 'dismissed', 0),
                "confidenceSum" = "confidenceSum" - old."confidence",
                "stabilitySum" = "stabilitySum" - old."stability"
            WHERE "textNorm" = old."textNorm";
            DELETE FROM "MediaTextString" WHERE "textNorm" = old."textNorm" AND "rowCount" <= 0;
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaText_string_au"
        AFTER UPDATE OF "textNorm", "text", "reviewState", "confidence", "stability" ON "MediaText"
        BEGIN
            UPDATE "MediaTextString" SET
                "rowCount" = "rowCount" - 1,
                "unreviewedCount" = "unreviewedCount" - (old."reviewState" IS NULL),
                "confirmedCount" = "confirmedCount" - COALESCE(old."reviewState" = 'confirmed', 0),
                "editedCount" = "editedCount" - COALESCE(old."reviewState" = 'edited', 0),
                "dismissedCount" = "dismissedCount" - COALESCE(old."reviewState" = 'dismissed', 0),
                "confidenceSum" = "confidenceSum" - old."confidence",
                "stabilitySum" = "stabilitySum" - old."stability"
            WHERE "textNorm" = old."textNorm";
            DELETE FROM "MediaTextString" WHERE "textNorm" = old."textNorm" AND "rowCount" <= 0;
            INSERT INTO "MediaTextString" ("textNorm", "text", "rowCount", "unreviewedCount", "confirmedCount", "editedCount", "dismissedCount", "confidenceSum", "stabilitySum")
            VALUES (new."textNorm", new."text", 1, new."reviewState" IS NULL, COALESCE(new."reviewState" = 'confirmed', 0), COALESCE(new."reviewState" = 'edited', 0), COALESCE(new."reviewState" = 'dismissed', 0), new."confidence", new."stability")
            ON CONFLICT ("textNorm") DO UPDATE SET
                "text" = excluded."text",
                "rowCount" = "rowCount" + 1,
                "unreviewedCount" = "unreviewedCount" + excluded."unreviewedCount",
                "confirmedCount" = "confirmedCount" + excluded."confirmedCount",
                "editedCount" = "editedCount" + excluded."editedCount",
                "dismissedCount" = "dismissedCount" + excluded."dismissedCount",
                "confidenceSum" = "confidenceSum" + excluded."confidenceSum",
                "stabilitySum" = "stabilitySum" + excluded."stabilitySum";
        END;

        -- Which performers and sources an OCR string appears to name, and what an administrator
        -- decided about each (§5d "Tagging performers and sources from what was read").
        --
        -- One row per (string, tag) pair. Keyed on "textNorm" with no foreign key, because a
        -- "MediaTextString" row comes and goes with its findings and a decision has to outlive
        -- that: a rejected pair must stay rejected when the string is read again next week.
        -- "state" is null while nobody has decided. "pendingCount" is the number of items that
        -- carry the string and not the tag, refreshed by whoever changes either; it decides only
        -- which pairs are queued, and the page shows live counts. "batchId" is the bulk-tag
        -- batch an accept wrote, which is how it is undone.
        CREATE TABLE IF NOT EXISTS "OcrTagMatch" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "textNorm" TEXT NOT NULL CHECK(length("textNorm") BETWEEN 1 AND 500),
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "kind" TEXT NOT NULL CHECK("kind" IN ('exact', 'contains', 'near', 'manual')),
            "matchedText" TEXT NOT NULL CHECK(length("matchedText") BETWEEN 1 AND 500),
            "score" REAL NOT NULL CHECK("score" BETWEEN 0 AND 1),
            "state" TEXT CHECK("state" IS NULL OR "state" IN ('accepted', 'rejected')),
            "pendingCount" INTEGER NOT NULL DEFAULT 0,
            "batchId" TEXT REFERENCES "TagBatch" ("id") ON DELETE SET NULL,
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE ("textNorm", "tagId")
        );

        -- The queue: pairs still waiting for a decision, and accepted ones with new items.
        CREATE INDEX IF NOT EXISTS "idx_OcrTagMatch_queued"
            ON "OcrTagMatch" ("textNorm") WHERE "state" IS NOT 'rejected' AND "pendingCount" > 0;
        CREATE INDEX IF NOT EXISTS "idx_OcrTagMatch_state" ON "OcrTagMatch" ("state", "textNorm");
        CREATE INDEX IF NOT EXISTS "idx_OcrTagMatch_tagId" ON "OcrTagMatch" ("tagId");
        CREATE INDEX IF NOT EXISTS "idx_OcrTagMatch_batchId"
            ON "OcrTagMatch" ("batchId") WHERE "batchId" IS NOT NULL;
        CREATE INDEX IF NOT EXISTS "idx_OcrTagMatch_decidedByUserId"
            ON "OcrTagMatch" ("decidedByUserId") WHERE "decidedByUserId" IS NOT NULL;

        -- Items left out when a pair was accepted, so they do not come back as new.
        CREATE TABLE IF NOT EXISTS "OcrTagMatchSkip" (
            "matchId" TEXT NOT NULL REFERENCES "OcrTagMatch" ("id") ON DELETE CASCADE,
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            PRIMARY KEY ("matchId", "mediaId")
        );

        CREATE INDEX IF NOT EXISTS "idx_OcrTagMatchSkip_mediaId" ON "OcrTagMatchSkip" ("mediaId");

        -- Which tags an item's own text names: its filename and folders, its title, the text read
        -- out of its picture, the file's own tags (§5b "One rule for names"). Written by the one
        -- name matcher -- the OCR review's -- so "does this text name this tag" has one answer
        -- everywhere: Find untagged reads it, and so will the evidence a tag's page shows.
        -- Facts, not decisions: rebuilt for an item whenever its search document is, and for the
        -- library whenever the vocabulary changes. Every tag, private ones included; who may ask
        -- is the query's rule.
        CREATE TABLE IF NOT EXISTS "MediaMention" (
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "field" TEXT NOT NULL CHECK("field" IN ('filename', 'title', 'screen', 'metadata')),
            PRIMARY KEY ("mediaId", "tagId", "field")
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS "idx_MediaMention_tag" ON "MediaMention" ("tagId", "mediaId");

        -- Every face decision, one row a press (§5f "Decisions you can take back"): by a person,
        -- or by the app tagging by itself. What was said -- "is", "isNot", "notOnePerson",
        -- "later" -- of whom, from where ("surface"), the tag batch it made, and when it was
        -- undone. The confirmations, refusals, can't-tells and not-one-persons it wrote point at
        -- it ("decisionId"), so undoing it takes back exactly those. "faceCount" and "itemCount"
        -- are what it wrote, as it wrote it. "surface" 'earlier' is a decision made before they
        -- were kept, gathered from the rows one press wrote.
        CREATE TABLE IF NOT EXISTS "FaceDecision" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "actor" TEXT NOT NULL CHECK("actor" IN ('user', 'app')),
            "userId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "verdict" TEXT NOT NULL CHECK("verdict" IN ('is', 'isNot', 'notOnePerson', 'later')),
            "tagId" TEXT REFERENCES "Tag" ("id") ON DELETE SET NULL,
            "surface" TEXT NOT NULL CHECK(length("surface") <= 32),
            "tagBatchId" TEXT REFERENCES "TagBatch" ("id") ON DELETE SET NULL,
            "faceCount" INTEGER NOT NULL DEFAULT 0,
            "itemCount" INTEGER NOT NULL DEFAULT 0,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "undoneAt" DATETIME,
            "undoneByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS "idx_FaceDecision_created" ON "FaceDecision" ("createdAt" DESC);

        CREATE INDEX IF NOT EXISTS "idx_FaceDecision_tag"
            ON "FaceDecision" ("tagId", "createdAt" DESC) WHERE "tagId" IS NOT NULL;

        -- The faces an item shows (§5f), one row for each face the "faces" stage kept: at most
        -- twelve an item, the largest and surest. Where it is, as fractions of the picture it was
        -- found in -- a sprite tile, or a photograph's cover -- and how large and how sure. The
        -- vector is in the item's faces file, at "vectorIndex".
        --
        -- **What a person said is on the face**, not on a person in an item or a gathering, which
        -- are made anew each references run, so a decision filed against one would be lost.
        -- "tagId" is the performer somebody confirmed; a refusal is a "FaceRefusal"; "skippedAt"
        -- is "later" ("can't tell" before 2026-10-11); "scatteredAt" is "not one person". A re-run of the stage carries all three to the
        -- face found again at the same moment and place. "decidedHow" (and a refusal's "how") is
        -- how it was decided: 'shown' on screen, 'item' of the whole item, 'inferred' carried to a
        -- face nobody saw; null from before it was kept (§5f "Corrections stick"). "decisionId"
        -- is the "FaceDecision" that set its confirmation, can't-tell or not-one-person: a plain
        -- column, not a foreign key, so it can be dropped; decisions are never deleted.
        CREATE TABLE IF NOT EXISTS "Face" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "vectorIndex" INTEGER NOT NULL,
            "atMs" INTEGER,
            "x" REAL NOT NULL,
            "y" REAL NOT NULL,
            "w" REAL NOT NULL,
            "h" REAL NOT NULL,
            "eyes" REAL NOT NULL,
            "score" REAL NOT NULL,
            "tagId" TEXT REFERENCES "Tag" ("id") ON DELETE SET NULL,
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "skippedAt" DATETIME,
            "skippedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedHow" TEXT CHECK("decidedHow" IN ('shown', 'item', 'inferred')),
            "scatteredAt" DATETIME,
            "scatteredByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decisionId" TEXT CHECK(length("decisionId") <= 64),
            "appearanceId" TEXT CHECK(length("appearanceId") <= 64),
            UNIQUE ("mediaId", "vectorIndex")
        );

        CREATE INDEX IF NOT EXISTS "idx_Face_tag" ON "Face" ("tagId", "mediaId") WHERE "tagId" IS NOT NULL;

        CREATE INDEX IF NOT EXISTS "idx_Face_decision" ON "Face" ("decisionId") WHERE "decisionId" IS NOT NULL;

        CREATE INDEX IF NOT EXISTS "idx_Face_appearance" ON "Face" ("appearanceId") WHERE "appearanceId" IS NOT NULL;

        -- One person in one item (§5f "A person in a video"): what Suggestions shows and asks
        -- about. Written whole by the faceAnchors job each run, as "FaceMatch" is: the item's
        -- faces gathered at APPEARANCE_NEAR ("Face"."appearanceId", a plain column), the clearest
        -- of them, whether it is legible, and their centre scored against every reference. Nothing
        -- is filed against one -- decisions land on its faces -- so a run may make them anew.
        -- "newPersonId": the gathering of people who match nobody known it is part of (§5f "New
        -- people"), null where none worth asking about.
        CREATE TABLE IF NOT EXISTS "FaceAppearance" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "faceCount" INTEGER NOT NULL,
            "bestFaceId" TEXT NOT NULL CHECK(length("bestFaceId") <= 64),
            "legible" INTEGER CHECK("legible" IN (1)),
            "matchTagId" TEXT REFERENCES "Tag" ("id") ON DELETE SET NULL,
            "score" REAL,
            "second" REAL,
            "newPersonId" TEXT CHECK(length("newPersonId") <= 64)
        );

        CREATE INDEX IF NOT EXISTS "idx_FaceAppearance_media" ON "FaceAppearance" ("mediaId");

        CREATE INDEX IF NOT EXISTS "idx_FaceAppearance_newPerson"
            ON "FaceAppearance" ("newPersonId") WHERE "newPersonId" IS NOT NULL;

        CREATE INDEX IF NOT EXISTS "idx_FaceAppearance_match"
            ON "FaceAppearance" ("matchTagId", "score" DESC) WHERE "matchTagId" IS NOT NULL;

        -- "Not this performer", said of a face (§5f). Per face for the reason the confirmation is.
        -- "decisionId": the "FaceDecision" that wrote it.
        CREATE TABLE IF NOT EXISTS "FaceRefusal" (
            "faceId" TEXT NOT NULL REFERENCES "Face" ("id") ON DELETE CASCADE,
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "how" TEXT CHECK("how" IN ('shown', 'item', 'inferred')),
            "decisionId" TEXT CHECK(length("decisionId") <= 64),
            PRIMARY KEY ("faceId", "tagId")
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS "idx_FaceRefusal_tag" ON "FaceRefusal" ("tagId", "faceId");

        CREATE INDEX IF NOT EXISTS "idx_FaceRefusal_decision"
            ON "FaceRefusal" ("decisionId") WHERE "decisionId" IS NOT NULL;

        -- A confirmation follows the item's tag (§5f "Corrections stick"): whichever path takes a
        -- library performer off an item — an undo, a withdrawn rule, an untag — the item's faces
        -- stop being confirmed as them. Whether it also means "not them" is the caller's to say.
        CREATE TRIGGER IF NOT EXISTS "MediaTag_face_ad"
            AFTER DELETE ON "MediaTag" WHEN OLD."userId" IS NULL
        BEGIN
            UPDATE "Face"
               SET "tagId" = NULL, "decidedByUserId" = NULL, "decidedAt" = NULL,
                   "decidedHow" = NULL, "decisionId" = NULL
             WHERE "mediaId" = OLD."mediaId" AND "tagId" = OLD."tagId";
        END;

        -- "No single face" (§5f): a library performer face matching leaves out — no reference,
        -- no evidence from their tags, nothing proposed or tagged by a face.
        CREATE TABLE IF NOT EXISTS "PerformerNoFace" (
            "tagId" TEXT NOT NULL PRIMARY KEY REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) WITHOUT ROWID;

        -- One face, one score (§5f): every library performer's face reference — what it is built
        -- from; the vectors are in faces/anchors.bin — and every face's best match among them and
        -- the next best. Both written whole by the faceAnchors job.
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

        CREATE INDEX IF NOT EXISTS "idx_FaceMatch_tag" ON "FaceMatch" ("tagId", "score");

        -- Tagging by itself (§5f): what the rule would tag, and what became of it — 'proposed'
        -- (rewritten every run), 'right' or 'wrong' (checked in the "Would tag" list), 'applied',
        -- 'removed' (applied and taken back).
        -- A row checked or applied stays, so the rule never proposes it again. "rule": which rule
        -- proposed it -- 1 from single faces, 2 from a person in an item -- so a new rule's own
        -- tally of what was checked right is told apart before it may tag by itself.
        CREATE TABLE IF NOT EXISTS "FaceAutoTag" (
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "faceId" TEXT REFERENCES "Face" ("id") ON DELETE SET NULL,
            "score" REAL NOT NULL,
            "strongFaces" INTEGER NOT NULL,
            "named" INTEGER CHECK("named" IN (1)),
            "state" TEXT NOT NULL
                CHECK("state" IN ('proposed', 'right', 'wrong', 'applied', 'removed')),
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "rule" INTEGER NOT NULL DEFAULT 1 CHECK("rule" IN (1, 2)),
            PRIMARY KEY ("mediaId", "tagId")
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS "idx_FaceAutoTag_state" ON "FaceAutoTag" ("state", "tagId");

        -- "Not them on this item" (§5f "Decisions you can take back"): said from "Find untagged"
        -- (§5d), by taking the tag off by hand, or of the item from its page. The item leaves
        -- "Find untagged", "Likely" and everything that would tag it by itself. Adding the tag
        -- again withdraws it (trigger below): the later word wins. "decisionId": the press.
        CREATE TABLE IF NOT EXISTS "ItemRefusal" (
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "decisionId" TEXT REFERENCES "FaceDecision" ("id") ON DELETE SET NULL,
            PRIMARY KEY ("tagId", "mediaId")
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS "idx_ItemRefusal_decision"
            ON "ItemRefusal" ("decisionId") WHERE "decisionId" IS NOT NULL;

        -- The tag added again, by whatever path: "not them on this item" is withdrawn, and so are
        -- the item's face refusals that untagging made ('item'). Refusals of faces seen on screen
        -- stay: the tag says the performer is on the item, not that every face on it is theirs.
        CREATE TRIGGER IF NOT EXISTS "MediaTag_refusal_ai"
            AFTER INSERT ON "MediaTag" WHEN NEW."userId" IS NULL
        BEGIN
            DELETE FROM "ItemRefusal" WHERE "mediaId" = NEW."mediaId" AND "tagId" = NEW."tagId";
            DELETE FROM "FaceRefusal"
             WHERE "tagId" = NEW."tagId" AND "how" = 'item'
               AND "faceId" IN (SELECT "id" FROM "Face" WHERE "mediaId" = NEW."mediaId");
        END;

        -- The OCR test bench (§5d "Settings and the test bench"): one video read under the current
        -- settings and under a candidate, side by side.
        --
        -- Scratch, and never mixed with "MediaText": a trial reads what the candidate *would*
        -- store, so the comparison can be made without changing anything anybody searches. One
        -- row per video and side, replaced by the next run, so the table holds the latest
        -- comparison and nothing else. The findings are JSON because they are only ever read
        -- back whole, to be shown, and never queried into.
        CREATE TABLE IF NOT EXISTS "OcrTrial" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "side" TEXT NOT NULL CHECK("side" IN ('current', 'candidate')),
            "settingsJson" TEXT NOT NULL CHECK(length("settingsJson") <= 4000),
            "state" TEXT NOT NULL DEFAULT 'pending' CHECK("state" IN ('pending', 'running', 'done', 'failed')),
            "findingsJson" TEXT CHECK("findingsJson" IS NULL OR length("findingsJson") <= 200000),
            "framesRead" INTEGER,
            "elapsedMs" INTEGER,
            "error" TEXT CHECK("error" IS NULL OR length("error") <= 500),
            "createdByUserId" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "finishedAt" DATETIME,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL,
            UNIQUE ("mediaId", "side")
        );

        -- An OCR tuning run (§5d "Tuning against expected text"): a search for the settings that
        -- best read what an administrator says the bench's videos contain. The result is JSON
        -- because it is only ever read whole, to be shown; the readings it was scored from live
        -- in the on-disk cache, not here. History is capped, so this stays a handful of rows.
        CREATE TABLE IF NOT EXISTS "OcrTuneRun" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "state" TEXT NOT NULL DEFAULT 'pending' CHECK("state" IN ('pending', 'running', 'done', 'failed', 'cancelled')),
            "mode" TEXT NOT NULL CHECK("mode" IN ('quick', 'thorough')),
            "costWeight" TEXT NOT NULL CHECK("costWeight" IN ('low', 'medium', 'high')),
            "stage" TEXT CHECK("stage" IS NULL OR length("stage") <= 200),
            "progress" REAL NOT NULL DEFAULT 0 CHECK("progress" BETWEEN 0 AND 1),
            "resultJson" TEXT CHECK("resultJson" IS NULL OR length("resultJson") <= 2000000),
            "error" TEXT CHECK("error" IS NULL OR length("error") <= 500),
            "createdByUserId" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "finishedAt" DATETIME,
            FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS "idx_OcrTuneRun_createdAt" ON "OcrTuneRun" ("createdAt");

        -- ─────────────────────────────────────────────────────────────────────────────
        -- Search (§5c) — FTS5, one denormalised document per media.
        -- ─────────────────────────────────────────────────────────────────────────────

        -- The document itself, as an ordinary table.
        --
        -- FTS5 addresses rows by integer rowid, and ours are TEXT uuids. Without a real row
        -- holding that mapping, updating one item's document means finding it by an
        -- UNINDEXED column -- a full scan of the index, which at 200k items turns every
        -- re-index into a table scan. This table gives the mapping a real unique index.
        --
        -- It is also what makes deletion correct. The index opposite is external-content
        -- ("content=" below), so it stores no copy of the text, and removing an entry means
        -- replaying the *old* column values -- which only the triggers below can see.
        -- Deleting a Media row cascades to here, the cascade fires the delete trigger, and
        -- the index entry goes with it. Nothing has to remember to clean up.
        --
        -- "variants" is the other spellings of the curated columns -- adjacent words glued,
        -- known names found inside glued words (§5c "Word boundaries") -- so "auntmargaret" and
        -- "aunt margaret" find each other. Its own column so it ranks below the text it was
        -- derived from. (Described here rather than beside it: it was added by ALTER TABLE, and
        -- a comment there would not survive into a migrated database's schema.)
        CREATE TABLE IF NOT EXISTS "MediaSearchDoc" (
            -- Explicit AUTOINCREMENT: rowids must never be reused. FTS5 holds its own copy
            -- of the mapping, and a recycled rowid would attach one item's index entries to
            -- another item's document.
            "rowid" INTEGER PRIMARY KEY AUTOINCREMENT,
            "mediaId" TEXT NOT NULL UNIQUE,
            -- Separate columns so BM25 can weight them: a hit on the title should outrank
            -- the same word buried in a scraped attribute.
            "filename" TEXT NOT NULL DEFAULT '',
            "title" TEXT NOT NULL DEFAULT '',
            "performers" TEXT NOT NULL DEFAULT '',
            -- Every other facet, and anything a scraper invented. "series" and "studio" had
            -- columns of their own until the facets were cut back to three (§5b); with the
            -- vocabulary that narrow, a second curated column would only split one small
            -- field into two and give BM25 less to work with in each.
            "tags" TEXT NOT NULL DEFAULT '',
            "attributes" TEXT NOT NULL DEFAULT '',
            -- Library-wide notes only. A user's private note is deliberately absent: one
            -- shared index cannot hold per-user text without leaking it into other people's
            -- results.
            "notes" TEXT NOT NULL DEFAULT '',
            -- Text read out of the picture (§5d). Its own column rather than folded into
            -- attributes because it needs its own weight: it is machine-read and can be
            -- wrong, so it must never outrank anything a person curated -- and because a
            -- column can be emptied and rebuilt on its own when recognition improves.
            "ocr" TEXT NOT NULL DEFAULT '',
            "indexedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "variants" TEXT NOT NULL DEFAULT '',
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE
        );

        -- A match's item without its document (§5c, §20). FTS5 reads "mediaId" -- UNINDEXED,
        -- external content -- by fetching the whole document row, so a search turned every
        -- match into a document read: 1,160 pages for a one-letter search on the production
        -- replica. searchRepo maps the matched rowids through this instead (~160 pages for
        -- the whole library). Neither column changes after insert, so reindexing never
        -- writes it.
        CREATE INDEX IF NOT EXISTS "idx_MediaSearchDoc_rowid_mediaId"
            ON "MediaSearchDoc" ("rowid", "mediaId");

        -- "porter" stems English, so "performing" finds "performance"; unicode61 with
        -- remove_diacritics folds accents, so "Chloe" finds "Chloé". The prefix index is
        -- what makes as-you-type search real -- without it "wom" matches nothing until the
        -- word is finished.
        --
        -- Substring matching inside a word ("omba" -> "wombat") is deliberately not covered.
        -- That needs a second table with the trigram tokenizer, doubling index size for a
        -- case prefix search already handles; §5c records when to revisit.
        CREATE VIRTUAL TABLE IF NOT EXISTS "MediaSearch" USING fts5(
            "mediaId" UNINDEXED,
            "filename",
            "title",
            "performers",
            "tags",
            "attributes",
            "notes",
            "ocr",
            "variants",
            content = 'MediaSearchDoc',
            content_rowid = 'rowid',
            tokenize = 'porter unicode61 remove_diacritics 2',
            prefix = '2 3'
        );

        -- The canonical external-content sync triggers. Mechanical, not business logic: the
        -- *document* is assembled by the worker's index stage (§5c), which is re-runnable
        -- and batchable. These only keep the index agreeing with the row that stage wrote.
        CREATE TRIGGER IF NOT EXISTS "MediaSearchDoc_ai"
        AFTER INSERT ON "MediaSearchDoc" BEGIN
            INSERT INTO "MediaSearch" (
                "rowid", "mediaId", "filename", "title", "performers",
                "tags", "attributes", "notes", "ocr", "variants"
            ) VALUES (
                new."rowid", new."mediaId", new."filename", new."title", new."performers",
                new."tags", new."attributes", new."notes",
                new."ocr", new."variants"
            );
        END;

        -- A delete is an insert of the 'delete' command carrying the old values -- external
        -- content means FTS5 cannot read them back for itself.
        CREATE TRIGGER IF NOT EXISTS "MediaSearchDoc_ad"
        AFTER DELETE ON "MediaSearchDoc" BEGIN
            INSERT INTO "MediaSearch" (
                "MediaSearch", "rowid", "mediaId", "filename", "title", "performers",
                "tags", "attributes", "notes", "ocr", "variants"
            ) VALUES (
                'delete', old."rowid", old."mediaId", old."filename", old."title",
                old."performers", old."tags",
                old."attributes", old."notes", old."ocr", old."variants"
            );
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaSearchDoc_au"
        AFTER UPDATE ON "MediaSearchDoc" BEGIN
            INSERT INTO "MediaSearch" (
                "MediaSearch", "rowid", "mediaId", "filename", "title", "performers",
                "tags", "attributes", "notes", "ocr", "variants"
            ) VALUES (
                'delete', old."rowid", old."mediaId", old."filename", old."title",
                old."performers", old."tags",
                old."attributes", old."notes", old."ocr", old."variants"
            );
            INSERT INTO "MediaSearch" (
                "rowid", "mediaId", "filename", "title", "performers",
                "tags", "attributes", "notes", "ocr", "variants"
            ) VALUES (
                new."rowid", new."mediaId", new."filename", new."title", new."performers",
                new."tags", new."attributes", new."notes",
                new."ocr", new."variants"
            );
        END;

        -- ─────────────────────────────────────────────────────────────────────────────
        -- Per-user state (§6). Nothing subjective lives on Media.
        -- ─────────────────────────────────────────────────────────────────────────────

        -- The comments inside this table are part of its stored definition, so they stay as the
        -- baseline wrote them: "resumePositionMs" was dropped in place (§14b) and a rewrite here
        -- would differ from every database that replayed the drop.
        CREATE TABLE IF NOT EXISTS "UserMedia" (
            "userId" TEXT NOT NULL,
            "mediaId" TEXT NOT NULL,
            "rating" INTEGER CHECK("rating" IS NULL OR "rating" BETWEEN 1 AND 5),
            "favorite" INTEGER CHECK("favorite" IS NULL OR "favorite" = 1),
            "hidden" INTEGER CHECK("hidden" IS NULL OR "hidden" = 1),
            "viewCount" INTEGER NOT NULL DEFAULT 0,
            "lastViewedAt" DATETIME,
            -- When this viewer finished with the item, or null (§14b).
            --
            -- "Watched" is thirty seconds of uninterrupted playback, or the whole item when
            -- it is shorter than that. The short-item clause is not a detail: without it,
            -- nothing under thirty seconds could ever be marked watched, and a library of
            -- short clips would carry a feature that silently never applied to it.
            --
            -- A stored column rather than a derivation, and the alternatives are the reason.
            -- "Opened at all" (viewCount > 0) marks a video watched for a mistaken click.
            -- "Reached the end" (resumePositionMs near durationMs) is wrong for the long film
            -- you stopped ten minutes early. Both are free -- no column, no reset -- and
            -- neither can be overridden, which is the failure that matters: being unable to
            -- say "yes, I have seen this" is worse than having to store one timestamp.
            --
            -- A timestamp rather than a flag, so "watched recently" stays askable and the
            -- column says when as well as whether. Null is unwatched; there is no 0.
            "watchedAt" DATETIME,
            "note" TEXT CHECK("note" IS NULL OR length("note") <= 2000),
            "updatedAt" DATETIME NOT NULL,
            PRIMARY KEY ("userId", "mediaId"),
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE
        );

        -- Covering index for rating sorts; partial indexes for the flags, which stay tiny
        -- precisely because false is stored as NULL.
        CREATE INDEX IF NOT EXISTS "idx_UserMedia_rating"
            ON "UserMedia" ("userId", "rating", "mediaId");
        CREATE INDEX IF NOT EXISTS "idx_UserMedia_favorite"
            ON "UserMedia" ("userId", "mediaId") WHERE "favorite" IS NOT NULL;
        CREATE INDEX IF NOT EXISTS "idx_UserMedia_hidden"
            ON "UserMedia" ("userId", "mediaId") WHERE "hidden" IS NOT NULL;
        -- The "Recently viewed" shelf (§6): newest first, and only rows somebody has viewed.
        CREATE INDEX IF NOT EXISTS "idx_UserMedia_viewed"
            ON "UserMedia" ("userId", "lastViewedAt") WHERE "lastViewedAt" IS NOT NULL;
        -- For deleting an item (§20): every index above leads with the viewer, so the cascade
        -- read two of them end to end. View pings are updates and never move "mediaId", so
        -- this is written once per viewer per item.
        CREATE INDEX IF NOT EXISTS "idx_UserMedia_mediaId" ON "UserMedia" ("mediaId");

        -- A viewer's own marks on a tag (§6 "Favourite tags"), the tag counterpart of
        -- UserMedia: the shared Tag row holds nothing subjective. Named for the pair rather
        -- than the feature, so the next per-person thing about a tag has somewhere to go.
        CREATE TABLE IF NOT EXISTS "UserTag" (
            "userId" TEXT NOT NULL,
            "tagId" TEXT NOT NULL,
            "favorite" INTEGER CHECK("favorite" IS NULL OR "favorite" = 1),
            "updatedAt" DATETIME NOT NULL,
            PRIMARY KEY ("userId", "tagId"),
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS "idx_UserTag_favorite"
            ON "UserTag" ("userId", "tagId") WHERE "favorite" IS NOT NULL;
        -- The cascade from Tag, and a merge repointing a tag's rows, look up by tag.
        CREATE INDEX IF NOT EXISTS "idx_UserTag_tag" ON "UserTag" ("tagId");

        CREATE TABLE IF NOT EXISTS "LibraryAccess" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "rootId" TEXT NOT NULL,
            "allowed" INTEGER CHECK("allowed" IS NULL OR "allowed" = 1),
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("rootId") REFERENCES "MediaRoot" ("id") ON DELETE CASCADE,
            UNIQUE ("userId", "rootId")
        );

        CREATE TABLE IF NOT EXISTS "Playlist" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "ownerId" TEXT NOT NULL,
            "name" TEXT NOT NULL CHECK(length("name") BETWEEN 1 AND 200),
            "description" TEXT CHECK("description" IS NULL OR length("description") <= 1000),
            "visibility" TEXT NOT NULL DEFAULT 'private'
                CHECK("visibility" IN ('private', 'shared')),
            -- Which order the list opens in when the address says nothing (§14b). NULL is
            -- "nobody has chosen", which is the stored order. The toggle in the toolbar is a
            -- choice about this visit and never writes here.
            "sortMode" TEXT CHECK("sortMode" IS NULL OR "sortMode" IN ('stored', 'shuffle')),
            -- How the owner arranged their own sidebar. Meaningful only to them: a pin is a
            -- statement about your own list of lists, and one person's ordering of their
            -- playlists says nothing about where another person wants to see them (§6).
            "pinned" INTEGER CHECK("pinned" IS NULL OR "pinned" = 1),
            "position" INTEGER NOT NULL DEFAULT 0,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE,
            -- Matching SavedFilter, which has had this since it was written. Three playlists
            -- called "Christmas" are indistinguishable everywhere they are listed, and the
            -- one you meant is not the one the sidebar happens to show first.
            UNIQUE ("ownerId", "name")
        );

        CREATE TABLE IF NOT EXISTS "PlaylistItem" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "playlistId" TEXT NOT NULL,
            "mediaId" TEXT NOT NULL,
            "position" INTEGER NOT NULL,
            "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("playlistId") REFERENCES "Playlist" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            UNIQUE ("playlistId", "mediaId")
        );

        CREATE INDEX IF NOT EXISTS "idx_PlaylistItem_playlistId_position"
            ON "PlaylistItem" ("playlistId", "position");

        CREATE TABLE IF NOT EXISTS "SavedFilter" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "name" TEXT NOT NULL CHECK(length("name") BETWEEN 1 AND 200),
            "queryJson" TEXT NOT NULL CHECK(length("queryJson") <= 8000),
            "description" TEXT CHECK("description" IS NULL OR length("description") <= 1000),
            -- Shared filters are read-only to everyone else, exactly as playlists are. The
            -- query is re-run as whoever is looking, so access is decided per viewer rather
            -- than inherited from the person who saved it (§6).
            "visibility" TEXT NOT NULL DEFAULT 'private'
                CHECK("visibility" IN ('private', 'shared')),
            -- Whose ratings the query asks about: whoever is looking, or the person who saved
            -- it. Only ever meaningful for a shared filter that tests favourites or ratings,
            -- and it is the whole filter's choice rather than one per predicate -- "Dad's
            -- version of this list" is a sentence people can hold, where a query mixing his
            -- ratings with yours is not (§6).
            --
            -- A column rather than part of the stored query, because the query also travels
            -- in URLs for the ordinary grid, where there is nobody but the viewer to resolve
            -- against.
            "resolveAs" TEXT NOT NULL DEFAULT 'viewer'
                CHECK("resolveAs" IN ('viewer', 'owner')),
            "pinned" INTEGER CHECK("pinned" IS NULL OR "pinned" = 1),
            "position" INTEGER NOT NULL DEFAULT 0,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE,
            UNIQUE ("userId", "name")
        );

        -- Where one person wants one collection in their own sidebar (§14b).
        --
        -- "Collection" is the umbrella for the two things that expose a subset of the library:
        -- a saved view, which is a query, and a playlist, which is a list. They are the same
        -- idea with different mechanics, and everything about *who may see one* and *where it
        -- sits* is deliberately identical between them.
        --
        -- This table exists because a pin had nowhere to live for anybody but an owner. The
        -- pin columns on Playlist and SavedFilter are the owner's, and on a *shared*
        -- collection the owner is an administrator, so their pin is the household's default --
        -- the curated baseline a new account arrives to. Without a per-viewer override that
        -- default would be permanent, and one person would own everybody's sidebar.
        --
        -- Three states, and the absence of a row is one of them:
        --
        --   * no row          -- no opinion; follow the curated default
        --   * "pinned" = 1    -- I want this in my sidebar
        --   * "pinned" IS NULL -- I have taken this out of my sidebar
        --
        -- So the row means "I have decided", and the column means what I decided. That is why
        -- a row with a NULL "pinned" is meaningful here and is not the same as no row, which
        -- is the one place in the schema where the 1-or-NULL convention carries information by
        -- its absence rather than only by its value.
        CREATE TABLE IF NOT EXISTS "CollectionPin" (
            "userId" TEXT NOT NULL,
            "kind" TEXT NOT NULL CHECK("kind" IN ('filter', 'playlist')),
            "collectionId" TEXT NOT NULL,
            "pinned" INTEGER CHECK("pinned" IS NULL OR "pinned" = 1),
            -- Where in this person's own sidebar, for a collection they pinned themselves.
            -- NULL falls back to the owner's ordering, which is what a curated default brings
            -- with it.
            "position" INTEGER,
            "updatedAt" DATETIME NOT NULL,
            PRIMARY KEY ("userId", "kind", "collectionId"),
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
        );

        -- No foreign key on "collectionId": it names a row in one of two tables depending on
        -- "kind", which SQLite cannot express. The orphan that follows a deleted collection is
        -- harmless: every read joins from the collection to here, so a pin nothing points at
        -- is never consulted, and it weighs one short row until the account is deleted.
        CREATE INDEX IF NOT EXISTS "idx_CollectionPin_lookup"
            ON "CollectionPin" ("kind", "collectionId");

        -- rowsJson is an ordered list of shelf descriptors (§6).
        CREATE TABLE IF NOT EXISTS "HomeLayout" (
            "userId" TEXT NOT NULL PRIMARY KEY,
            "rowsJson" TEXT NOT NULL CHECK(length("rowsJson") <= 20000),
            "updatedAt" DATETIME NOT NULL,
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS "UserPref" (
            "userId" TEXT NOT NULL,
            "key" TEXT NOT NULL CHECK(length("key") BETWEEN 1 AND 100),
            "value" TEXT NOT NULL CHECK(length("value") <= 2000),
            "updatedAt" DATETIME NOT NULL,
            PRIMARY KEY ("userId", "key"),
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
        );

        -- ─────────────────────────────────────────────────────────────────────────────
        -- Clips and reels (§14d)
        -- ─────────────────────────────────────────────────────────────────────────────

        -- A span of one item, marked by one person.
        --
        -- Private raw material (§14d). A clip is a working note about where something happens
        -- and most are never used, so unlike a capture (§9) it is not library-wide to read:
        -- /clips and the item page list your own, and the only way anybody else sees one is as
        -- a span inside a reel they can open. The reel grants the read, not the library.
        CREATE TABLE IF NOT EXISTS "Clip" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            -- Nullable, ON DELETE SET NULL, exactly as "Artifact"."createdByUserId" (§9): a clip
            -- outlives the account that made it and loses only its attribution, so deleting a
            -- person does not break the reels their spans are in. An unattributed clip is
            -- admin-only to retime or discard -- nobody can claim it, and the alternative is
            -- that deleting an account quietly hands that person's spans to everyone.
            "userId" TEXT,
            "startMs" INTEGER NOT NULL,
            "endMs" INTEGER NOT NULL,
            "label" TEXT CHECK("label" IS NULL OR length("label") <= 200),
            -- How fast this span is meant to be seen. NULL means 1.0 and is the only way
            -- "nobody chose" is spelled -- the same NULL-means-undecided as "Playlist"."sortMode"
            -- and MediaQuery.direction, rather than a stored 1.0 that cannot be told from a
            -- deliberate one. Bounded by what the player's own rate control allows (§14's keymap
            -- is 0.25x-4x), because a rate the element refuses is not a span anybody can watch.
            --
            -- It multiplies with the viewer's rate rather than replacing it: the clip's speed is
            -- part of the cut, the viewer's control is about how fast they are getting through
            -- the reel, and either one silently overriding the other loses a real intention.
            "speed" REAL CHECK("speed" IS NULL OR ("speed" >= 0.25 AND "speed" <= 4)),
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL,
            CHECK("startMs" >= 0),
            CHECK("endMs" > "startMs")
        );

        -- The item page, in timeline order. Clips are listed by where they occur in the video
        -- and never by when they were made -- §9's rule for the frame strip, for the same
        -- reason: scanning the strip is scanning forward through the item, and sorting by
        -- creation shunts everything along by one every time somebody marks another.
        CREATE INDEX IF NOT EXISTS "idx_Clip_media_start" ON "Clip" ("mediaId", "startMs");

        -- The browser's default order: the clips you made last night going through the holiday
        -- footage are the ones you are about to do something with.
        CREATE INDEX IF NOT EXISTS "idx_Clip_user_created" ON "Clip" ("userId", "createdAt" DESC);

        -- The library's vocabulary applied to a span (§14d "Tagging clips"). A separate join
        -- from "MediaTag" on purpose: "the video is at the pool" and "this span is somebody
        -- jumping in" are two facts, and /clips searches them as two fields.
        --
        -- No "userId": every assignment on a clip is for the clip's owner, and a column that
        -- restated it would be a copy free to drift. The pairing with "Tag"."ownerId" is
        -- enforced in clipTagRepo. No "source" or "confidence" either -- only the owner writes,
        -- and only by typing. "batchId" is as "MediaTag"."batchId": the bulk apply that wrote
        -- the row, so it can be undone.
        CREATE TABLE IF NOT EXISTS "ClipTag" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "clipId" TEXT NOT NULL,
            "tagId" TEXT NOT NULL,
            "position" INTEGER,
            "batchId" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("clipId") REFERENCES "Clip" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("batchId") REFERENCES "TagBatch" ("id") ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS "idx_ClipTag_unique" ON "ClipTag" ("clipId", "tagId");
        -- Merge, prune and the /clips facet lists all read by tag.
        CREATE INDEX IF NOT EXISTS "idx_ClipTag_tagId" ON "ClipTag" ("tagId");
        CREATE INDEX IF NOT EXISTS "idx_ClipTag_batchId"
            ON "ClipTag" ("batchId") WHERE "batchId" IS NOT NULL;

        -- An ordered arrangement of spans. A playlist is whole items in an order; a reel is
        -- spans in an order, and that is the whole difference between them (§14d).
        --
        -- Shaped like "Playlist" and "SavedFilter" where sharing is concerned -- the same
        -- visibility vocabulary, the same UNIQUE(owner, name), the same admin-only share
        -- gesture -- and deliberately unlike them everywhere else: no "pinned" and no
        -- "position", because reels are numerous enough that a sidebar is the wrong place for
        -- them. They have their own index at /reels, sorted and searched and paged, and they
        -- take no "CollectionPin" row.
        --
        -- No "sortMode" either. A reel does not shuffle: a playlist's order is a convenience
        -- somebody arranged, and a reel's order is the cut.
        CREATE TABLE IF NOT EXISTS "Reel" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "ownerId" TEXT NOT NULL,
            "name" TEXT NOT NULL CHECK(length("name") BETWEEN 1 AND 200),
            "description" TEXT CHECK("description" IS NULL OR length("description") <= 1000),
            "visibility" TEXT NOT NULL DEFAULT 'private'
                CHECK("visibility" IN ('private', 'shared')),
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE,
            -- Three reels called "Christmas" are indistinguishable everywhere they are listed,
            -- which "SavedFilter" has known since it was written and "Playlist" learned in §14c.
            UNIQUE ("ownerId", "name")
        );

        CREATE INDEX IF NOT EXISTS "idx_Reel_owner" ON "Reel" ("ownerId");

        -- The index's default order.
        CREATE INDEX IF NOT EXISTS "idx_Reel_updated" ON "Reel" ("updatedAt" DESC);

        -- One span at one position in one reel.
        --
        -- "clipId" is the single source of truth for the span: no copied timecodes, so retiming
        -- a clip changes every reel holding it. That is survivable only because a reel holds
        -- nothing but its owner's clips (§14d) -- enforced in "reelService", so every reel an
        -- edit reaches is one the editor owns and can be shown by name before the press.
        CREATE TABLE IF NOT EXISTS "ReelItem" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "reelId" TEXT NOT NULL,
            "clipId" TEXT NOT NULL,
            "position" INTEGER NOT NULL,
            "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("reelId") REFERENCES "Reel" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("clipId") REFERENCES "Clip" ("id") ON DELETE CASCADE
            -- No UNIQUE("reelId", "clipId"): a refrain is a legitimate cut, so the same span may
            -- appear twice. That is also why "removeItem" takes a "ReelItem"."id" rather than a
            -- clip id -- a clip id does not name a row here.
            --
            -- No UNIQUE("reelId", "position") either, and that one is load-bearing. Positions
            -- are kept dense by renumbering -- UPDATE ... SET "position" = "position" - 1 WHERE
            -- "position" > ? -- and SQLite does not define the row order of an UPDATE, so
            -- against a unique index that statement can collide with itself part way through.
            -- The failure would be an intermittent constraint violation on a removal, which
            -- reads as a database fault rather than as a schema decision. "PlaylistItem" has
            -- always had a plain index here for exactly this reason.
        );

        CREATE INDEX IF NOT EXISTS "idx_ReelItem_reelId_position"
            ON "ReelItem" ("reelId", "position");

        -- "Which reels hold this clip" is asked on every clip read, before every retime and
        -- every discard, and by "purge" so it can renumber what a cascade shortened (§10c).
        -- Without this it is a table scan each time.
        CREATE INDEX IF NOT EXISTS "idx_ReelItem_clipId" ON "ReelItem" ("clipId");

        -- ─────────────────────────────────────────────────────────────────────────────
        -- Operations: scanning, jobs, trash, settings, errors
        -- ─────────────────────────────────────────────────────────────────────────────

        -- What has been done to each item, and what is left to do (§7b).
        --
        -- One row per (item, stage). Replaces four separate conventions -- a timestamp for
        -- probing, a version integer for the search index, the existence of an Artifact row
        -- for covers, a non-null column for file hashes -- and the five hand-written "what
        -- needs work" queries that went with them.
        --
        -- Those recorded what *output exists*, which is a different question from what
        -- *processing has happened*. They agree until a stage legitimately produces nothing,
        -- and then "no output" cannot be told apart from "never tried": a blank image has no
        -- perceptual hash, and the sweep re-queued it every five minutes for the life of the
        -- library.
        --
        -- The output tables are unchanged. Artifact, Variant and the pHash tables hold what
        -- was produced; this holds the fact that a stage ran and how it went.
        CREATE TABLE IF NOT EXISTS "MediaStage" (
            "mediaId" TEXT NOT NULL,
            -- Open text, not a CHECK. SQLite cannot alter a CHECK constraint, so a closed
            -- vocabulary would make every new capability a table rebuild after release --
            -- which is exactly the corner "MediaTag"."source" is painted into, and the
            -- reason 'ocr' had to be reserved there before anything used it. A stage name is
            -- also its job kind.
            "stage" TEXT NOT NULL CHECK(length("stage") BETWEEN 1 AND 40),
            -- The recipe version this outcome reflects. Below the registry's current value
            -- means the work is stale and the sweep will redo it.
            "version" INTEGER NOT NULL DEFAULT 1,
            -- Closed on purpose, unlike the stage name: these four are a complete account of
            -- how an attempt can end, and 'empty' is the one the old scheme could not say.
            "state" TEXT NOT NULL
                CHECK("state" IN ('done', 'empty', 'failed', 'skipped')),
            "attempts" INTEGER NOT NULL DEFAULT 0,
            "detail" TEXT CHECK("detail" IS NULL OR length("detail") <= 500),
            -- Set when a person asked for this rather than the sweep scheduling it, so an
            -- admin view can tell a requested pass from an automatic one.
            "requestedByUserId" TEXT,
            "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "recipe" TEXT CHECK("recipe" IS NULL OR length("recipe") <= 100),
            PRIMARY KEY ("mediaId", "stage"),
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("requestedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL
        );

        -- "recipe" says which configuration produced an outcome, for a stage whose output
        -- depends on admin settings: OCR records its settings revision (§5d). Described here
        -- rather than inside the table, where a comment would become part of its stored SQL.

        -- The sweep's index: for one stage, the items whose outcome is stale or absent (§20).
        -- Covering, and keyed by item within a stage, because the sweep asks it once per item
        -- in id order: one stage's slice is a short in-order walk, and no stage row is read.
        CREATE INDEX IF NOT EXISTS "idx_MediaStage_stage_mediaId"
            ON "MediaStage" ("stage", "mediaId", "version", "state", "attempts");
        -- Partial, so the retry scan reads only the failures rather than the library.
        CREATE INDEX IF NOT EXISTS "idx_MediaStage_failed"
            ON "MediaStage" ("stage", "attempts") WHERE "state" = 'failed';
        -- The sweep's per-stage marks (§20): the newest outcome of a (stage, state, version) is
        -- the last entry of its range, one descent. It was also the progress view's index until
        -- the counting itself became too expensive; that view reads "MediaStageTally" now.
        CREATE INDEX IF NOT EXISTS "idx_MediaStage_stage_state_version"
            ON "MediaStage" ("stage", "state", "version");

        -- The progress view's totals, kept rather than counted (§13c, §20): per (stage, state,
        -- version), how many stage rows belong to an item the library shows. Counting them read
        -- the whole index above plus every unlisted item's scattered stage rows -- seconds on
        -- the NAS, on the one thread that serves every request. Reading this is a page.
        --
        -- Maintained by the triggers below and never by application code, like the "Media"
        -- list columns and "MediaTextString": a stale count is a bar that is silently wrong. A
        -- stage row enters or leaves the count from either side -- written, rewritten or removed
        -- while its item is listable, or its item changing listability -- and a deleted item
        -- takes its rows away in BEFORE DELETE, because in the cascade that follows the parent
        -- is already gone and the stage-row trigger can no longer tell whose rows they were.
        -- An item has one row per stage, so each adjustment is ±1 per matching row. Rows that
        -- reach zero stay and are filtered when read.
        CREATE TABLE IF NOT EXISTS "MediaStageTally" (
            "stage" TEXT NOT NULL CHECK(length("stage") BETWEEN 1 AND 40),
            "state" TEXT NOT NULL CHECK("state" IN ('done', 'empty', 'failed', 'skipped')),
            "version" INTEGER NOT NULL,
            "count" INTEGER NOT NULL,
            PRIMARY KEY ("stage", "state", "version")
        );

        CREATE TRIGGER IF NOT EXISTS "MediaStage_tally_ai"
        AFTER INSERT ON "MediaStage"
        WHEN EXISTS (SELECT 1 FROM "Media" WHERE "id" = new."mediaId" AND "listable" = 1)
        BEGIN
            INSERT INTO "MediaStageTally" ("stage", "state", "version", "count")
            VALUES (new."stage", new."state", new."version", 1)
            ON CONFLICT ("stage", "state", "version") DO UPDATE SET "count" = "count" + 1;
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaStage_tally_ad"
        AFTER DELETE ON "MediaStage"
        WHEN EXISTS (SELECT 1 FROM "Media" WHERE "id" = old."mediaId" AND "listable" = 1)
        BEGIN
            UPDATE "MediaStageTally" SET "count" = "count" - 1
             WHERE "stage" = old."stage" AND "state" = old."state" AND "version" = old."version";
        END;

        CREATE TRIGGER IF NOT EXISTS "MediaStage_tally_au"
        AFTER UPDATE OF "mediaId", "stage", "state", "version" ON "MediaStage"
        WHEN old."mediaId" IS NOT new."mediaId" OR old."stage" IS NOT new."stage"
          OR old."state" IS NOT new."state" OR old."version" IS NOT new."version"
        BEGIN
            UPDATE "MediaStageTally" SET "count" = "count" - 1
             WHERE "stage" = old."stage" AND "state" = old."state" AND "version" = old."version"
               AND EXISTS (SELECT 1 FROM "Media" WHERE "id" = old."mediaId" AND "listable" = 1);
            INSERT INTO "MediaStageTally" ("stage", "state", "version", "count")
            SELECT new."stage", new."state", new."version", 1
             WHERE EXISTS (SELECT 1 FROM "Media" WHERE "id" = new."mediaId" AND "listable" = 1)
            ON CONFLICT ("stage", "state", "version") DO UPDATE SET "count" = "count" + 1;
        END;

        CREATE TRIGGER IF NOT EXISTS "Media_tally_au"
        AFTER UPDATE OF "listable" ON "Media"
        WHEN old."listable" IS NOT new."listable"
        BEGIN
            UPDATE "MediaStageTally" SET "count" = "count" - 1
             WHERE old."listable" = 1
               AND ("stage", "state", "version") IN (
                   SELECT "stage", "state", "version" FROM "MediaStage" WHERE "mediaId" = old."id");
            INSERT INTO "MediaStageTally" ("stage", "state", "version", "count")
            SELECT "stage", "state", "version", 1 FROM "MediaStage"
             WHERE "mediaId" = new."id" AND new."listable" = 1
            ON CONFLICT ("stage", "state", "version") DO UPDATE SET "count" = "count" + 1;
        END;

        CREATE TRIGGER IF NOT EXISTS "Media_tally_bd"
        BEFORE DELETE ON "Media"
        WHEN old."listable" = 1
        BEGIN
            UPDATE "MediaStageTally" SET "count" = "count" - 1
             WHERE ("stage", "state", "version") IN (
                   SELECT "stage", "state", "version" FROM "MediaStage" WHERE "mediaId" = old."id");
        END;

        CREATE TABLE IF NOT EXISTS "Scan" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "rootId" TEXT NOT NULL,
            "state" TEXT NOT NULL DEFAULT 'running'
                CHECK("state" IN ('running', 'done', 'failed')),
            "filesSeen" INTEGER NOT NULL DEFAULT 0,
            "filesAdded" INTEGER NOT NULL DEFAULT 0,
            "filesChanged" INTEGER NOT NULL DEFAULT 0,
            "filesMissing" INTEGER NOT NULL DEFAULT 0,
            -- Recognised as the same file under a new name, rather than counted as one
            -- disappearance and one arrival (§7).
            "filesMoved" INTEGER NOT NULL DEFAULT 0,
            "lastError" TEXT CHECK("lastError" IS NULL OR length("lastError") <= 2000),
            "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "finishedAt" DATETIME,
            FOREIGN KEY ("rootId") REFERENCES "MediaRoot" ("id") ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS "idx_Scan_rootId_startedAt" ON "Scan" ("rootId", "startedAt");
        -- The scan in progress, asked on every library poll. History is never pruned, so
        -- without this the question reads every scan ever run to find the one or none running.
        CREATE INDEX IF NOT EXISTS "idx_Scan_running" ON "Scan" ("startedAt")
            WHERE "state" = 'running';

        -- A real queue, not a to-do list (§18.7). Claiming is one atomic UPDATE; a claimed
        -- job with a stale heartbeat returns to pending, which is how a killed worker's
        -- work gets picked up again.
        CREATE TABLE IF NOT EXISTS "Job" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "kind" TEXT NOT NULL CHECK(length("kind") BETWEEN 1 AND 40),
            "mediaId" TEXT,
            "fileId" TEXT,
            "payloadJson" TEXT CHECK("payloadJson" IS NULL OR length("payloadJson") <= 8000),
            "priority" INTEGER NOT NULL DEFAULT 100,
            "state" TEXT NOT NULL DEFAULT 'pending'
                CHECK("state" IN ('pending', 'claimed', 'done', 'failed', 'cancelled')),
            "attempts" INTEGER NOT NULL DEFAULT 0,
            "maxAttempts" INTEGER NOT NULL DEFAULT 3,
            "progress" REAL,
            "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "startedAt" DATETIME,
            "finishedAt" DATETIME,
            "heartbeatAt" DATETIME,
            "claimedBy" TEXT CHECK("claimedBy" IS NULL OR length("claimedBy") <= 100),
            "lastError" TEXT CHECK("lastError" IS NULL OR length("lastError") <= 4000),
            -- The owning item's "addedAt", copied at enqueue (§7d).
            --
            -- The queue is ordered by the same key the library is, so work happens in the
            -- order somebody will actually look at it. Without this the two orders are
            -- unrelated: jobs come out in "createdAt" order, which is the order files were
            -- walked, while the grid defaults to newest-first -- so a fresh import processes
            -- from the end the viewer reaches last, and the first page stays blank until
            -- nearly everything else is done.
            --
            -- Copied rather than joined because the claim query runs twice a second over
            -- every pending row, and a join to "Media" to sort by a column of it would mean a
            -- primary-key probe per candidate on every claim.
            --
            -- Null for work that belongs to the library rather than to an item -- a scan, a
            -- duplicate pass. Those sort last within their priority band, which is correct:
            -- a whole-library sweep has no reason to precede the items it is sweeping.
            "mediaAddedAt" DATETIME,
            -- Set when a person asked for this job rather than a sweep scheduling it (§7c).
            --
            -- It already rode in "payloadJson" and that was enough while the only reader was
            -- the handler recording an outcome. The throttle made it a scheduling input:
            -- requested work is exempt, so the claim query has to ask "did someone ask for
            -- this" about rows it has not selected yet, and json_extract over every pending
            -- job is the wrong shape for the statement that runs twice a second.
            --
            -- Priority looks like it could stand in for this and cannot. Requested work is
            -- enqueued at the stage's priority minus fifty, so it outranks the same stage's
            -- sweep -- but a requested phash still sits below an automatic cover, and there
            -- is no threshold that separates the two meanings across kinds.
            "requestedByUserId" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("fileId") REFERENCES "MediaFile" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("requestedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL
        );

        -- The claim query's index: pending jobs, best priority first, then newest item.
        --
        -- **The ordering columns lead, and that is the whole point.** They used to follow
        -- "availableAt", which is an inequality and therefore ends SQLite's ability to read what
        -- comes after it in order -- so every claim sorted every pending row in a temp B-tree to
        -- take one. Led by the ordering instead, the index is walked in the order the claim asks
        -- for and LIMIT 1 stops at the first match: 1.587 ms to 0.005 ms at 5,000 pending rows,
        -- and 1.2-3.7 *seconds* on the NAS where those rows came off a contended disk (§7d, §20).
        -- "availableAt" and "kind" ride along as filters so the table is read once, not per
        -- candidate. Partial because only pending rows can be claimed, which also means a claim
        -- leaves the index rather than being rewritten inside it.
        CREATE INDEX IF NOT EXISTS "idx_Job_claim"
            ON "Job" ("priority", "mediaAddedAt" DESC, "createdAt", "availableAt", "kind")
            WHERE "state" = 'pending';
        CREATE INDEX IF NOT EXISTS "idx_Job_kind_state" ON "Job" ("kind", "state");
        -- One item's history of one kind of work: "has anything been queued since?" for
        -- standing failures and settled items, and "is one already queued?" before an enqueue.
        -- Neither column changes after insert, so claims, beats and completions never touch it.
        --
        -- Item first, so it is also what deleting an item probes for that item's jobs: every
        -- query above pins both columns and is served in either order, and led by "kind" the
        -- foreign-key check scanned the queue on every purge (§20). "fileId" needs its own for
        -- the same reason, and like "mediaId" is written once per enqueue and never again.
        CREATE INDEX IF NOT EXISTS "idx_Job_mediaId_kind" ON "Job" ("mediaId", "kind");
        CREATE INDEX IF NOT EXISTS "idx_Job_fileId" ON "Job" ("fileId");
        -- The failures, so counting the standing ones starts from tens of rows, not the queue.
        -- Written only when a job fails or a failed row is deleted.
        CREATE INDEX IF NOT EXISTS "idx_Job_failed"
            ON "Job" ("kind", "mediaId") WHERE "state" = 'failed';
        CREATE INDEX IF NOT EXISTS "idx_Job_heartbeat"
            ON "Job" ("heartbeatAt") WHERE "state" = 'claimed';
        -- One live job per (kind, media, file): re-enqueueing a probe must not queue it twice.
        --
        -- COALESCE is load-bearing. SQLite treats NULLs as distinct in a unique index, so a
        -- plain index on ("kind", "mediaId", "fileId") would never deduplicate anything —
        -- and almost every job has one of those two columns NULL, so the constraint would
        -- silently do nothing at all.
        CREATE UNIQUE INDEX IF NOT EXISTS "idx_Job_pending_unique"
            ON "Job" ("kind", COALESCE("mediaId", ''), COALESCE("fileId", ''))
            WHERE "state" IN ('pending', 'claimed');

        -- Deletion is a per-user permission, so it needs an audit trail and an undo (§18.1).
        CREATE TABLE IF NOT EXISTS "TrashEntry" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT,
            -- The physical row this entry trashed. Restore flips its state back and purge
            -- deletes it, and both need to name it directly: "rootId" plus "relPath" looks
            -- like the same thing but is not, because a different file can occupy that path
            -- by the time anyone acts on the entry.
            "fileId" TEXT,
            "rootId" TEXT NOT NULL,
            "relPath" TEXT NOT NULL CHECK(length("relPath") <= 1024),
            "trashRelPath" TEXT NOT NULL CHECK(length("trashRelPath") <= 1024),
            "bytes" INTEGER NOT NULL,
            "deletedById" TEXT NOT NULL,
            "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            -- When the bytes finished moving into the bin. Null means the move is still
            -- owed, which is what lets a lost job be found and re-queued: the queue forgets,
            -- and an entry whose file is still sitting in the media root is the one thing
            -- that would never be noticed otherwise.
            "movedAt" DATETIME,
            "restoredAt" DATETIME,
            -- Distinct from "restoredAt" on purpose. Closing a purged entry by marking it
            -- restored would be cheaper by one column and would make every destroyed item
            -- read, in the only record that survives it, as one that came back.
            "purgedAt" DATETIME,
            "purgeAfter" DATETIME NOT NULL,
            "twinFileId" TEXT REFERENCES "MediaFile" ("id") ON DELETE SET NULL,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE SET NULL,
            FOREIGN KEY ("fileId") REFERENCES "MediaFile" ("id") ON DELETE SET NULL,
            FOREIGN KEY ("rootId") REFERENCES "MediaRoot" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("deletedById") REFERENCES "User" ("id") ON DELETE RESTRICT
        );

        -- "twinFileId" is an identical file that stays, when there is one (§10e). The entry
        -- then bypasses the bin: the trash job deletes the original outright and purges the
        -- item, and the row is only the audit record -- never listed or restorable. Null for an
        -- ordinary entry. Outside the column list because it arrived by migration, and the
        -- drift test compares the text.

        -- The two queries this table has: what is still in the bin, and what is ready to be
        -- purged. Both are partial on the entry still being open, because a restored or
        -- purged entry is history -- never listed, and never acted on twice.
        CREATE INDEX IF NOT EXISTS "idx_TrashEntry_purgeAfter" ON "TrashEntry" ("purgeAfter")
            WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL;
        CREATE INDEX IF NOT EXISTS "idx_TrashEntry_pending" ON "TrashEntry" ("deletedAt")
            WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL;
        CREATE INDEX IF NOT EXISTS "idx_TrashEntry_deletedById" ON "TrashEntry" ("deletedById");
        -- A file's open entry, which the unreadable-files list joins per row (§10g) and a
        -- restore looks up. Without it each lookup reads every entry ever made, and purged
        -- entries are kept as history.
        CREATE INDEX IF NOT EXISTS "idx_TrashEntry_open_fileId" ON "TrashEntry" ("fileId")
            WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL;
        -- The three references a purge sets null (§20). The one above is partial on the entry
        -- being open, which a foreign-key lookup does not imply, so each delete of an item or a
        -- file scanned the whole history. Partial on the column being set instead, which the
        -- lookup does imply: a purge nulls them, so these hold only entries still pointing at
        -- something.
        CREATE INDEX IF NOT EXISTS "idx_TrashEntry_mediaId" ON "TrashEntry" ("mediaId")
            WHERE "mediaId" IS NOT NULL;
        CREATE INDEX IF NOT EXISTS "idx_TrashEntry_fileId" ON "TrashEntry" ("fileId")
            WHERE "fileId" IS NOT NULL;
        CREATE INDEX IF NOT EXISTS "idx_TrashEntry_twinFileId" ON "TrashEntry" ("twinFileId")
            WHERE "twinFileId" IS NOT NULL;

        -- ─────────────────────────────────────────────────────────────────────────────
        -- Live updates (§13b)
        -- ─────────────────────────────────────────────────────────────────────────────

        -- A change feed, not a history. The worker appends a row in the same transaction as
        -- the change it describes, so a change can never be committed without its
        -- notification; the web process tails it with one poller and fans out over SSE.
        --
        -- The INTEGER AUTOINCREMENT id is the single deliberate exception to the UUID
        -- convention (§18.2). This table needs a total order and a resumable cursor, which a
        -- random id cannot give — and it lines up exactly with SSE's Last-Event-ID, so a tab
        -- that slept through a scan resumes rather than resynchronising the whole grid.
        -- AUTOINCREMENT (rather than bare INTEGER PRIMARY KEY) matters here: without it
        -- SQLite reuses the ids of deleted rows, and pruning the feed would hand a
        -- reconnecting browser a cursor that walks over the same ids twice.
        CREATE TABLE IF NOT EXISTS "ChangeLog" (
            "id" INTEGER PRIMARY KEY AUTOINCREMENT,
            "entity" TEXT NOT NULL
                CHECK("entity" IN ('media', 'artifact', 'variant', 'scan', 'job')),
            "entityId" TEXT,
            -- Carried so the feed can be filtered per connection against LibraryAccess: a
            -- user must not learn that media exists in a root they cannot see.
            "rootId" TEXT,
            "op" TEXT NOT NULL CHECK("op" IN ('insert', 'update', 'delete')),
            -- Free-form detail for the client to patch with, e.g. which artifact kind became
            -- ready. Small by constraint: this table is read every second.
            "detail" TEXT CHECK("detail" IS NULL OR length("detail") <= 500),
            "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        -- Pruning walks this; the poller reads by primary key, which needs no index.
        CREATE INDEX IF NOT EXISTS "idx_ChangeLog_at" ON "ChangeLog" ("at");

        -- Everything an admin can change at runtime (§12b). Values are JSON, validated by a
        -- Zod schema in @private-stock/core on write.
        CREATE TABLE IF NOT EXISTS "Setting" (
            "key" TEXT NOT NULL PRIMARY KEY CHECK(length("key") <= 100),
            "value" TEXT NOT NULL CHECK(length("value") <= 20000),
            "updatedAt" DATETIME NOT NULL
        );

        CREATE TABLE IF NOT EXISTS "ErrorLog" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "requestId" TEXT CHECK("requestId" IS NULL OR length("requestId") <= 64),
            "userId" TEXT,
            "code" TEXT NOT NULL CHECK(length("code") <= 60),
            "message" TEXT NOT NULL CHECK(length("message") <= 4000),
            "stack" TEXT CHECK("stack" IS NULL OR length("stack") <= 20000),
            "path" TEXT CHECK("path" IS NULL OR length("path") <= 1024),
            "method" TEXT CHECK("method" IS NULL OR length("method") <= 10),
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS "idx_ErrorLog_createdAt" ON "ErrorLog" ("createdAt");
    `);
}
