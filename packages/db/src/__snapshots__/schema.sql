CREATE TABLE "Artifact" (
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

CREATE TABLE "ChangeLog" (
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

CREATE TABLE "Clip" (
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

CREATE TABLE "ClipTag" (
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

CREATE TABLE "CollectionPin" (
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

CREATE TABLE "DupeClustered" (
            "mediaId" TEXT NOT NULL PRIMARY KEY,
            "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE
        );

CREATE TABLE "DupeGroup" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "kind" TEXT NOT NULL CHECK("kind" IN ('exact', 'near')),
            "reviewed" INTEGER CHECK("reviewed" IS NULL OR "reviewed" = 1),
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL
        );

CREATE TABLE "DupeMember" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "groupId" TEXT NOT NULL,
            "mediaId" TEXT NOT NULL,
            "distance" INTEGER,
            FOREIGN KEY ("groupId") REFERENCES "DupeGroup" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            UNIQUE ("groupId", "mediaId")
        );

CREATE TABLE "DupeVerdict" (
            "aId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "bId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "verdict" TEXT NOT NULL CHECK("verdict" IN ('same', 'different')),
            "decisionId" TEXT NOT NULL CHECK(length("decisionId") <= 64),
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY ("aId", "bId"),
            CHECK ("aId" < "bId")
        ) WITHOUT ROWID;

CREATE TABLE "ErrorLog" (
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

CREATE TABLE "Face" (
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

CREATE TABLE "FaceAnchor" (
            "tagId" TEXT NOT NULL PRIMARY KEY REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "items" INTEGER NOT NULL,
            "confirmedItems" INTEGER NOT NULL,
            "sharedItems" INTEGER NOT NULL,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

CREATE TABLE "FaceAppearance" (
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

CREATE TABLE "FaceAutoTag" (
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

CREATE TABLE "FaceDecision" (
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

CREATE TABLE "FaceRefusal" (
            "faceId" TEXT NOT NULL REFERENCES "Face" ("id") ON DELETE CASCADE,
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "how" TEXT CHECK("how" IN ('shown', 'item', 'inferred')),
            "decisionId" TEXT CHECK(length("decisionId") <= 64),
            PRIMARY KEY ("faceId", "tagId")
        ) WITHOUT ROWID;

CREATE TABLE "FaceSearch" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "atMs" INTEGER NOT NULL,
            "state" TEXT NOT NULL DEFAULT 'pending' CHECK("state" IN ('pending', 'running', 'done', 'failed')),
            "resultJson" TEXT CHECK("resultJson" IS NULL OR length("resultJson") <= 400000),
            "error" TEXT CHECK("error" IS NULL OR length("error") <= 500),
            "requestedByUserId" TEXT,
            "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "finishedAt" DATETIME,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("requestedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL
        );

CREATE TABLE "FaceStale" (
            "kind" TEXT NOT NULL CHECK("kind" IN ('tag', 'item')),
            "id" TEXT NOT NULL CHECK(length("id") <= 64),
            PRIMARY KEY ("kind", "id")
        ) WITHOUT ROWID;

CREATE TABLE "HomeLayout" (
            "userId" TEXT NOT NULL PRIMARY KEY,
            "rowsJson" TEXT NOT NULL CHECK(length("rowsJson") <= 20000),
            "updatedAt" DATETIME NOT NULL,
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
        );

CREATE TABLE "Invitation" (
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

CREATE TABLE "ItemRefusal" (
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "decisionId" TEXT REFERENCES "FaceDecision" ("id") ON DELETE SET NULL,
            PRIMARY KEY ("tagId", "mediaId")
        ) WITHOUT ROWID;

CREATE TABLE "Job" (
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

CREATE TABLE "LibraryAccess" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "rootId" TEXT NOT NULL,
            "allowed" INTEGER CHECK("allowed" IS NULL OR "allowed" = 1),
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("rootId") REFERENCES "MediaRoot" ("id") ON DELETE CASCADE,
            UNIQUE ("userId", "rootId")
        );

CREATE TABLE "Media" (
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
            "orientation" TEXT GENERATED ALWAYS AS (CASE WHEN "width" > "height" THEN 'landscape'
                WHEN "height" > "width" THEN 'portrait' WHEN "width" = "height" THEN 'square'
                END) VIRTUAL,
            -- Forward reference: "Artifact" is created below. SQLite resolves foreign keys
            -- when they are used rather than when the table is declared, so the order of
            -- CREATE TABLE statements does not have to break the cycle.
            FOREIGN KEY ("coverArtifactId") REFERENCES "Artifact" ("id") ON DELETE SET NULL
        );

CREATE TABLE "MediaAttribute" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "key" TEXT NOT NULL CHECK(length("key") BETWEEN 1 AND 100),
            "value" TEXT NOT NULL CHECK(length("value") <= 2000),
            "source" TEXT NOT NULL DEFAULT 'scraper'
                CHECK("source" IN ('user', 'filename', 'scraper', 'ai', 'ocr', 'embedded')),
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            UNIQUE ("mediaId", "key")
        );

CREATE TABLE "MediaFile" (
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

CREATE TABLE "MediaFileLink" (
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

CREATE TABLE "MediaMention" (
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            "tagId" TEXT NOT NULL REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "field" TEXT NOT NULL CHECK("field" IN ('filename', 'title', 'screen', 'metadata')),
            PRIMARY KEY ("mediaId", "tagId", "field")
        ) WITHOUT ROWID;

CREATE TABLE "MediaRoot" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "path" TEXT NOT NULL UNIQUE CHECK(length("path") BETWEEN 1 AND 1024),
            "label" TEXT NOT NULL CHECK(length("label") BETWEEN 1 AND 100),
            "enabled" INTEGER CHECK("enabled" IS NULL OR "enabled" = 1),
            "writable" INTEGER CHECK("writable" IS NULL OR "writable" = 1),
            "lastScanAt" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL
        );

CREATE VIRTUAL TABLE "MediaSearch" USING fts5(
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

CREATE TABLE "MediaSearchDoc" (
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

CREATE TABLE 'MediaSearch_config'(k PRIMARY KEY, v) WITHOUT ROWID;

CREATE TABLE 'MediaSearch_data'(id INTEGER PRIMARY KEY, block BLOB);

CREATE TABLE 'MediaSearch_docsize'(id INTEGER PRIMARY KEY, sz BLOB);

CREATE TABLE 'MediaSearch_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;

CREATE TABLE "MediaStage" (
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

CREATE TABLE "MediaStageTally" (
            "stage" TEXT NOT NULL CHECK(length("stage") BETWEEN 1 AND 40),
            "state" TEXT NOT NULL CHECK("state" IN ('done', 'empty', 'failed', 'skipped')),
            "version" INTEGER NOT NULL,
            "count" INTEGER NOT NULL,
            PRIMARY KEY ("stage", "state", "version")
        );

CREATE TABLE "MediaStream" (
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

CREATE TABLE "MediaSubtitle" (
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

CREATE TABLE "MediaTag" (
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

CREATE TABLE "MediaText" (
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

CREATE TABLE "MediaTextString" (
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

CREATE TABLE "OcrTagMatch" (
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

CREATE TABLE "OcrTagMatchSkip" (
            "matchId" TEXT NOT NULL REFERENCES "OcrTagMatch" ("id") ON DELETE CASCADE,
            "mediaId" TEXT NOT NULL REFERENCES "Media" ("id") ON DELETE CASCADE,
            PRIMARY KEY ("matchId", "mediaId")
        );

CREATE TABLE "OcrTrial" (
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

CREATE TABLE "OcrTuneRun" (
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

CREATE TABLE "PerformerNoFace" (
            "tagId" TEXT NOT NULL PRIMARY KEY REFERENCES "Tag" ("id") ON DELETE CASCADE,
            "decidedByUserId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
            "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) WITHOUT ROWID;

CREATE TABLE "PhashImage" (
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

CREATE TABLE "PhashVideo" (
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

CREATE TABLE "Playlist" (
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

CREATE TABLE "PlaylistItem" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "playlistId" TEXT NOT NULL,
            "mediaId" TEXT NOT NULL,
            "position" INTEGER NOT NULL,
            "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("playlistId") REFERENCES "Playlist" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE,
            UNIQUE ("playlistId", "mediaId")
        );

CREATE TABLE "Reel" (
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

CREATE TABLE "ReelItem" (
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

CREATE TABLE "RefreshToken" (
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

CREATE TABLE "SavedFilter" (
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

CREATE TABLE "Scan" (
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

CREATE TABLE "Setting" (
            "key" TEXT NOT NULL PRIMARY KEY CHECK(length("key") <= 100),
            "value" TEXT NOT NULL CHECK(length("value") <= 20000),
            "updatedAt" DATETIME NOT NULL
        );

CREATE TABLE "Tag" (
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

CREATE TABLE "TagAlias" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "tagId" TEXT NOT NULL,
            "name" TEXT NOT NULL CHECK(length("name") BETWEEN 1 AND 200),
            "nameNorm" TEXT NOT NULL CHECK(length("nameNorm") BETWEEN 1 AND 200),
            "createdById" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL
        );

CREATE TABLE "TagBatch" (
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

CREATE TABLE "TagPicture" (
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
            "tileAtMs" INTEGER,
            PRIMARY KEY ("tagId", "source")
        ) WITHOUT ROWID;

CREATE TABLE "TrashEntry" (
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

CREATE TABLE "User" (
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

CREATE TABLE "UserMedia" (
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

CREATE TABLE "UserPref" (
            "userId" TEXT NOT NULL,
            "key" TEXT NOT NULL CHECK(length("key") BETWEEN 1 AND 100),
            "value" TEXT NOT NULL CHECK(length("value") <= 2000),
            "updatedAt" DATETIME NOT NULL,
            PRIMARY KEY ("userId", "key"),
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
        );

CREATE TABLE "UserTag" (
            "userId" TEXT NOT NULL,
            "tagId" TEXT NOT NULL,
            "favorite" INTEGER CHECK("favorite" IS NULL OR "favorite" = 1),
            "updatedAt" DATETIME NOT NULL,
            PRIMARY KEY ("userId", "tagId"),
            FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE,
            FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE
        );

CREATE TABLE "Variant" (
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

CREATE INDEX "idx_Artifact_capture_owner"
            ON "Artifact" ("createdByUserId", "generatedAt" DESC) WHERE "kind" = 'capture';

CREATE INDEX "idx_Artifact_stale"
            ON "Artifact" ("kind", "generatorVersion") WHERE "source" = 'auto';

CREATE INDEX "idx_ChangeLog_at" ON "ChangeLog" ("at");

CREATE INDEX "idx_ClipTag_batchId"
            ON "ClipTag" ("batchId") WHERE "batchId" IS NOT NULL;

CREATE INDEX "idx_ClipTag_tagId" ON "ClipTag" ("tagId");

CREATE UNIQUE INDEX "idx_ClipTag_unique" ON "ClipTag" ("clipId", "tagId");

CREATE INDEX "idx_Clip_media_start" ON "Clip" ("mediaId", "startMs");

CREATE INDEX "idx_Clip_user_created" ON "Clip" ("userId", "createdAt" DESC);

CREATE INDEX "idx_CollectionPin_lookup"
            ON "CollectionPin" ("kind", "collectionId");

CREATE INDEX "idx_DupeMember_mediaId" ON "DupeMember" ("mediaId");

CREATE INDEX "idx_DupeVerdict_bId" ON "DupeVerdict" ("bId");

CREATE INDEX "idx_DupeVerdict_decision" ON "DupeVerdict" ("decisionId");

CREATE INDEX "idx_ErrorLog_createdAt" ON "ErrorLog" ("createdAt");

CREATE INDEX "idx_FaceAppearance_match"
            ON "FaceAppearance" ("matchTagId", "score" DESC) WHERE "matchTagId" IS NOT NULL;

CREATE INDEX "idx_FaceAppearance_media" ON "FaceAppearance" ("mediaId");

CREATE INDEX "idx_FaceAppearance_newPerson"
            ON "FaceAppearance" ("newPersonId") WHERE "newPersonId" IS NOT NULL;

CREATE INDEX "idx_FaceAutoTag_state" ON "FaceAutoTag" ("state", "tagId");

CREATE INDEX "idx_FaceDecision_created" ON "FaceDecision" ("createdAt" DESC);

CREATE INDEX "idx_FaceDecision_tag"
            ON "FaceDecision" ("tagId", "createdAt" DESC) WHERE "tagId" IS NOT NULL;

CREATE INDEX "idx_FaceRefusal_decision"
            ON "FaceRefusal" ("decisionId") WHERE "decisionId" IS NOT NULL;

CREATE INDEX "idx_FaceRefusal_tag" ON "FaceRefusal" ("tagId", "faceId");

CREATE INDEX "idx_FaceSearch_media" ON "FaceSearch" ("mediaId", "state");

CREATE INDEX "idx_FaceSearch_requestedAt" ON "FaceSearch" ("requestedAt");

CREATE INDEX "idx_Face_appearance" ON "Face" ("appearanceId") WHERE "appearanceId" IS NOT NULL;

CREATE INDEX "idx_Face_decision" ON "Face" ("decisionId") WHERE "decisionId" IS NOT NULL;

CREATE INDEX "idx_Face_tag"
            ON "Face" ("tagId", "mediaId", "vectorIndex") WHERE "tagId" IS NOT NULL;

CREATE INDEX "idx_ItemRefusal_decision"
            ON "ItemRefusal" ("decisionId") WHERE "decisionId" IS NOT NULL;

CREATE INDEX "idx_Job_claim"
            ON "Job" ("priority", "mediaAddedAt" DESC, "createdAt", "availableAt", "kind")
            WHERE "state" = 'pending';

CREATE INDEX "idx_Job_failed"
            ON "Job" ("kind", "mediaId") WHERE "state" = 'failed';

CREATE INDEX "idx_Job_fileId" ON "Job" ("fileId");

CREATE INDEX "idx_Job_heartbeat"
            ON "Job" ("heartbeatAt") WHERE "state" = 'claimed';

CREATE INDEX "idx_Job_kind_state" ON "Job" ("kind", "state");

CREATE INDEX "idx_Job_mediaId_kind" ON "Job" ("mediaId", "kind");

CREATE UNIQUE INDEX "idx_Job_pending_unique"
            ON "Job" ("kind", COALESCE("mediaId", ''), COALESCE("fileId", ''))
            WHERE "state" IN ('pending', 'claimed');

CREATE INDEX "idx_MediaFileLink_fileId" ON "MediaFileLink" ("fileId");

CREATE UNIQUE INDEX "idx_MediaFileLink_one_original"
            ON "MediaFileLink" ("mediaId") WHERE "role" = 'original';

CREATE INDEX "idx_MediaFile_contentHash" ON "MediaFile" ("contentHash");

CREATE INDEX "idx_MediaFile_identity"
            ON "MediaFile" ("rootId", "inode") WHERE "inode" IS NOT NULL;

CREATE INDEX "idx_MediaFile_quickHash" ON "MediaFile" ("quickHash");

CREATE INDEX "idx_MediaFile_state" ON "MediaFile" ("state");

CREATE INDEX "idx_MediaMention_tag" ON "MediaMention" ("tagId", "mediaId");

CREATE INDEX "idx_MediaSearchDoc_rowid_mediaId"
            ON "MediaSearchDoc" ("rowid", "mediaId");

CREATE INDEX "idx_MediaStage_failed"
            ON "MediaStage" ("stage", "attempts") WHERE "state" = 'failed';

CREATE INDEX "idx_MediaStage_stage_mediaId"
            ON "MediaStage" ("stage", "mediaId", "version", "state", "attempts");

CREATE INDEX "idx_MediaStage_stage_state_version"
            ON "MediaStage" ("stage", "state", "version");

CREATE INDEX "idx_MediaTag_batchId"
            ON "MediaTag" ("batchId") WHERE "batchId" IS NOT NULL;

CREATE INDEX "idx_MediaTag_ocr"
            ON "MediaTag" ("createdAt", "id") WHERE "source" = 'ocr' AND "userId" IS NULL;

CREATE INDEX "idx_MediaTag_tagId"
            ON "MediaTag" ("tagId", "userId", "mediaId");

CREATE UNIQUE INDEX "idx_MediaTag_unique_library"
            ON "MediaTag" ("mediaId", "tagId") WHERE "userId" IS NULL;

CREATE UNIQUE INDEX "idx_MediaTag_unique_user"
            ON "MediaTag" ("mediaId", "tagId", "userId") WHERE "userId" IS NOT NULL;

CREATE INDEX "idx_MediaTextString_count"
            ON "MediaTextString" (-"rowCount", "textNorm");

CREATE INDEX "idx_MediaText_mediaId" ON "MediaText" ("mediaId");

CREATE INDEX "idx_MediaText_textNorm" ON "MediaText" ("textNorm", "mediaId", "reviewState");

CREATE INDEX "idx_MediaText_unreviewed"
            ON "MediaText" ("mediaId") WHERE "reviewState" IS NULL;

CREATE INDEX "idx_Media_coverArtifactId"
            ON "Media" ("coverArtifactId") WHERE "coverArtifactId" IS NOT NULL;

CREATE INDEX "idx_Media_kind_addedAt" ON "Media" ("kind", "addedAt");

CREATE INDEX "idx_Media_list_addedAt"
            ON "Media" ("listRootId", "addedAt", "id") WHERE "listable" = 1;

CREATE INDEX "idx_Media_list_bitrate"
            ON "Media" ("listRootId", "bitrate", "id", "kind") WHERE "listable" = 1;

CREATE INDEX "idx_Media_list_capturedAt"
            ON "Media" ("listRootId", "capturedAt", "id") WHERE "listable" = 1;

CREATE INDEX "idx_Media_list_duration"
            ON "Media" ("listRootId", "durationMs", "id", "kind") WHERE "listable" = 1;

CREATE INDEX "idx_Media_list_fps"
            ON "Media" ("listRootId", "fps", "id", "kind") WHERE "listable" = 1;

CREATE INDEX "idx_Media_list_kind_addedAt"
            ON "Media" ("listRootId", "kind", "addedAt", "id") WHERE "listable" = 1;

CREATE INDEX "idx_Media_list_orientation"
            ON "Media" ("listRootId", "orientation", "kind", "id") WHERE "listable" = 1;

CREATE INDEX "idx_Media_list_resolution"
            ON "Media" ("listRootId", MIN("width", "height"), "id", "kind") WHERE "listable" = 1;

CREATE INDEX "idx_Media_list_size"
            ON "Media" ("listRootId", "listSize", "id", "kind") WHERE "listable" = 1;

CREATE INDEX "idx_Media_list_title"
            ON "Media" ("listRootId", "title" COLLATE NOCASE, "id") WHERE "listable" = 1;

CREATE UNIQUE INDEX "idx_Media_listable_id"
            ON "Media" ("id") WHERE "listable" = 1;

CREATE UNIQUE INDEX "idx_Media_listable_id_kind"
            ON "Media" ("id", "kind") WHERE "listable" = 1;

CREATE INDEX "idx_Media_listable_id_kind_root"
            ON "Media" ("id", "kind", "listRootId")
            WHERE "listable" = 1 AND "kind" IN ('image', 'video');

CREATE INDEX "idx_Media_listable_probed_kind"
            ON "Media" ("probedAt" IS NOT NULL, "kind") WHERE "listable" = 1;

CREATE INDEX "idx_OcrTagMatchSkip_mediaId" ON "OcrTagMatchSkip" ("mediaId");

CREATE INDEX "idx_OcrTagMatch_batchId"
            ON "OcrTagMatch" ("batchId") WHERE "batchId" IS NOT NULL;

CREATE INDEX "idx_OcrTagMatch_decidedByUserId"
            ON "OcrTagMatch" ("decidedByUserId") WHERE "decidedByUserId" IS NOT NULL;

CREATE INDEX "idx_OcrTagMatch_queued"
            ON "OcrTagMatch" ("textNorm") WHERE "state" IS NOT 'rejected' AND "pendingCount" > 0;

CREATE INDEX "idx_OcrTagMatch_state" ON "OcrTagMatch" ("state", "textNorm");

CREATE INDEX "idx_OcrTagMatch_tagId" ON "OcrTagMatch" ("tagId");

CREATE INDEX "idx_OcrTuneRun_createdAt" ON "OcrTuneRun" ("createdAt");

CREATE INDEX "idx_PhashImage_band0" ON "PhashImage" ("band0");

CREATE INDEX "idx_PhashImage_band1" ON "PhashImage" ("band1");

CREATE INDEX "idx_PhashImage_band2" ON "PhashImage" ("band2");

CREATE INDEX "idx_PhashImage_band3" ON "PhashImage" ("band3");

CREATE INDEX "idx_PhashImage_band4" ON "PhashImage" ("band4");

CREATE INDEX "idx_PhashImage_band5" ON "PhashImage" ("band5");

CREATE INDEX "idx_PhashImage_band6" ON "PhashImage" ("band6");

CREATE INDEX "idx_PhashImage_band7" ON "PhashImage" ("band7");

CREATE INDEX "idx_PhashVideo_band0" ON "PhashVideo" ("band0");

CREATE INDEX "idx_PhashVideo_band1" ON "PhashVideo" ("band1");

CREATE INDEX "idx_PhashVideo_band2" ON "PhashVideo" ("band2");

CREATE INDEX "idx_PhashVideo_band3" ON "PhashVideo" ("band3");

CREATE INDEX "idx_PhashVideo_band4" ON "PhashVideo" ("band4");

CREATE INDEX "idx_PhashVideo_band5" ON "PhashVideo" ("band5");

CREATE INDEX "idx_PhashVideo_band6" ON "PhashVideo" ("band6");

CREATE INDEX "idx_PhashVideo_band7" ON "PhashVideo" ("band7");

CREATE INDEX "idx_PlaylistItem_playlistId_position"
            ON "PlaylistItem" ("playlistId", "position");

CREATE INDEX "idx_ReelItem_clipId" ON "ReelItem" ("clipId");

CREATE INDEX "idx_ReelItem_reelId_position"
            ON "ReelItem" ("reelId", "position");

CREATE INDEX "idx_Reel_owner" ON "Reel" ("ownerId");

CREATE INDEX "idx_Reel_updated" ON "Reel" ("updatedAt" DESC);

CREATE INDEX "idx_RefreshToken_userId" ON "RefreshToken" ("userId");

CREATE INDEX "idx_Scan_rootId_startedAt" ON "Scan" ("rootId", "startedAt");

CREATE INDEX "idx_Scan_running" ON "Scan" ("startedAt")
            WHERE "state" = 'running';

CREATE INDEX "idx_TagAlias_nameNorm" ON "TagAlias" ("nameNorm");

CREATE UNIQUE INDEX "idx_TagAlias_unique"
            ON "TagAlias" ("tagId", "nameNorm");

CREATE INDEX "idx_TagBatch_user"
            ON "TagBatch" ("userId", "createdAt" DESC);

CREATE INDEX "idx_TagPicture_media"
            ON "TagPicture" ("mediaId") WHERE "mediaId" IS NOT NULL;

CREATE INDEX "idx_Tag_owner"
            ON "Tag" ("ownerId") WHERE "ownerId" IS NOT NULL;

CREATE UNIQUE INDEX "idx_Tag_unique_library"
            ON "Tag" ("kind", "nameNorm") WHERE "ownerId" IS NULL;

CREATE UNIQUE INDEX "idx_Tag_unique_owner"
            ON "Tag" ("kind", "nameNorm", "ownerId") WHERE "ownerId" IS NOT NULL;

CREATE INDEX "idx_TrashEntry_deletedById" ON "TrashEntry" ("deletedById");

CREATE INDEX "idx_TrashEntry_fileId" ON "TrashEntry" ("fileId")
            WHERE "fileId" IS NOT NULL;

CREATE INDEX "idx_TrashEntry_mediaId" ON "TrashEntry" ("mediaId")
            WHERE "mediaId" IS NOT NULL;

CREATE INDEX "idx_TrashEntry_open_fileId" ON "TrashEntry" ("fileId")
            WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL;

CREATE INDEX "idx_TrashEntry_pending" ON "TrashEntry" ("deletedAt")
            WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL;

CREATE INDEX "idx_TrashEntry_purgeAfter" ON "TrashEntry" ("purgeAfter")
            WHERE "restoredAt" IS NULL AND "purgedAt" IS NULL;

CREATE INDEX "idx_TrashEntry_twinFileId" ON "TrashEntry" ("twinFileId")
            WHERE "twinFileId" IS NOT NULL;

CREATE INDEX "idx_UserMedia_favorite"
            ON "UserMedia" ("userId", "mediaId") WHERE "favorite" IS NOT NULL;

CREATE INDEX "idx_UserMedia_hidden"
            ON "UserMedia" ("userId", "mediaId") WHERE "hidden" IS NOT NULL;

CREATE INDEX "idx_UserMedia_mediaId" ON "UserMedia" ("mediaId");

CREATE INDEX "idx_UserMedia_rating"
            ON "UserMedia" ("userId", "rating", "mediaId");

CREATE INDEX "idx_UserMedia_viewed"
            ON "UserMedia" ("userId", "lastViewedAt") WHERE "lastViewedAt" IS NOT NULL;

CREATE INDEX "idx_UserTag_favorite"
            ON "UserTag" ("userId", "tagId") WHERE "favorite" IS NOT NULL;

CREATE INDEX "idx_UserTag_tag" ON "UserTag" ("tagId");

CREATE INDEX "idx_User_invitation"
            ON "User" ("invitationId") WHERE "invitationId" IS NOT NULL;

CREATE INDEX "idx_Variant_lastUsed"
            ON "Variant" ("lastUsedAt") WHERE "ready" = 1;

CREATE TRIGGER "FaceRefusal_stale_ad" AFTER DELETE ON "FaceRefusal"
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('tag', OLD."tagId");
        END;

CREATE TRIGGER "FaceRefusal_stale_ai" AFTER INSERT ON "FaceRefusal"
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('tag', NEW."tagId");
        END;

CREATE TRIGGER "Face_stale_ad" AFTER DELETE ON "Face"
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('item', OLD."mediaId");
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id")
                SELECT 'tag', OLD."tagId" WHERE OLD."tagId" IS NOT NULL;
        END;

CREATE TRIGGER "Face_stale_ai" AFTER INSERT ON "Face"
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('item', NEW."mediaId");
        END;

CREATE TRIGGER "Face_stale_au"
            AFTER UPDATE OF "tagId", "scatteredAt", "skippedAt" ON "Face"
            WHEN OLD."tagId" IS NOT NEW."tagId" OR OLD."scatteredAt" IS NOT NEW."scatteredAt"
                 OR OLD."skippedAt" IS NOT NEW."skippedAt"
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('item', NEW."mediaId");
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id")
                SELECT 'tag', OLD."tagId"
                 WHERE OLD."tagId" IS NOT NULL AND OLD."tagId" IS NOT NEW."tagId";
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id")
                SELECT 'tag', NEW."tagId"
                 WHERE NEW."tagId" IS NOT NULL AND OLD."tagId" IS NOT NEW."tagId";
        END;

CREATE TRIGGER "MediaFileLink_list_ad"
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

CREATE TRIGGER "MediaFileLink_list_ai"
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

CREATE TRIGGER "MediaFile_list_ai"
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

CREATE TRIGGER "MediaFile_list_au"
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

CREATE TRIGGER "MediaSearchDoc_ad"
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

CREATE TRIGGER "MediaSearchDoc_ai"
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

CREATE TRIGGER "MediaSearchDoc_au"
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

CREATE TRIGGER "MediaStage_tally_ad"
        AFTER DELETE ON "MediaStage"
        WHEN EXISTS (SELECT 1 FROM "Media" WHERE "id" = old."mediaId" AND "listable" = 1)
        BEGIN
            UPDATE "MediaStageTally" SET "count" = "count" - 1
             WHERE "stage" = old."stage" AND "state" = old."state" AND "version" = old."version";
        END;

CREATE TRIGGER "MediaStage_tally_ai"
        AFTER INSERT ON "MediaStage"
        WHEN EXISTS (SELECT 1 FROM "Media" WHERE "id" = new."mediaId" AND "listable" = 1)
        BEGIN
            INSERT INTO "MediaStageTally" ("stage", "state", "version", "count")
            VALUES (new."stage", new."state", new."version", 1)
            ON CONFLICT ("stage", "state", "version") DO UPDATE SET "count" = "count" + 1;
        END;

CREATE TRIGGER "MediaStage_tally_au"
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

CREATE TRIGGER "MediaTag_face_ad"
            AFTER DELETE ON "MediaTag" WHEN OLD."userId" IS NULL
        BEGIN
            UPDATE "Face"
               SET "tagId" = NULL, "decidedByUserId" = NULL, "decidedAt" = NULL,
                   "decidedHow" = NULL, "decisionId" = NULL
             WHERE "mediaId" = OLD."mediaId" AND "tagId" = OLD."tagId";
        END;

CREATE TRIGGER "MediaTag_refusal_ai"
            AFTER INSERT ON "MediaTag" WHEN NEW."userId" IS NULL
        BEGIN
            DELETE FROM "ItemRefusal" WHERE "mediaId" = NEW."mediaId" AND "tagId" = NEW."tagId";
            DELETE FROM "FaceRefusal"
             WHERE "tagId" = NEW."tagId" AND "how" = 'item'
               AND "faceId" IN (SELECT "id" FROM "Face" WHERE "mediaId" = NEW."mediaId");
        END;

CREATE TRIGGER "MediaTag_stale_ad" AFTER DELETE ON "MediaTag"
            WHEN OLD."userId" IS NULL
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id")
                SELECT 'tag', OLD."tagId"
                 WHERE EXISTS (SELECT 1 FROM "Tag" t WHERE t."id" = OLD."tagId"
                                  AND t."kind" = 'performer');
        END;

CREATE TRIGGER "MediaTag_stale_ai" AFTER INSERT ON "MediaTag"
            WHEN NEW."userId" IS NULL
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id")
                SELECT 'tag', NEW."tagId"
                 WHERE EXISTS (SELECT 1 FROM "Tag" t WHERE t."id" = NEW."tagId"
                                  AND t."kind" = 'performer');
        END;

CREATE TRIGGER "MediaTag_stale_au" AFTER UPDATE ON "MediaTag"
            WHEN OLD."userId" IS NULL OR NEW."userId" IS NULL
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id")
                SELECT 'tag', t."id" FROM "Tag" t
                 WHERE t."id" IN (OLD."tagId", NEW."tagId") AND t."kind" = 'performer';
        END;

CREATE TRIGGER "MediaText_string_ad"
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

CREATE TRIGGER "MediaText_string_ai"
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

CREATE TRIGGER "MediaText_string_au"
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

CREATE TRIGGER "Media_stale_au" AFTER UPDATE OF "listable" ON "Media"
            WHEN OLD."listable" IS NOT NEW."listable"
                 AND EXISTS (SELECT 1 FROM "Face" f WHERE f."mediaId" = NEW."id")
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id")
                SELECT 'tag', mt."tagId" FROM "MediaTag" mt JOIN "Tag" t ON t."id" = mt."tagId"
                 WHERE mt."mediaId" = NEW."id" AND mt."userId" IS NULL AND t."kind" = 'performer';
        END;

CREATE TRIGGER "Media_tally_au"
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

CREATE TRIGGER "Media_tally_bd"
        BEFORE DELETE ON "Media"
        WHEN old."listable" = 1
        BEGIN
            UPDATE "MediaStageTally" SET "count" = "count" - 1
             WHERE ("stage", "state", "version") IN (
                   SELECT "stage", "state", "version" FROM "MediaStage" WHERE "mediaId" = old."id");
        END;

CREATE TRIGGER "PerformerNoFace_stale_ad" AFTER DELETE ON "PerformerNoFace"
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('tag', OLD."tagId");
        END;

CREATE TRIGGER "PerformerNoFace_stale_ai" AFTER INSERT ON "PerformerNoFace"
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('tag', NEW."tagId");
        END;

CREATE TRIGGER "Tag_stale_ad" AFTER DELETE ON "Tag"
            WHEN OLD."kind" = 'performer'
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('tag', OLD."id");
        END;

CREATE TRIGGER "Tag_stale_au" AFTER UPDATE OF "kind", "ownerId" ON "Tag"
            WHEN (OLD."kind" IS NOT NEW."kind" OR OLD."ownerId" IS NOT NEW."ownerId")
                 AND 'performer' IN (OLD."kind", NEW."kind")
        BEGIN
            INSERT OR IGNORE INTO "FaceStale" ("kind", "id") VALUES ('tag', NEW."id");
        END;
