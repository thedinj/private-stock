import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError, ValidationError } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * Who may touch a review pass, and where its marks may go (§14d).
 *
 * The SQL is tested against a real database in `packages/db`; this is the authorisation in
 * front of it, against a fake that keeps passes and marks the way the tables do -- including
 * a pass's marks going with it.
 */

interface Pass {
    id: string;
    ownerId: string;
    domain: string;
    name: string;
}

let passes: Pass[] = [];
let marks: { passId: string; mediaId: string }[] = [];
/** Items by room; an item absent here has no original left to say. */
let rooms: Map<string, string> = new Map();
/** Items the caller's libraries hold. */
let visible: Set<string> = new Set();
let cleared = 0;

const listRow = (pass: Pass) => ({
    ...pass,
    marks: marks.filter((mark) => mark.passId === pass.id).length,
});

vi.mock("@private-stock/db", () => ({
    mediaRepo: {
        findDetail: (mediaId: string) => (visible.has(mediaId) ? { id: mediaId } : undefined),
    },
    reviewPassRepo: {
        listForOwner: (ownerId: string, domain: string | null) =>
            passes
                .filter((pass) => pass.ownerId === ownerId && (!domain || pass.domain === domain))
                .map(listRow),
        findById: (id: string) => passes.find((pass) => pass.id === id),
        findByName: (ownerId: string, domain: string, name: string) =>
            passes.find(
                (pass) =>
                    pass.ownerId === ownerId &&
                    pass.domain === domain &&
                    pass.name.toLowerCase() === name.toLowerCase()
            ),
        create: (ownerId: string, domain: string, name: string) => {
            const id = `p${passes.length + 1}`;

            passes.push({ id, ownerId, domain, name });

            return id;
        },
        rename: (id: string, name: string) => {
            passes = passes.map((pass) => (pass.id === id ? { ...pass, name } : pass));
        },
        remove: (id: string) => {
            const before = marks.length;

            marks = marks.filter((mark) => mark.passId !== id);
            passes = passes.filter((pass) => pass.id !== id);

            return before - marks.length;
        },
        mark: (passId: string, mediaIds: string[]) => {
            const fresh = mediaIds.filter(
                (mediaId) => !marks.some((m) => m.passId === passId && m.mediaId === mediaId)
            );

            marks.push(...fresh.map((mediaId) => ({ passId, mediaId })));

            return fresh.length;
        },
        unmark: (passId: string, mediaIds: string[]) => {
            const before = marks.length;

            marks = marks.filter((m) => !(m.passId === passId && mediaIds.includes(m.mediaId)));

            return before - marks.length;
        },
        marksFor: (ownerId: string, mediaId: string) =>
            marks
                .filter((m) => m.mediaId === mediaId)
                .map((m) => passes.find((pass) => pass.id === m.passId)!)
                .filter((pass) => pass.ownerId === ownerId)
                .map((pass) => ({ passId: pass.id, name: pass.name, reviewedAt: "2026-11-08" })),
        itemDomains: (mediaIds: string[]) =>
            new Map(
                mediaIds.flatMap((id) => (rooms.has(id) ? [[id, rooms.get(id)!] as const] : []))
            ),
    },
}));

vi.mock("./libraryService", () => ({
    clearLibraryCaches: () => {
        cleared += 1;
    },
}));

const service = await import("./reviewPassService");

const as = (userId: string, domain: "games" | "cellar" = "games"): AuthContext =>
    ({ userId, domain, accessibleRootIds: ["r"], scopes: [] }) as unknown as AuthContext;

const ANNA = as("anna");
const BOB = as("bob");

beforeEach(() => {
    passes = [];
    marks = [];
    rooms = new Map([
        ["g1", "games"],
        ["g2", "games"],
        ["c1", "cellar"],
    ]);
    visible = new Set(["g1", "g2", "c1", "orphan"]);
    cleared = 0;
});

describe("passes", () => {
    it("are made in the request's room and listed per room or all", () => {
        service.createPass("Players", ANNA);
        service.createPass("Reviewed", as("anna", "cellar"));
        service.createPass("Players", BOB);

        expect(service.listPasses(ANNA, "here").map((pass) => pass.name)).toEqual(["Players"]);
        expect(service.listPasses(ANNA, "all").map((pass) => pass.domain)).toEqual([
            "games",
            "cellar",
        ]);
    });

    it("refuses a second of the same name in a room, whatever its case", () => {
        service.createPass("Players", ANNA);

        expect(() => service.createPass("players", ANNA)).toThrow(ConflictError);
        expect(() => service.createPass("Players", as("anna", "cellar"))).not.toThrow();
    });

    it("refuses a request that names no room", () => {
        expect(() =>
            service.createPass("Players", { ...ANNA, domain: null } as AuthContext)
        ).toThrow(ValidationError);
    });

    it("renames only the owner's, and refuses a clash", () => {
        const players = service.createPass("Players", ANNA);
        service.createPass("Wins", ANNA);

        expect(service.renamePass(players.id, "Who", ANNA).name).toBe("Who");
        expect(() => service.renamePass(players.id, "wins", ANNA)).toThrow(ConflictError);
        // Renaming to its own name in another case is not a clash with itself.
        expect(service.renamePass(players.id, "WHO", ANNA).name).toBe("WHO");
        expect(() => service.renamePass(players.id, "Mine now", BOB)).toThrow(NotFoundError);
    });
});

describe("deleting a pass", () => {
    it("takes its marks with it and says how many", () => {
        const players = service.createPass("Players", ANNA);
        const wins = service.createPass("Wins", ANNA);
        service.markItems(["g1", "g2"], players.id, true, ANNA);
        service.markItems(["g1"], wins.id, true, ANNA);

        expect(service.deletePass(players.id, ANNA)).toEqual({ marks: 2 });
        expect(marks).toEqual([{ passId: wins.id, mediaId: "g1" }]);
        expect(service.listPasses(ANNA, "here").map((pass) => pass.name)).toEqual(["Wins"]);
    });

    it("is not found for anybody but the owner", () => {
        const players = service.createPass("Players", ANNA);

        expect(() => service.deletePass(players.id, BOB)).toThrow(NotFoundError);
        expect(passes).toHaveLength(1);
    });
});

describe("marks", () => {
    it("mark and clear an item, and answer with its passes", () => {
        const players = service.createPass("Players", ANNA);

        expect(
            service.setItemMark("g1", { passId: players.id, reviewed: true }, ANNA)
        ).toMatchObject([{ passId: players.id, name: "Players" }]);
        expect(cleared).toBe(1);
        expect(service.setItemMark("g1", { passId: players.id, reviewed: false }, ANNA)).toEqual(
            []
        );
    });

    it("treat another person's pass as not found", () => {
        const theirs = service.createPass("Players", BOB);

        expect(() =>
            service.setItemMark("g1", { passId: theirs.id, reviewed: true }, ANNA)
        ).toThrow(NotFoundError);
        expect(() => service.markItems(["g1"], theirs.id, true, ANNA)).toThrow(NotFoundError);
        expect(marks).toEqual([]);
    });

    it("refuse a pass of another room, for one item or a selection", () => {
        const cellar = service.createPass("Reviewed", as("anna", "cellar"));

        expect(() =>
            service.setItemMark("g1", { passId: cellar.id, reviewed: true }, ANNA)
        ).toThrow(ValidationError);
        expect(() => service.markItems(["c1", "g1"], cellar.id, true, ANNA)).toThrow(
            ValidationError
        );
        expect(marks).toEqual([]);
        // An item with no room left to say is let through, as a tag lets it.
        expect(service.markItems(["c1", "orphan"], cellar.id, true, ANNA)).toBe(2);
    });

    it("report an item outside the caller's libraries as missing", () => {
        const players = service.createPass("Players", ANNA);
        visible.delete("g2");

        expect(() =>
            service.setItemMark("g2", { passId: players.id, reviewed: true }, ANNA)
        ).toThrow(NotFoundError);
    });

    it("leave the caches alone when nothing changed", () => {
        const players = service.createPass("Players", ANNA);
        service.markItems(["g1"], players.id, true, ANNA);
        cleared = 0;

        expect(service.markItems(["g1"], players.id, true, ANNA)).toBe(0);
        expect(cleared).toBe(0);
    });
});
