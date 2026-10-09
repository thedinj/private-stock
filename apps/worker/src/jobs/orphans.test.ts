import { mkdirSync, mkdtempSync, existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reconciling `/data` against the database (§13d).
 *
 * This job unlinks files, so the only interesting question about it is whether it can be
 * wrong. It could: `Artifact.relPath` is stored dataDir-relative and carries its directory in
 * the value (`"art/19/<id>/cover.webp"`), while the walk produces paths relative to the
 * directory it walked (`"19/<id>/cover.webp"`). The comparison never matched, so every live
 * artifact in the library classified as an orphan — 12,308 files and 706 MB in the library
 * this was found in — and the only reason nothing was destroyed is that the sweep had never
 * once run outside the forget-a-library path.
 *
 * So the first test here is simply: a referenced file survives. That is the assertion that
 * was missing.
 */

let dataDir: string;
let db: Database.Database;

vi.mock("@private-stock/db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");

    return { db: instance };
});

const { runOrphanSweep } = await import("./orphans.js");
const { db: sharedDb } = await import("@private-stock/db");

/** Old enough to be past the grace period that protects a just-written artifact. */
const AGES_AGO = new Date(Date.now() - 48 * 60 * 60 * 1000);

const givenFile = (relPath: string, stale = true): string => {
    const absolute = path.join(dataDir, relPath);

    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, "bytes");

    if (stale) {
        utimesSync(absolute, AGES_AGO, AGES_AGO);
    }

    return absolute;
};

/** An artifact row, backdated past the grace period unless asked otherwise. */
const givenArtifactRow = (
    relPath: string,
    options: { mediaId?: string; kind?: string; source?: string; fresh?: boolean } = {}
): void => {
    db.prepare(
        `INSERT INTO "Artifact" ("id", "mediaId", "kind", "relPath", "source", "generatedAt")
         VALUES (?, ?, ?, ?, ?, datetime('now', ?))`
    ).run(
        relPath,
        options.mediaId ?? "media-1",
        options.kind ?? "cover",
        relPath,
        options.source ?? "auto",
        options.fresh ? "-1 minute" : "-2 days"
    );
};

beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ps-orphans-"));
    process.env.PRIVATE_STOCK_DATA_DIR = dataDir;

    db = sharedDb as unknown as Database.Database;
    // Only the columns the sweep reads. A full schema would say nothing extra and would tie
    // this test to every unrelated change to those tables.
    db.exec(`
        DROP TABLE IF EXISTS "Artifact";
        DROP TABLE IF EXISTS "Variant";
        DROP TABLE IF EXISTS "TrashEntry";
        DROP TABLE IF EXISTS "MediaStage";
        DROP TABLE IF EXISTS "TagPicture";
        CREATE TABLE "TagPicture" (
            "tagId" TEXT NOT NULL,
            "source" TEXT NOT NULL,
            "relPath" TEXT NOT NULL,
            "smallRelPath" TEXT NOT NULL,
            "generatedAt" DATETIME NOT NULL DEFAULT '2000-01-01 00:00:00',
            PRIMARY KEY ("tagId", "source")
        );
        CREATE TABLE "Artifact" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "mediaId" TEXT NOT NULL,
            "kind" TEXT NOT NULL,
            "relPath" TEXT NOT NULL,
            "source" TEXT NOT NULL DEFAULT 'auto',
            "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE "Variant" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "relPath" TEXT NOT NULL,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE "TrashEntry" (
            "trashRelPath" TEXT NOT NULL,
            "restoredAt" DATETIME,
            "purgedAt" DATETIME
        );
        CREATE TABLE "MediaStage" (
            "mediaId" TEXT NOT NULL,
            "stage" TEXT NOT NULL,
            "state" TEXT NOT NULL,
            "at" DATETIME NOT NULL DEFAULT '2000-01-01 00:00:00',
            PRIMARY KEY ("mediaId", "stage")
        );
    `);
});

afterEach(() => {
    delete process.env.PRIVATE_STOCK_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
});

describe("runOrphanSweep", () => {
    /**
     * The regression, and the plainest statement of what this job must never do.
     *
     * Reintroduce the prefix bug and this test still passes — the circuit breaker below
     * catches it first, which is the point of having two mechanisms. The one that goes red is
     * "removes a file nothing references", because a sweep that has stopped distinguishing
     * anything stops deleting everything. Loud and harmless, in that order.
     */
    it("keeps a file the database references", async () => {
        const cover = givenFile("art/19/media-1/cover.webp");
        givenArtifactRow("art/19/media-1/cover.webp");

        await runOrphanSweep();

        expect(existsSync(cover)).toBe(true);
    });

    /** The other half: with the path spaces misaligned, this is the test that goes red. */
    it("removes a file nothing references", async () => {
        const stray = givenFile("art/ab/media-2/cover.webp");
        givenArtifactRow("art/19/media-1/cover.webp");
        givenFile("art/19/media-1/cover.webp");

        await runOrphanSweep();

        expect(existsSync(stray)).toBe(false);
    });

    /**
     * The circuit breaker. Every file looking unreferenced while the database names some is a
     * path-space mismatch, not an empty library — and the consequence of acting on it is
     * unrecoverable, so the sweep declines rather than guesses.
     */
    it("refuses to empty a directory outright when nothing at all matches", async () => {
        const one = givenFile("art/19/media-1/cover.webp");
        const two = givenFile("art/19/media-1/preview.webm");
        // A row that names something real, in a path space that does not line up.
        givenArtifactRow("/absolute/nonsense/cover.webp");

        await runOrphanSweep();

        expect(existsSync(one)).toBe(true);
        expect(existsSync(two)).toBe(true);
    });

    /**
     * The breaker must not become an excuse to keep genuine litter. A database that truly
     * references nothing — the state right after a reset — is exactly when the whole tree
     * should go.
     */
    it("does empty a directory when the database references nothing at all", async () => {
        const stray = givenFile("art/19/media-1/cover.webp");

        await runOrphanSweep();

        expect(existsSync(stray)).toBe(false);
    });

    it("leaves a freshly written file alone, because its row may be a moment away", async () => {
        const justWritten = givenFile("art/19/media-3/cover.webp", false);

        await runOrphanSweep();

        expect(existsSync(justWritten)).toBe(true);
    });

    it("applies the variants prefix too, which is stored the same way", async () => {
        const kept = givenFile("variants/73/media-4/websafe.mp4");
        const stray = givenFile("variants/73/media-5/websafe.mp4");
        db.prepare(
            `INSERT INTO "Variant" ("id", "relPath", "createdAt")
             VALUES ('v1', ?, datetime('now', '-2 days'))`
        ).run("variants/73/media-4/websafe.mp4");

        await runOrphanSweep();

        expect(existsSync(kept)).toBe(true);
        expect(existsSync(stray)).toBe(false);
    });

    /**
     * The bin stores its paths in a different space from the other two — relative to the
     * trash directory, with no prefix — because that is what the trash job resolves against.
     * Getting this one wrong destroys files that exist nowhere else.
     */
    it("matches trashed bytes against their own path space, not dataDir's", async () => {
        const kept = givenFile("trash/2026/deleted.mkv");
        const manifest = givenFile("trash/2026/deleted.mkv.json");
        const stray = givenFile("trash/2026/forgotten.mkv");
        db.prepare(`INSERT INTO "TrashEntry" ("trashRelPath") VALUES (?)`).run("2026/deleted.mkv");

        await runOrphanSweep();

        expect(existsSync(kept)).toBe(true);
        expect(existsSync(manifest)).toBe(true);
        expect(existsSync(stray)).toBe(false);
    });

    /**
     * A file that came back by itself (§10e): the scan revived the row and closed the entry,
     * so the copy in the bin is a spare nothing will ever restore or purge.
     */
    it("reclaims the bytes of an entry that is no longer open", async () => {
        const spare = givenFile("trash/2026/came-back.mkv");
        db.prepare(
            `INSERT INTO "TrashEntry" ("trashRelPath", "restoredAt") VALUES (?, CURRENT_TIMESTAMP)`
        ).run("2026/came-back.mkv");

        await runOrphanSweep();

        expect(existsSync(spare)).toBe(false);
    });
});

/**
 * The other direction: rows whose bytes are gone (§13d).
 *
 * A broken cover in the grid, and nothing in the app would ever have noticed -- every "what
 * still needs doing" query asks `MediaStage`, and `MediaStage` said done. This is the state
 * the path-space bug above left 187 items in.
 */
describe("runOrphanSweep, abandoned preview work", () => {
    /**
     * `renderPreview` now works in a directory per attempt, so a killed attempt leaves an empty
     * one behind rather than reusing a fixed name. The files inside are ordinary orphans; the husk
     * is what this takes, because §17 treats inodes under `art` as a budget.
     */
    it("removes the scratch directory an interrupted preview left", async () => {
        const part = givenFile("art/19/media-1/.preview-parts-abc123/part-0.webm");
        const workDir = path.dirname(part);

        givenArtifactRow("art/19/media-1/cover.webp");
        givenFile("art/19/media-1/cover.webp");

        await runOrphanSweep();

        expect(existsSync(part)).toBe(false);
        expect(existsSync(workDir)).toBe(false);
    });

    it("removes the tiles directory an interrupted seeking sprite left", async () => {
        const tile = givenFile("art/19/media-1/.sprite-tiles-x7y8z9/tile-00003.png");

        givenArtifactRow("art/19/media-1/cover.webp");
        givenFile("art/19/media-1/cover.webp");

        await runOrphanSweep();

        expect(existsSync(tile)).toBe(false);
        expect(existsSync(path.dirname(tile))).toBe(false);
    });

    /**
     * The safety argument, stated as a test: `rmdir` refuses a directory with anything in it, so an
     * attempt whose parts are too new to sweep keeps its workspace.
     */
    it("leaves an attempt that is still working", async () => {
        // Not stale: inside the grace window, so `sweepDirectory` will not touch the part.
        const part = givenFile("art/19/media-1/.preview-parts-live99/part-0.webm", false);

        givenArtifactRow("art/19/media-1/cover.webp");
        givenFile("art/19/media-1/cover.webp");

        await runOrphanSweep();

        expect(existsSync(part)).toBe(true);
        expect(existsSync(path.dirname(part))).toBe(true);
    });

    /** Only directories this app makes. Anything else under an item is left exactly alone. */
    it("ignores a directory it did not create", async () => {
        const other = givenFile("art/19/media-1/something-else/keep.txt");

        givenArtifactRow("art/19/media-1/something-else/keep.txt");

        await runOrphanSweep();

        expect(existsSync(path.dirname(other))).toBe(true);
    });
});

describe("runOrphanSweep, rows without files", () => {
    const givenStage = (mediaId: string, stage: string): void => {
        db.prepare(
            `INSERT INTO "MediaStage" ("mediaId", "stage", "state") VALUES (?, ?, 'done')`
        ).run(mediaId, stage);
    };

    const stageOf = (mediaId: string, stage: string) =>
        db
            .prepare(`SELECT "state" FROM "MediaStage" WHERE "mediaId" = ? AND "stage" = ?`)
            .get(mediaId, stage);

    const artifactCount = () =>
        (db.prepare(`SELECT count(*) AS n FROM "Artifact"`).get() as { n: number }).n;

    /**
     * Dropping the row is only half of it. The sweep in §7b asks `MediaStage`, so a cover left
     * marked `done` is never regenerated however many times its file is found missing -- the
     * item simply has no picture, permanently.
     */
    it("clears the stage that produced the file, so it runs again", async () => {
        givenArtifactRow("art/19/media-1/cover.webp");
        givenStage("media-1", "cover");
        // A second item with its file intact, so the circuit breaker stays out of the way.
        givenFile("art/ab/media-9/cover.webp");
        givenArtifactRow("art/ab/media-9/cover.webp", { mediaId: "media-9" });
        givenStage("media-9", "cover");

        await runOrphanSweep();

        expect(stageOf("media-1", "cover")).toBeUndefined();
        // The item whose file is still there keeps its outcome; only the broken one is redone.
        expect(stageOf("media-9", "cover")).toBeDefined();
    });

    it("maps a poster back to the cover stage that makes it", async () => {
        givenArtifactRow("art/19/media-1/poster-1.webp", { kind: "poster" });
        givenStage("media-1", "cover");
        givenFile("art/ab/media-9/cover.webp");
        givenArtifactRow("art/ab/media-9/cover.webp", { mediaId: "media-9" });

        await runOrphanSweep();

        expect(stageOf("media-1", "cover")).toBeUndefined();
    });

    it("maps the sprite VTT back to the sprite stage", async () => {
        givenArtifactRow("art/19/media-1/sprite.vtt", { kind: "spriteVtt" });
        givenStage("media-1", "sprite");
        givenStage("media-1", "cover");
        givenFile("art/ab/media-9/cover.webp");
        givenArtifactRow("art/ab/media-9/cover.webp", { mediaId: "media-9" });

        await runOrphanSweep();

        expect(stageOf("media-1", "sprite")).toBeUndefined();
        // Untouched: nothing said the cover was missing.
        expect(stageOf("media-1", "cover")).toBeDefined();
    });

    it("leaves a row whose file is there alone", async () => {
        givenFile("art/19/media-1/cover.webp");
        givenArtifactRow("art/19/media-1/cover.webp");
        givenStage("media-1", "cover");

        await runOrphanSweep();

        expect(artifactCount()).toBe(1);
        expect(stageOf("media-1", "cover")).toBeDefined();
    });

    it("gives a just-written row the same hour of grace the files get", async () => {
        givenArtifactRow("art/19/media-1/cover.webp", { fresh: true });
        givenFile("art/ab/media-9/cover.webp");
        givenArtifactRow("art/ab/media-9/cover.webp", { mediaId: "media-9" });

        await runOrphanSweep();

        expect(artifactCount()).toBe(2);
    });

    /**
     * A user's chosen capture may not be deleted and regenerated at will (§9). The bytes are
     * already lost; removing the row would additionally lose the fact that a choice was made.
     */
    it("keeps a user-chosen artifact's row even when its file is gone", async () => {
        givenArtifactRow("art/19/media-1/capture-1.webp", { kind: "capture", source: "user" });
        givenFile("art/ab/media-9/cover.webp");
        givenArtifactRow("art/ab/media-9/cover.webp", { mediaId: "media-9" });

        await runOrphanSweep();

        expect(artifactCount()).toBe(2);
    });

    /**
     * A stored path is checked, not merely normalised (§18.1).
     *
     * `relPath` came straight out of the row and was resolved against `dataDir` with nothing
     * but a separator swap, so a value carrying `..` asked the filesystem a question about
     * somewhere outside `/data` — and the answer decided whether a row was deleted. A path
     * we refuse to resolve is no evidence the file is gone, so the row stays.
     */
    it("leaves a row alone rather than resolving a path that escapes dataDir", async () => {
        givenArtifactRow("../outside-the-data-dir.webp");
        givenFile("art/ab/media-9/cover.webp");
        givenArtifactRow("art/ab/media-9/cover.webp", { mediaId: "media-9" });

        await runOrphanSweep();

        expect(artifactCount()).toBe(2);
    });

    /**
     * Every artifact missing at once is an unmounted volume, not a library that lost all its
     * pictures -- and dropping every row on that reading is the same mistake, in the other
     * table, as the one this whole job was found to be making.
     */
    it("refuses to drop every row at once", async () => {
        givenArtifactRow("art/19/media-1/cover.webp");
        givenArtifactRow("art/19/media-2/cover.webp", { mediaId: "media-2" });
        givenStage("media-1", "cover");

        await runOrphanSweep();

        expect(artifactCount()).toBe(2);
        expect(stageOf("media-1", "cover")).toBeDefined();
    });

    it("drops a variant row without touching a stage, because transcoding has none", async () => {
        db.prepare(
            `INSERT INTO "Variant" ("id", "relPath", "createdAt")
             VALUES ('gone', 'variants/73/media-1/websafe.mp4', datetime('now', '-2 days'))`
        ).run();
        const kept = givenFile("variants/73/media-9/websafe.mp4");
        db.prepare(
            `INSERT INTO "Variant" ("id", "relPath", "createdAt")
             VALUES ('here', 'variants/73/media-9/websafe.mp4', datetime('now', '-2 days'))`
        ).run();

        await runOrphanSweep();

        expect((db.prepare(`SELECT count(*) AS n FROM "Variant"`).get() as { n: number }).n).toBe(
            1
        );
        expect(existsSync(kept)).toBe(true);
    });
});

/**
 * Vectors files (§5e) have no table naming them: the `embed` stage row is the record, and the
 * path follows from the item's id.
 */
describe("runOrphanSweep, vectors files", () => {
    const embedded = (mediaId: string): void => {
        db.prepare(
            `INSERT INTO "MediaStage" ("mediaId", "stage", "state") VALUES (?, 'embed', 'done')`
        ).run(mediaId);
    };

    const embedState = (mediaId: string) =>
        db
            .prepare(`SELECT "state" FROM "MediaStage" WHERE "mediaId" = ? AND "stage" = 'embed'`)
            .get(mediaId);

    it("keeps an embedded item's file and the representatives log, and removes the rest", async () => {
        embedded("media-1");
        const kept = givenFile("embed/me/media-1.vec");
        const log = givenFile("embed/reps.log");
        const stray = givenFile("embed/me/media-2.vec");

        await runOrphanSweep();

        expect(existsSync(kept)).toBe(true);
        expect(existsSync(log)).toBe(true);
        expect(existsSync(stray)).toBe(false);
    });

    it("runs the stage again for an item whose file has gone", async () => {
        embedded("media-1");
        embedded("media-9");
        givenFile("embed/me/media-9.vec");

        await runOrphanSweep();

        expect(embedState("media-1")).toBeUndefined();
        expect(embedState("media-9")).toBeDefined();
    });

    it("refuses to redo every item at once, which is an unmounted volume", async () => {
        embedded("media-1");
        embedded("media-9");

        await runOrphanSweep();

        expect(embedState("media-1")).toBeDefined();
        expect(embedState("media-9")).toBeDefined();
    });
});

describe("runOrphanSweep, tags' pictures", () => {
    const pictured = (tagId: string, source: "user" | "auto"): void => {
        db.prepare(
            `INSERT INTO "TagPicture" ("tagId", "source", "relPath", "smallRelPath")
             VALUES (?, ?, ?, ?)`
        ).run(
            tagId,
            source,
            `tags/ta/${tagId}-${source}-large.webp`,
            `tags/ta/${tagId}-${source}-small.webp`
        );
    };
    const row = (tagId: string, source: string) =>
        db
            .prepare(`SELECT 1 FROM "TagPicture" WHERE "tagId" = ? AND "source" = ?`)
            .get(tagId, source);

    it("keeps both files of a picture and removes what no row names", async () => {
        pictured("tag-1", "user");
        const large = givenFile("tags/ta/tag-1-user-large.webp");
        const small = givenFile("tags/ta/tag-1-user-small.webp");
        const stray = givenFile("tags/ta/tag-2-auto-large.webp");
        const scratch = givenFile("tags/.work/tag-3.webp");

        await runOrphanSweep();

        expect(existsSync(large)).toBe(true);
        expect(existsSync(small)).toBe(true);
        expect(existsSync(stray)).toBe(false);
        expect(existsSync(scratch)).toBe(false);
    });

    it("drops an automatic picture whose file is gone, and keeps a chosen one's row", async () => {
        pictured("tag-1", "auto");
        pictured("tag-2", "user");
        pictured("tag-3", "user");
        givenFile("tags/ta/tag-3-user-large.webp");
        givenFile("tags/ta/tag-3-user-small.webp");

        await runOrphanSweep();

        expect(row("tag-1", "auto")).toBeUndefined();
        expect(row("tag-2", "user")).toBeDefined();
    });
});
