import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../auth/withAuth";

/**
 * What every face surface shares (§5f): how a face is cropped out of the picture it was found in,
 * the confirmed faces a performer's picture is chosen from, and "no single face".
 */

const state = vi.hoisted(() => ({
    confirmed: [] as Record<string, unknown>[],
    noFace: new Set<string>(),
}));

vi.mock("@private-stock/db", () => ({
    tagRepo: {
        findById: (id: string) =>
            id === "jane" ? { id, kind: "performer", name: "Jane", ownerId: null } : undefined,
    },
    faceRepo: {
        everyConfirmedFace: (_tagId: string, _roots: string[], limit: number, offset: number) => ({
            faces: state.confirmed.slice(offset, offset + limit),
            total: state.confirmed.length,
        }),
        setNoSingleFace: (tagId: string, noFace: boolean) => {
            if (noFace) state.noFace.add(tagId);
            else state.noFace.delete(tagId);
        },
    },
    jobRepo: { enqueueKind: () => undefined },
    artifactRepo: {
        findOne: () => ({
            width: 640,
            height: 360,
            relPath: "art/aa/x/cover.webp",
            generatedAt: null,
        }),
    },
}));

vi.mock("./spriteThumb", () => ({
    spriteThumbFor: () => ({
        url: "/api/art/x/sprite-0",
        rect: { x: 200, y: 112, width: 200, height: 112, sheetWidth: 2000, sheetHeight: 1120 },
    }),
}));

const { confirmedFacesPage, faceCrop, setNoSingleFace } = await import("./faceService");

const admin: AuthContext = {
    userId: "u1",
    email: "u1@example.test",
    displayName: "U",
    scopes: ["admin"],
    accessibleRootIds: ["r1"],
    tokenEpoch: 0,
};

const shown = (mediaId: string) => ({
    id: `${mediaId}-f`,
    mediaId,
    kind: "video" as const,
    atMs: 2000,
    x: 0.25,
    y: 0.25,
    w: 0.25,
    h: 0.5,
});

beforeEach(() => {
    state.confirmed = [];
    state.noFace = new Set();
});

describe("choosing their picture", () => {
    it("pages every confirmed face", () => {
        state.confirmed = ["a", "b", "c"].map(shown);

        const first = confirmedFacesPage("jane", { page: 0, limit: 2 }, admin);

        expect(first.faces.map((face) => face.mediaId)).toEqual(["a", "b"]);
        expect(first).toMatchObject({ hasMore: true, total: 3 });
        expect(confirmedFacesPage("jane", { page: 1, limit: 2 }, admin).hasMore).toBe(false);
        expect(() =>
            confirmedFacesPage("jane", { page: 0, limit: 2 }, { ...admin, scopes: [] })
        ).toThrow(/administrator/);
        expect(() => confirmedFacesPage("nobody", { page: 0, limit: 2 }, admin)).toThrow(
            /not found/i
        );
    });
});

describe("cropping a face", () => {
    it("takes a square around it, inside its sprite tile", () => {
        const crop = faceCrop(shown("m1"));

        // The face is 50 × 56 px in a 200 × 112 tile; a square 1.6 times its larger side would be
        // 89.6 px, centred on (275, 168) and kept inside the tile.
        expect(crop?.rect.width).toBeCloseTo(89.6);
        expect(crop?.rect.x).toBeCloseTo(275 - 44.8);
        expect(crop?.rect.y).toBeCloseTo(168 - 44.8);
        expect(crop?.rect.sheetWidth).toBe(2000);
    });

    it("crops a photograph from its cover", () => {
        const crop = faceCrop({ ...shown("m1"), kind: "image" });

        expect(crop?.url).toMatch(/\/cover\?v=/);
        expect(crop?.rect.sheetWidth).toBe(640);
    });
});

describe("no single face", () => {
    it("is said and undone by administrators", () => {
        setNoSingleFace("jane", { noSingleFace: true }, admin);

        expect(state.noFace.has("jane")).toBe(true);

        setNoSingleFace("jane", { noSingleFace: false }, admin);

        expect(state.noFace.has("jane")).toBe(false);
        expect(() =>
            setNoSingleFace("jane", { noSingleFace: true }, { ...admin, scopes: [] })
        ).toThrow(/administrator/);
    });
});
