import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReconciledText } from "@private-stock/core";

import { initializeDatabase } from "../init.js";

/**
 * Storing what was read out of the picture (§5d).
 *
 * One rule carries this file: a run replaces an item's findings rather than adding to them.
 * Recognition elects strings from what a particular set of frames said, and the occurrence
 * counts that every later decision rests on are counted against that set — so rows from two
 * runs sitting side by side would be comparing against different denominators with no way to
 * tell which was which. Re-running OCR is a correction, not an addition.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const mediaTextRepo = await import("./mediaTextRepo.js");
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

const finding = (text: string, overrides: Partial<ReconciledText> = {}): ReconciledText => ({
    text,
    textNorm: text.toLowerCase(),
    firstAtMs: 1_000,
    lastAtMs: 9_000,
    confidence: 0.9,
    occurrences: 4,
    stability: 0.5,
    box: { x: 0.7, y: 0.9, w: 0.2, h: 0.05 },
    ...overrides,
});

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

    addMedia(MEDIA_A);
    addMedia(MEDIA_B);
});

describe("replacing an item's findings", () => {
    it("leaves nothing behind from the run before", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("EXAMPLE.COM"), finding("AURORA")]);
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("EXAMPLE.COM")]);

        // A denser second run that no longer elects "AURORA" is saying the first run was
        // wrong about it. Keeping the row would leave the item asserting both.
        expect(mediaTextRepo.listForMedia(MEDIA_A).map((row) => row.text)).toEqual(["EXAMPLE.COM"]);
    });

    it("does not touch another item's findings", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_B, [finding("KEEP ME")]);
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("EXAMPLE.COM")]);

        expect(mediaTextRepo.listForMedia(MEDIA_B)).toHaveLength(1);
    });

    it("records no findings without erroring, because that is an answer", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("EXAMPLE.COM")]);
        mediaTextRepo.replaceMachineFindings(MEDIA_A, []);

        // Most files carry no burned-in text. "Nothing found" has to be storable, or the
        // stage can never distinguish it from never having run.
        expect(mediaTextRepo.listForMedia(MEDIA_A)).toEqual([]);
        expect(mediaTextRepo.countForMedia(MEDIA_A)).toBe(0);
    });

    it("keeps the same string found in two places as two findings", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [
            finding("EXAMPLE.COM", { box: { x: 0.7, y: 0.9, w: 0.2, h: 0.05 } }),
            finding("EXAMPLE.COM", { box: { x: 0.2, y: 0.4, w: 0.6, h: 0.15 } }),
        ]);

        // A title card that repeats the site name is different evidence from the watermark,
        // with a different timestamp and a different position. There is deliberately no
        // unique constraint that would collapse them.
        expect(mediaTextRepo.listForMedia(MEDIA_A)).toHaveLength(2);
    });

    it("stores no timestamp for an item that has no timeline", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("EXAMPLE.COM")], false);

        const stored = sharedDb
            .prepare(`SELECT "firstAtMs", "lastAtMs" FROM "MediaText" WHERE "mediaId" = ?`)
            .get(MEDIA_A) as { firstAtMs: number | null; lastAtMs: number | null };

        // A still has one frame and no moment to jump to. Zero would claim it appeared at the
        // start of a timeline the item does not have.
        expect(stored.firstAtMs).toBeNull();
        expect(stored.lastAtMs).toBeNull();
    });
});

describe("reading findings back", () => {
    it("puts the item's identity before its captions", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [
            finding("A CAPTION", { stability: 0.05, confidence: 0.99 }),
            finding("EXAMPLE.COM", { stability: 0.9, confidence: 0.8 }),
        ]);

        // A string on most of the frames is what the item *is*; one read perfectly on a
        // single frame is something that happened in it. Stability leads for that reason,
        // even against a better-read string.
        expect(mediaTextRepo.listForMedia(MEDIA_A).map((row) => row.text)).toEqual([
            "EXAMPLE.COM",
            "A CAPTION",
        ]);
    });

    it("reads many items at once for the index", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("EXAMPLE.COM")]);
        mediaTextRepo.replaceMachineFindings(MEDIA_B, [finding("AURORA")]);

        expect(mediaTextRepo.listForMediaIds([MEDIA_A, MEDIA_B])).toHaveLength(2);
        expect(mediaTextRepo.listForMediaIds([])).toEqual([]);
    });

    it("goes when the item goes", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("EXAMPLE.COM")]);
        sharedDb.prepare(`DELETE FROM "Media" WHERE "id" = ?`).run(MEDIA_A);

        // Findings are derived from the file and mean nothing without it.
        expect(mediaTextRepo.countForMedia(MEDIA_A)).toBe(0);
    });
});

const USER = "33333333-0000-4000-8000-000000000000";

const addUser = (): void => {
    sharedDb
        .prepare(
            `INSERT INTO "User" ("id", "email", "displayName", "password", "scopes", "updatedAt")
             VALUES (?, 'reviewer@example.com', 'Reviewer', 'x', 'admin', CURRENT_TIMESTAMP)`
        )
        .run(USER);
};

const idOf = (mediaId: string, text: string): string =>
    mediaTextRepo
        .listForMedia(mediaId, { includeDismissed: true })
        .find((row) => row.text === text)!.id;

/**
 * Reviewing (§5d "Reviewing what was read"). The promise is that a decision survives the
 * machine: a re-run replaces only what nobody has looked at, and does not read back what
 * somebody rejected.
 */
describe("reviewed findings and re-runs", () => {
    beforeEach(addUser);

    it("keeps a confirmed finding through a re-run that no longer elects it", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("EXAMPLE.COM"), finding("AURORA")]);
        mediaTextRepo.setReviewState([idOf(MEDIA_A, "AURORA")], "confirmed", USER);

        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("EXAMPLE.COM")]);

        expect(
            mediaTextRepo
                .listForMedia(MEDIA_A)
                .map((row) => row.text)
                .sort()
        ).toEqual(["AURORA", "EXAMPLE.COM"]);
    });

    it("does not bring a dismissed string back, and hides it from everything that reads", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("J0NK"), finding("EXAMPLE.COM")]);
        mediaTextRepo.setReviewState([idOf(MEDIA_A, "J0NK")], "dismissed", USER);

        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("J0NK"), finding("EXAMPLE.COM")]);

        expect(mediaTextRepo.listForMedia(MEDIA_A).map((row) => row.text)).toEqual(["EXAMPLE.COM"]);
        expect(
            mediaTextRepo
                .listForMedia(MEDIA_A, { includeDismissed: true })
                .filter((row) => row.text === "J0NK")
        ).toHaveLength(1);
    });

    it("does not show a corrected string twice when the engine misreads it again", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("S1TE.C0M")]);
        mediaTextRepo.editText([idOf(MEDIA_A, "S1TE.C0M")], "SITE.COM", USER);

        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("S1TE.C0M")]);

        const rows = mediaTextRepo.listForMedia(MEDIA_A);

        expect(rows.map((row) => [row.text, row.originalText, row.reviewState])).toEqual([
            ["SITE.COM", "S1TE.C0M", "edited"],
        ]);
        expect(rows[0].textNorm).toBe("site.com");
    });

    it("undoes a correction back to what was read, however many times it was corrected", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("S1TE.C0M")]);
        const id = idOf(MEDIA_A, "S1TE.C0M");

        mediaTextRepo.editText([id], "SITE.CO", USER);
        mediaTextRepo.editText([id], "SITE.COM", USER);
        mediaTextRepo.restore([id]);

        const [row] = mediaTextRepo.listForMedia(MEDIA_A);

        expect([row.text, row.textNorm, row.originalText, row.reviewState]).toEqual([
            "S1TE.C0M",
            "s1te.c0m",
            null,
            null,
        ]);
    });

    it("records a correction back to the original reading as a confirmation", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("S1TE.C0M")]);
        const id = idOf(MEDIA_A, "S1TE.C0M");

        mediaTextRepo.editText([id], "SITE.COM", USER);
        mediaTextRepo.editText([id], "S1TE.C0M", USER);

        const [row] = mediaTextRepo.listForMedia(MEDIA_A);

        expect([row.text, row.originalText, row.reviewState]).toEqual([
            "S1TE.C0M",
            null,
            "confirmed",
        ]);
    });

    it("scopes each action to the rows it can change", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("ONE"), finding("TWO")]);
        mediaTextRepo.replaceMachineFindings(MEDIA_B, [finding("ONE")]);
        mediaTextRepo.setReviewState([idOf(MEDIA_A, "ONE")], "dismissed", USER);

        // Confirming cannot reach a dismissed row; restoring reaches only reviewed ones.
        expect(mediaTextRepo.scopeStrings(["one"], "confirm")).toHaveLength(1);
        expect(mediaTextRepo.scopeStrings(["one"], "dismiss")).toHaveLength(1);
        expect(mediaTextRepo.scopeStrings(["one"], "restore")).toHaveLength(1);
        expect(mediaTextRepo.scopeStrings(["one", "two"], "edit")).toHaveLength(2);
    });

    it("takes an identical copy's findings with their decisions, keeping its own", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_B, [finding("J0NK"), finding("SITE")]);
        mediaTextRepo.setReviewState([idOf(MEDIA_B, "J0NK")], "dismissed", USER);
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("SITE")]);
        mediaTextRepo.setReviewState([idOf(MEDIA_A, "SITE")], "confirmed", USER);

        mediaTextRepo.adoptFindings(
            MEDIA_A,
            mediaTextRepo.listForMedia(MEDIA_B, { includeDismissed: true })
        );

        const rows = mediaTextRepo.listForMedia(MEDIA_A, { includeDismissed: true });

        expect(rows.map((row) => `${row.text}:${row.reviewState}`).sort()).toEqual([
            "J0NK:dismissed",
            "SITE:confirmed",
        ]);
    });
});

/**
 * The summary table is kept by triggers, and the failure it guards against is silent: a string
 * whose counts drift drops out of the review queue and nothing says so. So this checks it
 * against the grouping it stands in for, after a long random run of every kind of change.
 */
describe("the per-string summary", () => {
    beforeEach(addUser);

    const summary = () =>
        sharedDb
            .prepare(
                `SELECT "textNorm", "rowCount", "unreviewedCount", "confirmedCount",
                        "editedCount", "dismissedCount",
                        ROUND("confidenceSum", 6) AS "c", ROUND("stabilitySum", 6) AS "s"
                   FROM "MediaTextString" ORDER BY "textNorm"`
            )
            .all();

    const grouped = () =>
        sharedDb
            .prepare(
                `SELECT "textNorm", COUNT(*) AS "rowCount",
                        SUM("reviewState" IS NULL) AS "unreviewedCount",
                        SUM(COALESCE("reviewState" = 'confirmed', 0)) AS "confirmedCount",
                        SUM(COALESCE("reviewState" = 'edited', 0)) AS "editedCount",
                        SUM(COALESCE("reviewState" = 'dismissed', 0)) AS "dismissedCount",
                        ROUND(SUM("confidence"), 6) AS "c", ROUND(SUM("stability"), 6) AS "s"
                   FROM "MediaText" GROUP BY "textNorm" ORDER BY "textNorm"`
            )
            .all();

    it("matches a GROUP BY over the findings after any sequence of changes", () => {
        const words = ["ALPHA", "BETA", "GAMMA", "DELTA"];
        let state = 7;
        const random = (): number => {
            state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
            return state / 2_147_483_648;
        };
        const pick = <T>(values: T[]): T => values[Math.floor(random() * values.length)];

        for (let step = 0; step < 300; step += 1) {
            const mediaId = pick([MEDIA_A, MEDIA_B]);
            const ids = mediaTextRepo
                .listForMedia(mediaId, { includeDismissed: true })
                .map((row) => row.id);

            switch (pick(["run", "confirm", "dismiss", "edit", "restore", "delete"])) {
                case "run":
                    mediaTextRepo.replaceMachineFindings(
                        mediaId,
                        words
                            .filter(() => random() > 0.4)
                            .map((word) =>
                                finding(word, { confidence: random(), stability: random() })
                            )
                    );
                    break;
                case "confirm":
                    if (ids.length) mediaTextRepo.setReviewState([pick(ids)], "confirmed", USER);
                    break;
                case "dismiss":
                    if (ids.length) mediaTextRepo.setReviewState([pick(ids)], "dismissed", USER);
                    break;
                case "edit":
                    if (ids.length) mediaTextRepo.editText([pick(ids)], pick(words), USER);
                    break;
                case "restore":
                    if (ids.length) mediaTextRepo.restore([pick(ids)]);
                    break;
                case "delete":
                    sharedDb.prepare(`DELETE FROM "MediaText" WHERE "mediaId" = ?`).run(mediaId);
                    break;
            }

            expect(summary()).toEqual(grouped());
        }
    });

    it("goes when the item goes", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("ONLY HERE")]);
        sharedDb.prepare(`DELETE FROM "Media" WHERE "id" = ?`).run(MEDIA_A);

        expect(summary()).toEqual([]);
    });
});

describe("the items showing a string", () => {
    it("pages by id, only those still in the library and visible to the caller", () => {
        mediaTextRepo.replaceMachineFindings(MEDIA_A, [finding("SITE")]);
        mediaTextRepo.replaceMachineFindings(MEDIA_B, [finding("SITE")]);
        sharedDb
            .prepare(`UPDATE "Media" SET "listable" = 1, "listRootId" = 'root' WHERE "id" = ?`)
            .run(MEDIA_A);

        const page = (rootIds: string[]) =>
            mediaTextRepo.listItemIds({ rootIds, textNorm: "site", after: null, limit: 10 });

        expect(page(["root"])).toEqual({ ids: [MEDIA_A], next: null });
        // Nobody sees an item in a library they have no access to (§6).
        expect(page(["another"])).toEqual({ ids: [], next: null });
    });
});
