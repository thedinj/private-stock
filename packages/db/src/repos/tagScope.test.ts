import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * Two tagging systems, against a real database and two real accounts (§6).
 *
 * Public tags are the library's: everybody sees them, anybody may set or remove one. Private
 * tags are one person's, invisible to everyone else including an administrator.
 *
 * **Two users is the point of this file.** Every other test in the app runs as one account, so
 * the half of the rule that matters — that one person's private tag is nothing at all to
 * anybody else — has nowhere to be checked. There is no way to create a second account through
 * the app yet, which is exactly why the guarantee needs a home that does not need one.
 *
 * Privacy failures are silent by nature: nothing throws when a private tag leaks, the list is
 * merely one row longer than it should be, in somebody else's session, where the person it
 * belonged to will never see it.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const tagRepo = await import("./tagRepo.js");
const { db: sharedDb } = await import("../db.js");

const ADA = "u-ada";
const BEN = "u-ben";
const MEDIA = "m1";

beforeEach(() => {
    db = sharedDb as unknown as Database.Database;
    initializeDatabase(db);
    db.exec(`
        DELETE FROM "MediaTag"; DELETE FROM "Tag";
        DELETE FROM "MediaFileLink"; DELETE FROM "MediaFile"; DELETE FROM "Media";
        DELETE FROM "MediaRoot"; DELETE FROM "User";
    `);
    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES (?, 'ada@example.test', 'Ada', 'x', CURRENT_TIMESTAMP),
                (?, 'ben@example.test', 'Ben', 'x', CURRENT_TIMESTAMP)`
    ).run(ADA, BEN);
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "addedAt", "updatedAt")
         VALUES (?, 'video', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(MEDIA);
});

/** Applies a tag in one of the two systems, as one person. */
const tagIt = (name: string, owner: string | null, by: string): string => {
    const tagId = tagRepo.ensureTag("tag", name, owner);

    tagRepo.assign({ mediaId: MEDIA, tagId, userId: owner, createdById: by });

    return tagId;
};

const namesFor = (userId: string): string[] =>
    tagRepo
        .listForMedia(MEDIA, userId)
        .map((row) => row.name)
        .sort();

describe("what each person can see", () => {
    it("shows a public tag to everybody", () => {
        tagIt("beach", null, ADA);

        expect(namesFor(ADA)).toEqual(["beach"]);
        expect(namesFor(BEN)).toEqual(["beach"]);
    });

    /** The guarantee. Everything else here is a way for this to fail quietly. */
    it("shows a private tag to its owner and to nobody else", () => {
        tagIt("therapy", ADA, ADA);

        expect(namesFor(ADA)).toEqual(["therapy"]);
        expect(namesFor(BEN)).toEqual([]);
    });

    it("keeps two people's private tags apart even under the same name", () => {
        tagIt("todo", ADA, ADA);
        tagIt("todo", BEN, BEN);

        expect(namesFor(ADA)).toEqual(["todo"]);
        expect(namesFor(BEN)).toEqual(["todo"]);
        // Two rows, not one: a single UNIQUE(kind, nameNorm) would have let whoever typed it
        // first own the name for everybody.
        expect(
            db.prepare(`SELECT count(*) AS n FROM "Tag" WHERE "nameNorm" = 'todo'`).get()
        ).toEqual({ n: 2 });
    });

    /**
     * There is no administrator branch anywhere in the tag read path, and that is deliberate:
     * `admin` manages the library, not other people's collections. The role is not represented
     * here because it changes nothing — which is the assertion.
     */
    it("does not let anybody reach another's private tag by any route", () => {
        const tagId = tagIt("therapy", ADA, ADA);

        expect(tagRepo.listForMedia(MEDIA, BEN)).toEqual([]);
        expect(tagRepo.listByKind("tag", BEN)).toEqual([]);
        expect(tagRepo.listByKind("tag", null)).toEqual([]);
        // The row exists; no viewer-scoped read reaches it.
        expect(tagRepo.findById(tagId)?.ownerId).toBe(ADA);
    });
});

describe("the two systems do not blend", () => {
    it("keeps a public and a private tag of the same name separate", () => {
        tagIt("beach", null, ADA);
        tagIt("beach", ADA, ADA);

        // Ada sees both — they are different tags that happen to share a name.
        expect(namesFor(ADA)).toEqual(["beach", "beach"]);
        expect(namesFor(BEN)).toEqual(["beach"]);
    });

    it("reports privacy from the tag rather than from the assignment", () => {
        tagIt("beach", null, ADA);
        tagIt("therapy", ADA, ADA);

        const byName = new Map(tagRepo.listForMedia(MEDIA, ADA).map((row) => [row.name, row]));

        expect(byName.get("beach")?.private).toBeNull();
        expect(byName.get("therapy")?.private).toBe(1);
    });

    /**
     * The invariant `init.ts` used to state only in prose, in both directions. A private tag
     * assigned publicly publishes a name its owner kept; a public tag assigned privately gives
     * a shared chip a second, invisible meaning.
     */
    it("refuses an assignment that would cross the two", () => {
        const mine = tagRepo.ensureTag("tag", "therapy", ADA);
        const shared = tagRepo.ensureTag("tag", "beach", null);

        expect(() =>
            tagRepo.assign({ mediaId: MEDIA, tagId: mine, userId: null, createdById: ADA })
        ).toThrow(/cannot be assigned/);
        expect(() =>
            tagRepo.assign({ mediaId: MEDIA, tagId: mine, userId: BEN, createdById: BEN })
        ).toThrow(/cannot be assigned/);
        expect(() =>
            tagRepo.assign({ mediaId: MEDIA, tagId: shared, userId: ADA, createdById: ADA })
        ).toThrow(/cannot be assigned privately/);
    });
});

describe("who applied it", () => {
    /**
     * Attribution exists because `userId` stopped answering it. On a public row `userId` is
     * NULL whoever wrote it, so without `createdById` a collaborative vocabulary has no record
     * of where any of it came from and nothing to review or revert.
     */
    it("records the person, not the audience", () => {
        tagIt("beach", null, BEN);

        const row = tagRepo.listForMedia(MEDIA, ADA)[0];

        expect(row.addedBy).toBe("Ben");
        expect(row.private).toBeNull();
    });

    /**
     * A public tag belongs to the library, so losing the account that applied it must not
     * untag the library — `ON DELETE SET NULL` rather than CASCADE. The private half is the
     * opposite and cascades, because a private tag has nobody left to be private to.
     */
    it("keeps a public tag when the person who applied it is deleted", () => {
        tagIt("beach", null, BEN);
        tagIt("therapy", BEN, BEN);

        db.prepare(`DELETE FROM "User" WHERE "id" = ?`).run(BEN);

        expect(namesFor(ADA)).toEqual(["beach"]);
        expect(tagRepo.listForMedia(MEDIA, ADA)[0].addedBy).toBeNull();
    });
});

describe("removing a public tag", () => {
    /**
     * Anybody, which is the collaborative norm and symmetric with adding. "Only the person who
     * added it" would make fixing somebody's typo impossible, which is most of the reason to
     * let everyone tag at all — and attribution is what makes it reviewable rather than
     * anonymous.
     */
    it("lets somebody else remove what you added", () => {
        tagIt("beach", null, ADA);

        expect(tagRepo.unassign(MEDIA, tagRepo.ensureTag("tag", "beach", null), null)).toBe(1);
        expect(namesFor(BEN)).toEqual([]);
    });

    it("does not let a public removal reach a private tag of the same name", () => {
        tagIt("beach", null, ADA);
        tagIt("beach", BEN, BEN);

        tagRepo.unassign(MEDIA, tagRepo.ensureTag("tag", "beach", null), null);

        expect(namesFor(ADA)).toEqual([]);
        expect(namesFor(BEN)).toEqual(["beach"]);
    });
});

describe("only tags can be private", () => {
    /**
     * A performer is a fact about the item and a source is where it came from; both are true
     * whoever is looking (§6). A private one is either a fact the library ought to know and
     * does not, or one somebody has got wrong on their own.
     *
     * Enforced in the repo rather than merely not offered, because "not offered" is not a rule:
     * a bulk apply, a hand-written request or a future scraper all reach `ensureTag` with a
     * `kind` of their own choosing.
     */
    it.each(["performer", "source"])("refuses to coin a private %s", (kind) => {
        expect(() => tagRepo.ensureTag(kind, "Jane Doe", ADA, ADA)).toThrow(/cannot be private/);
    });

    it("still allows a public one of every facet", () => {
        for (const kind of ["tag", "performer", "source"]) {
            expect(() => tagRepo.ensureTag(kind, "Jane Doe", null, ADA)).not.toThrow();
        }
    });

    it("allows a private tag, which is the whole of the private system", () => {
        expect(() => tagRepo.ensureTag("tag", "to cut", ADA, ADA)).not.toThrow();
    });

    /**
     * The one path that could reach a private facet without creating a tag: unpublishing a
     * public performer would make one out of a row that already exists.
     */
    it("refuses to unpublish a performer into a private one", () => {
        const performer = tagRepo.ensureTag("performer", "Jane Doe", null, ADA);

        expect(() => tagRepo.setScope(performer, ADA)).toThrow(/cannot be private/);
    });

    it("still lets a public tag be taken private", () => {
        const tag = tagRepo.ensureTag("tag", "beach", null, ADA);

        expect(() => tagRepo.setScope(tag, ADA)).not.toThrow();
    });
});
