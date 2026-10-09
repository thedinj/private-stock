import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Artifacts are where "the app generated this" and "a person made this" share one table.
 *
 * The tests that matter are the ones about that boundary: a regenerated cover must not
 * destroy a chosen one, a capture must not be mistaken for disposable output, and an
 * artifact belonging to one item must never be servable as another's.
 */

let db: Database.Database;

// The repo binds to the shared `db` export at import time, so the tests point that at an
// in-memory database rather than the real one.
vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const artifactRepo = await import("./artifactRepo.js");
const { db: sharedDb } = await import("../db.js");

const MEDIA_A = "11111111-0000-4000-8000-000000000000";
const MEDIA_B = "22222222-0000-4000-8000-000000000000";

const addMedia = (id: string): void => {
    sharedDb
        .prepare(
            `INSERT INTO "Media" ("id", "kind", "title", "updatedAt")
             VALUES (?, 'video', 'Test', CURRENT_TIMESTAMP)`
        )
        .run(id);
};

beforeEach(() => {
    db = sharedDb as Database.Database;

    // Drop everything rather than a chosen few. `DROP TABLE` with foreign keys enabled fires
    // the referential actions of child tables, so dropping a subset fails as soon as one
    // child has already gone — and which subset is safe changes every time the schema does.
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

    addMedia(MEDIA_A);
    addMedia(MEDIA_B);
});

describe("upsert", () => {
    it("keeps the row id stable when regenerating, so a chosen cover survives", () => {
        const first = artifactRepo.upsert({
            mediaId: MEDIA_A,
            kind: "cover",
            relPath: "art/11/a/cover.webp",
            atMs: 1000,
        });

        // Someone picks the generated cover explicitly, then the generator runs again.
        artifactRepo.setCoverArtifact(MEDIA_A, first.id);

        const second = artifactRepo.upsert({
            mediaId: MEDIA_A,
            kind: "cover",
            relPath: "art/11/a/cover.webp",
            atMs: 2000,
        });

        // Delete-then-insert would give a new id here and silently clear the choice.
        expect(second.id).toBe(first.id);
        expect(artifactRepo.findEffectiveCover(MEDIA_A)?.atMs).toBe(2000);
    });

    it("defaults to an auto artifact, and records a user one as such", () => {
        const auto = artifactRepo.upsert({
            mediaId: MEDIA_A,
            kind: "cover",
            relPath: "art/11/a/cover.webp",
        });

        const capture = artifactRepo.upsert({
            mediaId: MEDIA_A,
            kind: "capture",
            ordinal: 0,
            relPath: "art/11/a/capture-0.webp",
            source: "user",
            atMs: 42_000,
            label: "the good bit",
        });

        expect(auto.source).toBe("auto");
        expect(capture.source).toBe("user");
        expect(capture.atMs).toBe(42_000);
        expect(capture.label).toBe("the good bit");
    });
});

describe("findEffectiveCover", () => {
    it("falls back to the generated cover when nothing was chosen", () => {
        const generated = artifactRepo.upsert({
            mediaId: MEDIA_A,
            kind: "cover",
            relPath: "art/11/a/cover.webp",
        });

        expect(artifactRepo.findEffectiveCover(MEDIA_A)?.id).toBe(generated.id);
    });

    it("prefers a chosen artifact, including a user capture", () => {
        artifactRepo.upsert({ mediaId: MEDIA_A, kind: "cover", relPath: "art/11/a/cover.webp" });

        const capture = artifactRepo.upsert({
            mediaId: MEDIA_A,
            kind: "capture",
            relPath: "art/11/a/capture-0.webp",
            source: "user",
        });

        artifactRepo.setCoverArtifact(MEDIA_A, capture.id);

        expect(artifactRepo.findEffectiveCover(MEDIA_A)?.id).toBe(capture.id);
    });

    it("reverts to the generated cover when the choice is cleared", () => {
        const generated = artifactRepo.upsert({
            mediaId: MEDIA_A,
            kind: "cover",
            relPath: "art/11/a/cover.webp",
        });
        const poster = artifactRepo.upsert({
            mediaId: MEDIA_A,
            kind: "poster",
            ordinal: 1,
            relPath: "art/11/a/poster-1.webp",
        });

        artifactRepo.setCoverArtifact(MEDIA_A, poster.id);
        expect(artifactRepo.findEffectiveCover(MEDIA_A)?.id).toBe(poster.id);

        artifactRepo.setCoverArtifact(MEDIA_A, null);
        expect(artifactRepo.findEffectiveCover(MEDIA_A)?.id).toBe(generated.id);
    });

    it("returns nothing for an item with no imagery at all", () => {
        expect(artifactRepo.findEffectiveCover(MEDIA_A)).toBeUndefined();
    });
});

describe("setCoverArtifact", () => {
    it("refuses an artifact belonging to another media item", () => {
        const foreign = artifactRepo.upsert({
            mediaId: MEDIA_B,
            kind: "cover",
            relPath: "art/22/b/cover.webp",
        });

        // Without the ownership check this would serve item B's picture as item A's, and
        // across a root boundary it would leak the existence of media the viewer cannot see.
        expect(artifactRepo.setCoverArtifact(MEDIA_A, foreign.id)).toBe(false);
        expect(artifactRepo.findEffectiveCover(MEDIA_A)).toBeUndefined();
    });

    it("clears the pointer rather than orphaning it when the artifact is deleted", () => {
        const capture = artifactRepo.upsert({
            mediaId: MEDIA_A,
            kind: "capture",
            relPath: "art/11/a/capture-0.webp",
            source: "user",
        });

        artifactRepo.setCoverArtifact(MEDIA_A, capture.id);
        artifactRepo.remove(capture.id);

        // ON DELETE SET NULL: the item loses its chosen cover, not its row.
        const media = db
            .prepare(`SELECT "coverArtifactId" FROM "Media" WHERE "id" = ?`)
            .get(MEDIA_A) as { coverArtifactId: string | null };

        expect(media.coverArtifactId).toBeNull();
    });
});

describe("nextOrdinal", () => {
    it("counts up per kind, so captures accumulate instead of overwriting", () => {
        expect(artifactRepo.nextOrdinal(MEDIA_A, "capture")).toBe(0);

        artifactRepo.upsert({
            mediaId: MEDIA_A,
            kind: "capture",
            ordinal: 0,
            relPath: "art/11/a/capture-0.webp",
            source: "user",
        });

        expect(artifactRepo.nextOrdinal(MEDIA_A, "capture")).toBe(1);
        // Posters are a different sequence and unaffected.
        expect(artifactRepo.nextOrdinal(MEDIA_A, "poster")).toBe(0);
    });

    it("does not reuse an ordinal after a capture in the middle is deleted", () => {
        for (const ordinal of [0, 1, 2]) {
            artifactRepo.upsert({
                mediaId: MEDIA_A,
                kind: "capture",
                ordinal,
                relPath: `art/11/a/capture-${ordinal}.webp`,
                source: "user",
            });
        }

        const middle = artifactRepo.findOne(MEDIA_A, "capture", 1)!;
        artifactRepo.remove(middle.id);

        // Reusing ordinal 1 would resurrect a deleted capture's URL, which a browser or a
        // proxy may still have cached.
        expect(artifactRepo.nextOrdinal(MEDIA_A, "capture")).toBe(3);
    });
});

/**
 * The Captures page (§9 "Your captures, in one place"): one person's stills, of items the
 * library would show, in libraries they can still reach — and nothing that merely looks like a
 * still, such as a poster or a capture's own cover-sized rendering.
 */
describe("searchCaptures", () => {
    const ME = "99999999-0000-4000-8000-000000000000";
    const THEM = "88888888-0000-4000-8000-000000000000";
    const ROOT_A = "root-a";
    const ROOT_B = "root-b";

    const addUser = (id: string, email: string): void => {
        sharedDb
            .prepare(
                `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
                 VALUES (?, ?, ?, 'x', CURRENT_TIMESTAMP)`
            )
            .run(id, email, email);
    };

    const list = (mediaId: string, rootId: string, title: string): void => {
        sharedDb
            .prepare(
                `UPDATE "Media" SET "listable" = 1, "listRootId" = ?, "title" = ? WHERE "id" = ?`
            )
            .run(rootId, title, mediaId);
    };

    /** A capture as `captureFrame` writes it: the still, and its rendering at the same ordinal. */
    const capture = (
        mediaId: string,
        ordinal: number,
        options: { by?: string | null; atMs?: number; at?: string; label?: string } = {}
    ): { still: string; rendering: string } => {
        const by = options.by === undefined ? ME : options.by;
        const still = artifactRepo.upsert({
            mediaId,
            kind: "capture",
            ordinal,
            relPath: `captures/xx/${mediaId}/capture-${ordinal}.webp`,
            atMs: options.atMs ?? ordinal * 1000,
            source: "user",
            createdByUserId: by,
            label: options.label ?? null,
        });
        const rendering = artifactRepo.upsert({
            mediaId,
            kind: "cover",
            ordinal,
            relPath: `art/xx/${mediaId}/cover-${ordinal}.webp`,
            source: "user",
            createdByUserId: by,
        });

        if (options.at) {
            sharedDb
                .prepare(`UPDATE "Artifact" SET "generatedAt" = ? WHERE "id" = ?`)
                .run(options.at, still.id);
        }

        return { still: still.id, rendering: rendering.id };
    };

    const scope = (roots: string[] | null = [ROOT_A, ROOT_B]) => ({
        userId: ME,
        accessibleRootIds: roots,
    });

    const search = (
        query: { search?: string; sort?: "created" | "title" | "position" } = {},
        direction: "asc" | "desc" = "desc",
        roots: string[] | null = [ROOT_A, ROOT_B]
    ) =>
        artifactRepo.searchCaptures(
            { sort: "created", limit: 60, page: 0, ...query },
            scope(roots),
            direction
        );

    beforeEach(() => {
        addUser(ME, "me@example.com");
        addUser(THEM, "them@example.com");
        list(MEDIA_A, ROOT_A, "Alpha");
        list(MEDIA_B, ROOT_B, "Bravo");
    });

    /** Hiding is "do not show me this" (§6); an item put away does not return through its stills. */
    it("leaves out stills of an item this person has hidden", () => {
        capture(MEDIA_A, 1);
        capture(MEDIA_B, 1);
        sharedDb
            .prepare(
                `INSERT INTO "UserMedia" ("userId", "mediaId", "hidden", "updatedAt")
                 VALUES (?, ?, 1, CURRENT_TIMESTAMP)`
            )
            .run(ME, MEDIA_B);

        expect(search().map((row) => row.mediaId)).toEqual([MEDIA_A]);
        expect(artifactRepo.countCaptures({}, scope())).toBe(1);
    });

    it("lists only this person's captures, never posters, renderings or anybody else's", () => {
        const mine = capture(MEDIA_A, 1);
        capture(MEDIA_A, 2, { by: THEM });
        capture(MEDIA_A, 3, { by: null });
        artifactRepo.upsert({ mediaId: MEDIA_A, kind: "cover", relPath: "art/xx/a/cover.webp" });
        artifactRepo.upsert({
            mediaId: MEDIA_A,
            kind: "poster",
            ordinal: 1,
            relPath: "art/xx/a/poster-1.webp",
        });

        const rows = search();

        expect(rows.map((row) => row.id)).toEqual([mine.still]);
        expect(rows[0].renderingId).toBe(mine.rendering);
        expect(rows[0].mediaTitle).toBe("Alpha");
    });

    it("hides items that cannot be listed, and libraries the account cannot reach", () => {
        capture(MEDIA_A, 1);
        capture(MEDIA_B, 1);
        sharedDb.prepare(`UPDATE "Media" SET "listable" = NULL WHERE "id" = ?`).run(MEDIA_B);

        expect(search().map((row) => row.mediaId)).toEqual([MEDIA_A]);
        expect(search({}, "desc", [ROOT_B])).toEqual([]);
        expect(search({}, "desc", [])).toEqual([]);
        expect(search({}, "desc", null).map((row) => row.mediaId)).toEqual([MEDIA_A]);
    });

    it("searches the caption and the title, with LIKE's wildcards taken literally", () => {
        const captioned = capture(MEDIA_A, 1, { label: "Sunset at 50% zoom" });
        const titled = capture(MEDIA_B, 1);

        expect(search({ search: "sunset" }).map((row) => row.id)).toEqual([captioned.still]);
        expect(search({ search: "bravo" }).map((row) => row.id)).toEqual([titled.still]);
        expect(search({ search: "50%" }).map((row) => row.id)).toEqual([captioned.still]);
        expect(search({ search: "%" }).map((row) => row.id)).toEqual([captioned.still]);
        expect(search({ search: "_" })).toEqual([]);
    });

    it("sorts by when it was taken, by title in timeline order, and by position", () => {
        const late = capture(MEDIA_A, 1, { atMs: 9000, at: "2026-09-02 00:00:00" });
        const early = capture(MEDIA_A, 2, { atMs: 1000, at: "2026-09-01 00:00:00" });
        const other = capture(MEDIA_B, 1, { atMs: 5000, at: "2026-09-03 00:00:00" });

        expect(search({ sort: "created" }, "desc").map((row) => row.id)).toEqual([
            other.still,
            late.still,
            early.still,
        ]);
        // Alpha's two in timeline order whichever way the titles run.
        expect(search({ sort: "title" }, "asc").map((row) => row.id)).toEqual([
            early.still,
            late.still,
            other.still,
        ]);
        expect(search({ sort: "title" }, "desc").map((row) => row.id)).toEqual([
            other.still,
            early.still,
            late.still,
        ]);
        expect(search({ sort: "position" }, "asc").map((row) => row.id)).toEqual([
            early.still,
            other.still,
            late.still,
        ]);
    });

    it("never pairs an ordinal-0 capture with the generator's cover", () => {
        artifactRepo.upsert({ mediaId: MEDIA_A, kind: "cover", relPath: "art/xx/a/cover.webp" });
        artifactRepo.upsert({
            mediaId: MEDIA_A,
            kind: "capture",
            ordinal: 0,
            relPath: "captures/xx/a/capture-0.webp",
            source: "user",
            createdByUserId: ME,
        });

        const [row] = search();

        expect(row.renderingId).toBeNull();
        expect(row.isCover).toBeNull();
    });

    it("marks the capture whose rendering is the chosen cover", () => {
        const chosen = capture(MEDIA_A, 1);
        const other = capture(MEDIA_A, 2);
        artifactRepo.setCoverArtifact(MEDIA_A, chosen.rendering);

        const byId = new Map(search().map((row) => [row.id, row.isCover]));

        expect(byId.get(chosen.still)).toBe(1);
        expect(byId.get(other.still)).toBeNull();
    });

    it("pages, and counts what an unpaged search would return", () => {
        for (const ordinal of [1, 2, 3, 4, 5]) {
            capture(MEDIA_A, ordinal, { at: `2026-09-0${ordinal} 00:00:00` });
        }

        const page = artifactRepo.searchCaptures(
            { sort: "created", limit: 2, page: 2 },
            scope(),
            "desc"
        );

        expect(page.map((row) => row.ordinal)).toEqual([1]);
        expect(artifactRepo.countCaptures({}, scope())).toBe(5);
        expect(artifactRepo.countCaptures({ search: "nothing" }, scope())).toBe(0);
    });

    it("walks the owner index for the default sort rather than scanning and sorting", () => {
        const plan = db
            .prepare(
                `EXPLAIN QUERY PLAN
                 SELECT a."id" FROM "Artifact" a JOIN "Media" m ON m."id" = a."mediaId"
                  WHERE a."kind" = 'capture' AND a."createdByUserId" = ? AND m."listable" = 1
                  ORDER BY a."generatedAt" DESC, a."id" ASC LIMIT 60`
            )
            .all(ME) as { detail: string }[];
        const detail = plan.map((row) => row.detail).join("\n");

        expect(detail).toContain("idx_Artifact_capture_owner");
        expect(detail).not.toMatch(/SCAN a\b/);
    });
});

describe("setLabel", () => {
    it("writes and clears a capture's caption without touching its version", () => {
        const still = artifactRepo.upsert({
            mediaId: MEDIA_A,
            kind: "capture",
            ordinal: 1,
            relPath: "captures/xx/a/capture-1.webp",
            source: "user",
        });
        db.prepare(
            `UPDATE "Artifact" SET "generatedAt" = '2026-01-01 00:00:00' WHERE "id" = ?`
        ).run(still.id);

        expect(artifactRepo.setLabel(still.id, "The good one")).toBe(true);
        expect(artifactRepo.findById(still.id)?.label).toBe("The good one");
        expect(artifactRepo.findById(still.id)?.generatedAt).toBe("2026-01-01 00:00:00");

        expect(artifactRepo.setLabel(still.id, null)).toBe(true);
        expect(artifactRepo.findById(still.id)?.label).toBeNull();
    });

    it("refuses anything that is not a capture", () => {
        const cover = artifactRepo.upsert({
            mediaId: MEDIA_A,
            kind: "cover",
            relPath: "art/xx/a/cover.webp",
        });

        expect(artifactRepo.setLabel(cover.id, "Nope")).toBe(false);
        expect(artifactRepo.findById(cover.id)?.label).toBeNull();
    });
});
