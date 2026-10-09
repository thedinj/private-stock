import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaQuery, SavedQuery } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * A saved view's face (§14c).
 *
 * The claims: it runs the view's own query with the view's own overlay, small and from the
 * start; a shuffled view gets a stable face; the walk is remembered but the hydration is not,
 * so something trashed since drops out at once; and a view that cannot be shown has no face
 * rather than an error.
 */

let found: { query: SavedQuery | null; overlayUserId?: string } | null = null;
/** Every walk the face asked for, with the overlay it asked with. */
let walks: { query: MediaQuery; overlayUserId?: string }[] = [];
/** The ids the walk returns. */
let walkIds: string[] = [];
/** Items `listByIds` will return, and whether each has artwork. */
let visible: Record<string, boolean> = {};

vi.mock("@private-stock/db", () => ({
    mediaRepo: {
        listByIds: (ids: string[]) =>
            ids
                .filter((id) => id in visible)
                .map((id) => ({
                    id,
                    coverPath: visible[id] ? `${id}.jpg` : null,
                    coverGeneratedAt: null,
                })),
    },
}));

vi.mock("./artService", () => ({
    coverUrl: (id: string, coverPath: string | null) => (coverPath ? `/art/${id}` : null),
}));

vi.mock("./mediaService", () => ({
    listMediaIdsPage: (query: MediaQuery, _auth: AuthContext, overlayUserId?: string) => {
        walks.push({ query, overlayUserId });

        return { ids: walkIds, page: 0, pageSize: query.limit, hasMore: false };
    },
}));

vi.mock("./savedFilterService", () => ({
    findSavedQuery: () => (found ? { row: {}, ...found } : null),
}));

const { savedFilterCovers } = await import("./viewCoverService");

const AUTH = { userId: "me", accessibleRootIds: ["root"] } as unknown as AuthContext;

/** A query no other test uses, so the module's cache cannot answer across tests. */
let queryCounter = 0;
const freshQuery = (patch: Partial<SavedQuery> = {}): SavedQuery =>
    ({ search: `q${++queryCounter}`, sort: "addedAt", direction: "desc", ...patch }) as SavedQuery;

beforeEach(() => {
    found = null;
    walks = [];
    walkIds = [];
    visible = {};
});

describe("savedFilterCovers", () => {
    it("keeps a strip's worth the viewer may see that have artwork, in order", () => {
        found = { query: freshQuery() };
        const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
        walkIds = ["hidden", "noart", ...ids];
        visible = { noart: false, ...Object.fromEntries(ids.map((id) => [id, true])) };

        expect(savedFilterCovers("v", AUTH)).toEqual(ids.slice(0, 8).map((id) => `/art/${id}`));
    });

    it("runs the view's own query from the start, two dozen ids, with its overlay", () => {
        found = { query: freshQuery({ minRating: 4 }), overlayUserId: "owner" };

        savedFilterCovers("v", AUTH);

        expect(walks).toHaveLength(1);
        expect(walks[0].query).toMatchObject({ minRating: 4, page: 0, limit: 24 });
        expect(walks[0].overlayUserId).toBe("owner");
    });

    it("gives a shuffled view its newest items, so the face holds still", () => {
        found = { query: freshQuery({ sort: "random", seed: 7 }) };

        savedFilterCovers("v", AUTH);

        expect(walks[0].query).toMatchObject({ sort: "addedAt", direction: "desc" });
        expect(walks[0].query.seed).toBeUndefined();
    });

    it("remembers the walk but hydrates every time, so a trashed item drops out at once", () => {
        found = { query: freshQuery() };
        walkIds = ["a", "b"];
        visible = { a: true, b: true };

        expect(savedFilterCovers("v", AUTH)).toEqual(["/art/a", "/art/b"]);

        delete visible.a;

        expect(savedFilterCovers("v", AUTH)).toEqual(["/art/b"]);
        expect(walks).toHaveLength(1);
    });

    it("has no face for a view this viewer cannot see, or one that cannot be read", () => {
        expect(savedFilterCovers("gone", AUTH)).toEqual([]);

        found = { query: null };

        expect(savedFilterCovers("broken", AUTH)).toEqual([]);
        expect(walks).toHaveLength(0);
    });
});
