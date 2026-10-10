import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Suggestions (§5f "Suggestions"): which appearances are asked about, and what saying "them" or
 * "not them" of one writes.
 */

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const appearanceRepo = await import("./appearanceRepo.js");
const faceRepo = await import("./faceRepo.js");
const { db: sharedDb } = await import("../db.js");

let db: Database.Database;

const LINES = { line: 0.55, margin: 0.1, namedLine: 0.45 };

const face = (vectorIndex: number) => ({
    vectorIndex,
    atMs: vectorIndex * 10_000,
    x: 0.1 * vectorIndex,
    y: 0.1,
    w: 0.2,
    h: 0.3,
    eyes: 30,
    score: 0.9,
});

const listable = (mediaId: string): void => {
    db.prepare(
        `INSERT OR IGNORE INTO "MediaRoot" ("id", "path", "label", "updatedAt")
         VALUES ('root', '/media', 'Media', CURRENT_TIMESTAMP)`
    ).run();
    db.prepare(
        `INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "lastSeenAt", "updatedAt")
         VALUES (?, 'root', ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(`file-${mediaId}`, `${mediaId}.mp4`);
    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role") VALUES (?, ?, ?, 'original')`
    ).run(`link-${mediaId}`, mediaId, `file-${mediaId}`);
    db.prepare(`UPDATE "Media" SET "listable" = 1 WHERE "id" = ?`).run(mediaId);
};

/** An item with one person on it, their two faces, matched to `tagId` at `score`. */
const person = (mediaId: string, tagId: string, score: number, extra = {}): string[] => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "updatedAt") VALUES (?, 'video', ?, CURRENT_TIMESTAMP)`
    ).run(mediaId, mediaId);
    listable(mediaId);
    faceRepo.replaceForMedia(mediaId, [face(0), face(1)]);

    const faceIds = (
        db
            .prepare(`SELECT "id" FROM "Face" WHERE "mediaId" = ? ORDER BY "vectorIndex"`)
            .all(mediaId) as { id: string }[]
    ).map((row) => row.id);

    appearanceRepo.replaceAll([
        ...existing(),
        {
            id: `p-${mediaId}`,
            mediaId,
            faceIds,
            bestFaceId: faceIds[0],
            legible: true,
            matchTagId: tagId,
            score,
            second: 0.2,
            ...extra,
        },
    ]);

    return faceIds;
};

/** The appearances already written, so another can be added beside them. */
const existing = (): appearanceRepo.NewAppearance[] =>
    (
        db.prepare(`SELECT * FROM "FaceAppearance"`).all() as {
            id: string;
            mediaId: string;
            bestFaceId: string;
            legible: number | null;
            matchTagId: string | null;
            score: number | null;
            second: number | null;
        }[]
    ).map((row) => ({
        ...row,
        legible: row.legible === 1,
        faceIds: (
            db.prepare(`SELECT "id" FROM "Face" WHERE "appearanceId" = ?`).all(row.id) as {
                id: string;
            }[]
        ).map((f) => f.id),
    }));

const suggested = (tagId = "jane"): string[] =>
    appearanceRepo
        .suggestions({ tagId, rootIds: ["root"], lines: LINES, kind: null, after: null, limit: 50 })
        .map((row) => row.mediaId);

beforeEach(() => {
    db = sharedDb as Database.Database;
    db.pragma("foreign_keys = OFF");

    const virtualPrefixes = (
        db
            .prepare(
                `SELECT "name" FROM sqlite_master
                  WHERE "type" = 'table' AND "sql" LIKE 'CREATE VIRTUAL TABLE%'`
            )
            .all() as { name: string }[]
    ).map((row) => `${row.name}_`);

    for (const { name } of db
        .prepare(
            `SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[]) {
        if (!virtualPrefixes.some((prefix) => name.startsWith(prefix))) {
            db.exec(`DROP TABLE IF EXISTS "${name}"`);
        }
    }

    db.pragma("foreign_keys = ON");
    initializeDatabase(db);
    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES ('someone', 'someone@example.com', 'Someone', 'x', CURRENT_TIMESTAMP)`
    ).run();

    for (const id of ["jane", "kim"]) {
        db.prepare(
            `INSERT INTO "Tag" ("id", "kind", "name", "nameNorm", "updatedAt")
             VALUES (?, 'performer', ?, ?, CURRENT_TIMESTAMP)`
        ).run(id, id, id);
    }
});

describe("what is suggested", () => {
    it("asks about a legible person clearly them, surest first, and counts them", () => {
        person("a", "jane", 0.6);
        person("b", "jane", 0.8);
        person("weak", "jane", 0.5);
        person("small", "jane", 0.9, { legible: false });
        person("close", "jane", 0.6, { second: 0.55 });

        expect(suggested()).toEqual(["b", "a"]);
        expect(appearanceRepo.suggestedPerformers(["root"], LINES, null)).toEqual([
            { tagId: "jane", count: 2 },
        ]);
    });

    it("asks at a lower line where the item's text names them", () => {
        person("named", "jane", 0.5);
        db.prepare(
            `INSERT INTO "MediaMention" ("mediaId", "tagId", "field") VALUES ('named', 'jane', 'title')`
        ).run();

        expect(suggested()).toEqual(["named"]);
    });

    it("leaves out items tagged, refused, or a person somebody decided", () => {
        person("tagged", "jane", 0.8);
        person("refused", "jane", 0.8);
        const seen = person("seen", "jane", 0.8);
        const unseen = person("unseen", "jane", 0.8);
        const confirmed = person("theirs", "jane", 0.8);

        db.prepare(
            `INSERT INTO "MediaTag" ("id", "mediaId", "tagId", "source") VALUES ('t', 'tagged', 'jane', 'user')`
        ).run();
        db.prepare(
            `INSERT INTO "ItemRefusal" ("tagId", "mediaId") VALUES ('jane', 'refused')`
        ).run();
        db.prepare(
            `INSERT INTO "FaceRefusal" ("faceId", "tagId", "how") VALUES (?, 'jane', 'shown')`
        ).run(seen[0]);
        // A refusal carried to a face nobody saw does not speak for the person.
        db.prepare(
            `INSERT INTO "FaceRefusal" ("faceId", "tagId", "how") VALUES (?, 'jane', 'inferred')`
        ).run(unseen[1]);
        db.prepare(`UPDATE "Face" SET "tagId" = 'kim' WHERE "id" = ?`).run(confirmed[1]);

        expect(suggested()).toEqual(["unseen"]);
    });

    it("pages after the last one shown", () => {
        person("a", "jane", 0.9);
        person("b", "jane", 0.8);

        const [first] = appearanceRepo.suggestions({
            tagId: "jane",
            rootIds: ["root"],
            lines: LINES,
            kind: null,
            after: null,
            limit: 1,
        });
        const rest = appearanceRepo.suggestions({
            tagId: "jane",
            rootIds: ["root"],
            lines: LINES,
            kind: null,
            after: { score: first.score, id: first.id },
            limit: 1,
        });

        expect([first.mediaId, rest[0].mediaId]).toEqual(["a", "b"]);
    });
});

describe("deciding about a person", () => {
    it("confirms all their faces, the later word over an earlier refusal", () => {
        const faces = person("a", "jane", 0.8);

        db.prepare(
            `INSERT INTO "FaceRefusal" ("faceId", "tagId", "how") VALUES (?, 'jane', 'inferred')`
        ).run(faces[1]);

        expect(appearanceRepo.confirmPerson(faces, faces[0], "jane", "someone")).toBe(2);
        expect(
            db
                .prepare(
                    `SELECT "decidedHow" FROM "Face" WHERE "mediaId" = 'a' ORDER BY "vectorIndex"`
                )
                .pluck()
                .all()
        ).toEqual(["shown", "inferred"]);
        expect(db.prepare(`SELECT count(*) FROM "FaceRefusal"`).pluck().get()).toBe(0);
    });

    it("refuses all their faces, the one shown as seen", () => {
        const faces = person("a", "jane", 0.8);

        expect(appearanceRepo.refusePerson(faces, faces[0], "jane", "someone")).toBe(2);
        expect(suggested()).toEqual([]);
    });
});

describe("a performer's Faces tab", () => {
    it("lists the people confirmed as them, and takes one back as not them", () => {
        const faces = person("a", "jane", 0.8);

        appearanceRepo.confirmPerson(faces, faces[0], "jane", "someone");

        const { rows, total } = appearanceRepo.confirmedPeople("jane", ["root"], 0, 10);

        expect(total).toBe(1);
        expect(rows[0]).toMatchObject({ mediaId: "a", moments: 2 });

        appearanceRepo.takeBackPerson(faces, faces[0], "jane", "someone");

        expect(appearanceRepo.confirmedPeople("jane", ["root"], 0, 10).total).toBe(0);
        expect(appearanceRepo.refusedPeople("jane", ["root"], false, 0, 10).total).toBe(1);
    });

    it("lists the people ruled out — those seen, or every one — and restores them", () => {
        const seen = person("a", "jane", 0.8);
        const unseen = person("b", "jane", 0.8);

        appearanceRepo.refusePerson(seen, seen[0], "jane", "someone");
        db.prepare(
            `INSERT INTO "FaceRefusal" ("faceId", "tagId", "how") VALUES (?, 'jane', 'inferred')`
        ).run(unseen[0]);

        expect(appearanceRepo.refusedPeople("jane", ["root"], false, 0, 10).total).toBe(1);
        expect(appearanceRepo.refusedPeople("jane", ["root"], true, 0, 10).total).toBe(2);

        appearanceRepo.restorePerson(seen, "jane");

        expect(appearanceRepo.refusedPeople("jane", ["root"], false, 0, 10).total).toBe(0);
    });

    it("lists their own items with nobody confirmed, tagged by hand and not by a face", () => {
        person("mine", "jane", 0.8);
        person("auto", "jane", 0.8);
        const done = person("done", "jane", 0.8);

        for (const [mediaId, source] of [
            ["mine", "user"],
            ["auto", "ai"],
            ["done", "user"],
        ]) {
            db.prepare(
                `INSERT INTO "MediaTag" ("id", "mediaId", "tagId", "source") VALUES (?, ?, 'jane', ?)`
            ).run(`t-${mediaId}`, mediaId, source);
        }
        appearanceRepo.confirmPerson(done, done[0], "jane", "someone");

        const { mediaIds, total } = appearanceRepo.unconfirmedItems("jane", ["root"], 0, 10);

        expect(mediaIds).toEqual(["mine"]);
        expect(total).toBe(1);
        expect(appearanceRepo.peopleOn(mediaIds)).toEqual([
            expect.objectContaining({ mediaId: "mine", moments: 2 }),
        ]);
    });
});
