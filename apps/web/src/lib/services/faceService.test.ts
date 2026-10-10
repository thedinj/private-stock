import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../auth/withAuth";

/**
 * A performer's faces, "Likely", and Review › Faces (§5f): who may ask, how a face is cropped out
 * of the picture it was found in, how evidence is gathered and ordered, and what each decision
 * writes.
 */

interface Size {
    groupId: string;
    faceCount: number;
    itemCount: number;
    openItems: number;
    skippedItems: number;
    leftItems: number;
    cohesion: number | null;
    openVideos: number;
    openPhotos: number;
    leftVideos: number;
    leftPhotos: number;
}

const state = vi.hoisted(() => ({
    groups: [] as Record<string, unknown>[],
    inGroups: [] as Record<string, unknown>[],
    mentions: [] as { mediaId: string; field: string }[],
    assigned: [] as { mediaId: string; tagId: string }[],
    pairs: [] as Record<string, unknown>[],
    sizes: [] as Size[],
    likenesses: [] as { groupId: string; tagId: string; items: number }[],
    lookingLike: [] as Record<string, unknown>[],
    anchors: new Map<string, { tagId: string; centre: Float32Array }>(),
    refusals: [] as { groupId: string; tagId: string }[],
    decided: [] as [string, string, string][],
    tagged: [] as Record<string, unknown>[],
    refusedOn: [] as [string, string, string[]][],
    confirmedOn: [] as [string, string, string[]][],
    mentionRefused: [] as [string, string[]][],
    skippedOn: [] as [string, string[]][],
    tags: { jane: "Jane", kim: "Kim" } as Record<string, string>,
    scattered: [] as string[],
    noFace: new Set<string>(),
    /** "Pick their face": face id → [mediaId, confirmed as them]. */
    own: {} as Record<string, [string, boolean]>,
    suspectFaces: [] as Record<string, unknown>[],
    namedOn: [] as { tagId: string; field: string }[],
    notThem: [] as unknown[][],
    /** Face id → [mediaId, group, direction]: a face's vector, as a unit vector in two dims. */
    vectors: {} as Record<string, [string, string, number[]]>,
}));

vi.mock("@private-stock/db", () => ({
    // A press runs its writes, as one decision (§5f "Decisions you can take back").
    faceDecisionRepo: {
        record: (_decision: unknown, write: () => unknown) => ({
            decisionId: "d1",
            result: write(),
        }),
        nameActive: () => undefined,
    },
    db: { transaction: <T>(fn: () => T) => fn },
    tagRepo: {
        findById: (id: string) =>
            state.tags[id]
                ? { id, kind: "performer", name: state.tags[id], ownerId: null }
                : undefined,
        resolveName: (_kind: string, name: string) =>
            Object.values(state.tags).includes(name) ? { via: "name" } : undefined,
        ensureTag: (_kind: string, name: string) => {
            const found = Object.entries(state.tags).find(([, known]) => known === name);

            if (found) return found[0];

            state.tags[name.toLowerCase()] = name;

            return name.toLowerCase();
        },
    },
    faceRepo: {
        groupsForPerformer: () => state.groups,
        sampleFaces: () => state.tagged,
        untaggedInGroups: (groupIds: string[]) =>
            state.inGroups.filter((face) => groupIds.includes(face.groupId as string)),
        decideGroup: (groupId: string, tagId: string, verdict: string) => {
            state.decided.push([groupId, tagId, verdict]);
            return 1;
        },
        // Every group concerns everybody here: the narrowing is the repo's, tested there.
        performerGroupIds: () => [],
        likenessGroupIds: () => [],
        untaggedCounts: (pairs: { groupId: string; tagId: string }[]) =>
            pairs.map(({ groupId, tagId }) => {
                const faces = state.inGroups.filter((face) => face.groupId === groupId);

                return {
                    groupId,
                    tagId,
                    items: faces.length,
                    videos: faces.filter((face) => face.kind === "video").length,
                    photos: faces.filter((face) => face.kind === "image").length,
                };
            }),
        groupEvidence: () => state.pairs,
        groupSizes: () => state.sizes,
        groupLikenesses: () => state.likenesses,
        untaggedLookingLike: () => state.lookingLike,
        faceFromTags: () => [],
        groupRefusals: () => state.refusals,
        refuseOnItem: (mediaId: string, tagId: string, groupIds: string[]) => {
            state.refusedOn.push([mediaId, tagId, groupIds]);
            return 1;
        },
        withdrawRefusals: () => 0,
        confirmOnItems: (groupId: string, tagId: string, mediaIds: string[]) => {
            state.confirmedOn.push([groupId, tagId, mediaIds]);
            return mediaIds.length;
        },
        suspectFaces: () => state.suspectFaces,
        noSingleFace: (tagId: string) =>
            state.noFace.has(tagId) ? { decidedAt: "2026-10-09 10:00:00" } : undefined,
        setNoSingleFace: (tagId: string, noFace: boolean) => {
            if (noFace) state.noFace.add(tagId);
            else state.noFace.delete(tagId);
        },
        confirmFace: (faceId: string) => {
            if (state.own[faceId]) state.own[faceId][1] = true;
            return 1;
        },
        ownFaceItems: (_tagId: string, _roots: string[], limit: number, offset: number) => {
            const items = [...new Set(Object.values(state.own).map(([mediaId]) => mediaId))];

            return { mediaIds: items.slice(offset, offset + limit), total: items.length };
        },
        ownFaces: (_tagId: string, mediaIds: string[]) =>
            Object.entries(state.own)
                .filter(([, [mediaId]]) => mediaIds.includes(mediaId))
                .map(([id, [mediaId, theirs]]) => ({
                    ...shown(mediaId, "g1"),
                    id,
                    theirs: +theirs,
                })),
        ownFaceMedia: (faceId: string) => state.own[faceId]?.[0],
        unconfirmFace: (faceId: string) => {
            if (!state.own[faceId]?.[1]) return 0;
            state.own[faceId][1] = false;
            return 1;
        },
        scatterGroup: (groupId: string) => {
            state.scattered.push(groupId);
            return 3;
        },
        skipFaces: (groupId: string, mediaIds: string[]) => {
            state.skippedOn.push([groupId, mediaIds]);
            return mediaIds.length;
        },
        taggedInGroup: () => state.tagged,
        vectorRefs: (ids: string[]) =>
            ids
                .filter((id) => state.vectors[id])
                .map((id) => ({
                    id,
                    mediaId: state.vectors[id][0],
                    vectorIndex: 0,
                    groupId: state.vectors[id][1],
                })),
        itemFacesInGroup: () => state.tagged,
        confirmedFaces: () => state.tagged,
        confirmedItemCount: () => state.tagged.length,
        everyConfirmedFace: (_tagId: string, _roots: string[], limit: number, offset: number) => ({
            faces: state.tagged.slice(offset, offset + limit),
            total: state.tagged.length,
        }),
    },
    jobRepo: { enqueueKind: () => undefined },
    tagPictureRepo: { effectiveFor: () => new Map() },
    mentionRepo: {
        untaggedMentions: () => state.mentions,
        untaggedPerformersNamedOn: () => state.namedOn,
        refuse: (tagId: string, mediaIds: string[]) => {
            state.mentionRefused.push([tagId, mediaIds]);
            return mediaIds.length;
        },
        refuseItems: (tagId: string, mediaIds: string[]) => {
            state.mentionRefused.push([tagId, mediaIds]);
            return mediaIds.length;
        },
    },
    artifactRepo: {
        findOne: () => ({
            width: 640,
            height: 360,
            relPath: "art/aa/x/cover.webp",
            generatedAt: null,
        }),
    },
    searchRepo: { requestReindex: vi.fn() },
    tagBatchRepo: {
        applyAssignments: (input: { assignments: { mediaId: string; tagId: string }[] }) => {
            state.assigned.push(...input.assignments);
            return { batchId: "b1", assigned: input.assignments.length };
        },
    },
}));

vi.mock("./mediaService", () => ({
    lookupMedia: (ids: string[]) => ({
        items: ids.filter((id) => id !== "hidden").map((id) => ({ id, title: id })),
    }),
}));

vi.mock("./notThem", () => ({ notThem: (...args: unknown[]) => state.notThem.push(args) }));

vi.mock("./faceAnchors", () => ({ faceAnchors: () => state.anchors }));

vi.mock("./faceVectors", () => ({
    faceVectorReader: () => (mediaId: string) => {
        const found = Object.values(state.vectors).find(([item]) => item === mediaId);

        return found ? Float32Array.from(found[2]) : null;
    },
}));

vi.mock("./spriteThumb", () => ({
    spriteThumbFor: () => ({
        url: "/api/art/x/sprite-0",
        rect: { x: 200, y: 112, width: 200, height: 112, sheetWidth: 2000, sheetHeight: 1120 },
    }),
}));

const {
    setNoSingleFace,
    decideItemSuspect,
    itemSuspects,
    faceLikeness,
    facePeek,
    confirmedFacesPage,
    decideFaceReview,
    decideLikely,
    faceCrop,
    likely,
    reviewFaces,
} = await import("./faceService");

const admin: AuthContext = {
    userId: "u1",
    email: "u1@example.test",
    displayName: "U",
    scopes: ["admin"],
    accessibleRootIds: ["r1"],
    tokenEpoch: 0,
};

const evidence = (groupId: string, extra: Record<string, number> = {}) => ({
    groupId,
    faceCount: 4,
    itemCount: 4,
    untaggedCount: 2,
    taggedAsThem: 0,
    taggedAsOthers: 0,
    confirmed: 0,
    confirmedOthers: 0,
    refused: 0,
    ...extra,
});

/**
 * A pair as `groupEvidence` gives it: a performer, and a group that might be them. Its untagged
 * items are videos unless the extras say otherwise.
 */
const pair = (tagId: string, groupId: string, extra: Record<string, number> = {}) => {
    const counts = evidence(groupId, extra);

    return {
        tagId,
        untaggedVideos: counts.untaggedCount,
        untaggedPhotos: 0,
        ...counts,
    };
};

/** A group as `groupSizes` gives it, its items videos unless the extras say otherwise. */
const size = (groupId: string, itemCount: number, extra: Partial<Size> = {}): Size => {
    const counts = {
        openItems: itemCount,
        leftItems: 0,
        ...extra,
    };

    return {
        groupId,
        faceCount: itemCount,
        itemCount,
        skippedItems: 0,
        cohesion: null,
        openVideos: counts.openItems,
        openPhotos: 0,
        leftVideos: counts.leftItems,
        leftPhotos: 0,
        ...counts,
    };
};

const shown = (mediaId: string, groupId: string) => ({
    id: `${mediaId}-f`,
    mediaId,
    kind: "video" as const,
    atMs: 2000,
    x: 0.25,
    y: 0.25,
    w: 0.25,
    h: 0.5,
    groupId,
});

const page = { page: 0, limit: 10 };

beforeEach(() => {
    state.own = {};
    state.groups = [];
    state.inGroups = [];
    state.mentions = [];
    state.assigned = [];
    state.pairs = [];
    state.sizes = [];
    state.likenesses = [];
    state.lookingLike = [];
    state.anchors = new Map();
    state.refusals = [];
    state.decided = [];
    state.tagged = [];
    state.refusedOn = [];
    state.confirmedOn = [];
    state.mentionRefused = [];
    state.skippedOn = [];
    state.tags = { jane: "Jane", kim: "Kim" };
    state.vectors = {};
    state.scattered = [];
    state.noFace = new Set();
    state.suspectFaces = [];
    state.namedOn = [];
    state.notThem = [];
});

describe("who may ask", () => {
    it("refuses anybody but an administrator, and anything but a library performer", () => {
        expect(() => likely("jane", page, { ...admin, scopes: [] })).toThrow(/administrator/);
        expect(() => likely("someone-else", page, admin)).toThrow(/not found/i);
    });
});

describe("checking faces quickly", () => {
    const at = (degrees: number): number[] => [
        Math.cos((degrees * Math.PI) / 180),
        Math.sin((degrees * Math.PI) / 180),
    ];

    it("scores a row's faces against the performer's reference", () => {
        state.anchors = new Map([["jane", { tagId: "jane", centre: Float32Array.from(at(5)) }]]);
        state.vectors = {
            near: ["n", "g1", at(5)],
            far: ["f", "g1", at(80)],
            elsewhere: ["e", "g9", at(5)],
        };

        const result = faceLikeness(
            { groupId: "g1", tagId: "jane", ids: ["near", "far", "elsewhere"] },
            admin
        );

        expect(result.anchored).toBe(true);
        expect(result.scores.near).toBeGreaterThan(0.99);
        expect(result.scores.far).toBeLessThan(result.doubt);
        // A face of another group is not this row's to score.
        expect(result.scores.elsewhere).toBeUndefined();
    });

    it("scores against the row's own faces where nobody is confirmed", () => {
        state.vectors = {
            a: ["a", "g1", at(0)],
            b: ["b", "g1", at(4)],
            c: ["c", "g1", at(8)],
            stranger: ["s", "g1", at(90)],
        };

        const result = faceLikeness({ groupId: "g1", ids: ["a", "b", "c", "stranger"] }, admin);

        expect(result.anchored).toBe(false);
        expect(result.scores.stranger).toBeLessThan(result.doubt);
        expect(result.scores.b).toBeGreaterThan(0.99);
    });

    it("shows the same item's other faces in the group, to administrators", () => {
        state.tagged = [shown("m1", "g1"), shown("m1", "g1")];

        expect(facePeek({ groupId: "g1", mediaId: "m1" }, admin).faces).toHaveLength(2);
        expect(() => facePeek({ groupId: "g1", mediaId: "m1" }, { ...admin, scopes: [] })).toThrow(
            /administrator/
        );
    });
});

describe("choosing their picture", () => {
    it("pages every confirmed face", () => {
        state.tagged = ["a", "b", "c"].map((id) => shown(id, "g1"));

        const first = confirmedFacesPage("jane", { page: 0, limit: 2 }, admin);

        expect(first.faces.map((face) => face.mediaId)).toEqual(["a", "b"]);
        expect(first).toMatchObject({ hasMore: true, total: 3 });
        expect(confirmedFacesPage("jane", { page: 1, limit: 2 }, admin).hasMore).toBe(false);
        expect(() =>
            confirmedFacesPage("jane", { page: 0, limit: 2 }, { ...admin, scopes: [] })
        ).toThrow(/administrator/);
    });
});

describe("cropping a face", () => {
    it("takes a square around it, inside its sprite tile", () => {
        const crop = faceCrop(shown("m1", "g1"));

        // The face is 50 × 56 px in a 200 × 112 tile; a square 1.6 times its larger side would be
        // 89.6 px, centred on (275, 168) and kept inside the tile.
        expect(crop?.rect.width).toBeCloseTo(89.6);
        expect(crop?.rect.x).toBeCloseTo(275 - 44.8);
        expect(crop?.rect.y).toBeCloseTo(168 - 44.8);
        expect(crop?.rect.sheetWidth).toBe(2000);
    });

    it("crops a photograph from its cover", () => {
        const crop = faceCrop({ ...shown("m1", "g1"), kind: "image" });

        expect(crop?.url).toMatch(/\/cover\?v=/);
        expect(crop?.rect.sheetWidth).toBe(640);
    });
});

describe("Likely", () => {
    beforeEach(() => {
        state.pairs = [
            pair("jane", "confirmed-group", { confirmed: 3 }),
            pair("jane", "proposed-group", { taggedAsThem: 3 }),
        ];
    });

    it("lists only where a face and the name agree, and counts the rest", () => {
        state.inGroups = [
            shown("both-proposed", "proposed-group"),
            shown("both-confirmed", "confirmed-group"),
            shown("face-only", "confirmed-group"),
        ];
        state.mentions = [
            { mediaId: "both-proposed", field: "title" },
            { mediaId: "both-confirmed", field: "filename" },
            { mediaId: "name-only", field: "filename" },
            { mediaId: "name-only-too", field: "screen" },
        ];

        const result = likely("jane", page, admin);

        expect(result.items.map((entry) => [entry.item.id, entry.face])).toEqual([
            ["both-confirmed", "confirmed"],
            ["both-proposed", "proposed"],
        ]);
        expect(result.items[0].crop).not.toBeNull();
        expect(result).toMatchObject({ total: 2, nameOnly: 2 });
    });

    it("pages, and leaves out what the viewer cannot see", () => {
        state.inGroups = ["a1", "a2", "hidden"].map((id) => shown(id, "proposed-group"));
        state.mentions = ["a1", "a2", "hidden"].map((mediaId) => ({ mediaId, field: "filename" }));

        const first = likely("jane", { page: 0, limit: 2 }, admin);

        expect(first.items.map((entry) => entry.item.id)).toEqual(["a1", "a2"]);
        expect(first.hasMore).toBe(true);
        expect(likely("jane", { page: 1, limit: 2 }, admin).items).toEqual([]);
    });

    it("tags only items the viewer can see, as one batch", () => {
        const result = decideLikely("jane", { verdict: "add", mediaIds: ["a1", "hidden"] }, admin);

        expect(result.changed).toBe(1);
        expect(state.assigned).toEqual([{ mediaId: "a1", tagId: "jane" }]);
    });

    it("tags every item the list holds, not what happens to be loaded", () => {
        state.inGroups = ["a1", "a2", "a3"].map((id) => shown(id, "proposed-group"));
        state.mentions = ["a1", "a2", "a3"].map((mediaId) => ({ mediaId, field: "filename" }));

        expect(decideLikely("jane", { verdict: "addAll" }, admin).changed).toBe(3);
    });

    it("refuses both the face and the name when an item is not them", () => {
        decideLikely("jane", { verdict: "refuse", mediaId: "a1" }, admin);

        expect(state.refusedOn).toEqual([["a1", "jane", ["confirmed-group", "proposed-group"]]]);
        expect(state.mentionRefused).toEqual([["jane", ["a1"]]]);
    });
});

describe("Review › Faces", () => {
    it("matches the groups that would tag the most items first, and only those with any", () => {
        state.pairs = [
            pair("jane", "few", { taggedAsThem: 2, untaggedCount: 1 }),
            pair("kim", "many", { taggedAsThem: 3, untaggedCount: 9 }),
            pair("jane", "done", { taggedAsThem: 4, untaggedCount: 0 }),
            pair("kim", "weak", { taggedAsThem: 1, untaggedCount: 5 }),
        ];

        const result = reviewFaces({ tab: "matches", ...page }, admin);

        expect(result.rows.map((row) => [row.groupId, row.candidate?.name])).toEqual([
            ["many", "Kim"],
            ["few", "Jane"],
        ]);
        expect(result.rows[0].candidate?.state).toBe("proposed");
        expect(result.total).toBe(2);
    });

    it("pages the visit's list in the order it was made, leaving out rows settled since", () => {
        state.pairs = [
            pair("kim", "many", { taggedAsThem: 3, untaggedCount: 9 }),
            pair("jane", "few", { taggedAsThem: 2, untaggedCount: 2 }),
            pair("jane", "fewer", { taggedAsThem: 2, untaggedCount: 1 }),
        ];
        state.inGroups = [shown("m1", "many"), shown("f1", "few"), shown("r1", "fewer")];

        const first = reviewFaces({ tab: "matches", page: 0, limit: 1 }, admin);

        expect(first.rows.map((row) => row.groupId)).toEqual(["many"]);
        expect(first.total).toBe(3);

        // Since then: "few" was settled, and the counts would order the rest differently.
        state.inGroups = state.inGroups.filter((face) => face.groupId !== "few");
        state.pairs = [
            pair("jane", "fewer", { taggedAsThem: 2, untaggedCount: 50 }),
            pair("kim", "many", { taggedAsThem: 3, untaggedCount: 9 }),
        ];

        const kept = { tab: "matches" as const, limit: 1, list: first.list };

        expect(reviewFaces({ ...kept, page: 1 }, admin).rows).toEqual([]);
        expect(reviewFaces({ ...kept, page: 2 }, admin).rows.map((row) => row.groupId)).toEqual([
            "fewer",
        ]);
        // Another person's list, or another tab's, is never theirs to page.
        expect(reviewFaces({ ...kept, page: 0 }, { ...admin, userId: "u2" }).list).not.toBe(
            first.list
        );
        expect(
            reviewFaces({ tab: "unnamed", page: 0, limit: 1, list: first.list }, admin).list
        ).not.toBe(first.list);
    });

    it("asks about the untagged items' faces, and shows the tagged ones apart", () => {
        state.pairs = [pair("jane", "g1", { taggedAsThem: 2 })];
        state.inGroups = Array.from({ length: 30 }, (_, i) => shown(`u${i}`, "g1"));
        state.tagged = [shown("t1", "g1"), shown("t2", "g1")];

        const [row] = reviewFaces({ tab: "matches", ...page }, admin).rows;

        expect(row.faces.map((face) => face.mediaId)).toEqual(
            Array.from({ length: 24 }, (_, i) => `u${i}`)
        );
        expect(row.more).toBe(6);
        expect(row.candidate?.untagged).toBe(30);
        expect(row.reference.map((face) => face.mediaId)).toEqual(["t1", "t2"]);
    });

    it("proposes a group like one confirmed as somebody, unless refused for them", () => {
        state.pairs = [pair("jane", "hers", { confirmed: 5, untaggedCount: 0 })];
        state.sizes = [size("hers", 5), size("like-hers", 3), size("refused", 3), size("far", 3)];
        // How many of each group's items have a face whose best match is her; "far" has one.
        state.likenesses = [
            { groupId: "like-hers", tagId: "jane", items: 3 },
            { groupId: "refused", tagId: "jane", items: 3 },
            { groupId: "far", tagId: "jane", items: 1 },
        ];
        state.refusals = [{ groupId: "refused", tagId: "jane" }];
        state.inGroups = [shown("x1", "like-hers"), shown("x2", "far")];

        const matches = reviewFaces({ tab: "matches", ...page }, admin);
        const resembling = matches.rows.find((row) => row.groupId === "like-hers");

        expect(resembling?.candidate).toMatchObject({ name: "Jane", state: "resembles" });
        expect(matches.rows.some((row) => row.groupId === "refused")).toBe(false);
        // Not asked twice: a group like hers is a match, not a stranger.
        expect(
            reviewFaces({ tab: "unnamed", ...page }, admin)
                .rows.map((row) => row.groupId)
                .sort()
        ).toEqual(["far", "refused"]);
        // And from her own Organise page, asked of her groups alone.
        expect(
            reviewFaces({ tab: "matches", performer: "jane", ...page }, admin).rows.map(
                (row) => row.groupId
            )
        ).toEqual(["like-hers"]);
    });

    it("does not propose a group like theirs whose items are already tagged with them", () => {
        state.pairs = [pair("jane", "hers", { confirmed: 5, untaggedCount: 0 })];
        state.sizes = [size("hers", 5), size("done", 2)];
        state.likenesses = [{ groupId: "done", tagId: "jane", items: 2 }];

        expect(reviewFaces({ tab: "matches", ...page }, admin).rows).toEqual([]);
        // Hers already, by its tags and its likeness: not a stranger to Unnamed either.
        expect(reviewFaces({ tab: "unnamed", ...page }, admin).rows).toEqual([]);
    });

    it("narrows Matches to one performer, and says whom", () => {
        state.pairs = [
            pair("jane", "hers", { taggedAsThem: 2 }),
            pair("kim", "his", { taggedAsThem: 2 }),
        ];

        const result = reviewFaces({ tab: "matches", ...page, performer: "kim" }, admin);

        expect(result.rows.map((row) => row.groupId)).toEqual(["his"]);
        expect(result.performer).toEqual({ id: "kim", name: "Kim" });
        expect(reviewFaces({ tab: "matches", ...page }, admin).performer).toBeNull();
    });

    it("lists as unnamed the groups nobody is proposed for, largest first", () => {
        state.pairs = [pair("jane", "hers", { taggedAsThem: 2 })];
        state.sizes = [size("hers", 9), size("small", 2), size("large", 6), size("single", 1)];

        const result = reviewFaces({ tab: "unnamed", ...page }, admin);

        expect(result.rows.map((row) => row.groupId)).toEqual(["large", "small"]);
        expect(result.rows[0]).toMatchObject({ candidate: null, reference: [] });
    });

    /** The review opens on videos; photos wait behind its kind control, still counted (§5f). */
    it("asks about faces on one kind at a time, and counts the other", () => {
        state.pairs = [
            pair("jane", "film", { taggedAsThem: 2, untaggedCount: 1 }),
            {
                ...pair("kim", "stills", { taggedAsThem: 2, untaggedCount: 1 }),
                untaggedVideos: 0,
                untaggedPhotos: 1,
            },
        ];
        state.inGroups = [shown("v1", "film"), { ...shown("p1", "stills"), kind: "image" }];

        const videos = reviewFaces({ tab: "matches", ...page, media: "video" }, admin);

        expect(videos.rows.map((row) => row.groupId)).toEqual(["film"]);
        expect(videos.byMedia).toEqual({ video: 1, image: 1 });

        const photos = reviewFaces({ tab: "matches", ...page, media: "image" }, admin);

        expect(photos.rows.map((row) => row.groupId)).toEqual(["stills"]);
        expect(photos.rows[0].faces.map((face) => face.mediaId)).toEqual(["p1"]);
        expect(reviewFaces({ tab: "matches", ...page }, admin).rows).toHaveLength(2);

        state.sizes = [size("open", 4, { openVideos: 1, openPhotos: 3 })];

        expect(reviewFaces({ tab: "unnamed", ...page, media: "video" }, admin).rows).toEqual([]);
        expect(
            reviewFaces({ tab: "unnamed", ...page, media: "image" }, admin).rows[0]
        ).toMatchObject({ groupId: "open", itemCount: 3 });
    });

    it("leaves a skipped group out until new faces join it, and asks about a mixed group's rest", () => {
        state.pairs = [pair("jane", "mixed", { confirmed: 3 })];
        state.sizes = [
            size("skipped", 8, { openItems: 2, skippedItems: 6 }),
            size("grown", 8, { openItems: 3, skippedItems: 5 }),
            size("mixed", 6, { leftItems: 2 }),
        ];

        const rows = reviewFaces({ tab: "unnamed", ...page }, admin).rows;

        expect(rows.map((row) => [row.groupId, row.itemCount])).toEqual([
            ["grown", 3],
            ["mixed", 2],
        ]);
    });

    it("asks about only the undecided faces of a group named in part", () => {
        // Three named as somebody, five unticked: not theirs by count, so still unnamed — but
        // only the five are asked about, never the three again.
        state.sizes = [size("part", 8, { openItems: 5 }), size("done", 4, { openItems: 1 })];

        const rows = reviewFaces({ tab: "unnamed", ...page }, admin).rows;

        expect(rows.map((row) => [row.groupId, row.itemCount])).toEqual([["part", 5]]);
    });

    it("marks a loose group and asks about it last", () => {
        state.sizes = [
            size("bag", 50, { cohesion: 0.49 }),
            size("person", 6, { cohesion: 0.62 }),
            size("new", 4),
        ];

        const rows = reviewFaces({ tab: "unnamed", ...page }, admin).rows;

        expect(rows.map((row) => [row.groupId, row.loose])).toEqual([
            ["person", false],
            ["new", false],
            ["bag", true],
        ]);
    });

    it("takes a grab bag out of grouping", () => {
        decideFaceReview({ verdict: "scatter", groupId: "bag" }, admin);

        expect(state.scattered).toEqual(["bag"]);
    });

    it("tags exactly the ticked items and refuses the unticked ones", () => {
        state.inGroups = [shown("a1", "g1"), shown("a2", "g1"), shown("a3", "g1")];

        const result = decideFaceReview(
            {
                verdict: "accept",
                groupId: "g1",
                tagId: "jane",
                // a2 twice, and "gone" no longer in the group: neither tags anything extra.
                mediaIds: ["a1", "a2", "a2", "gone"],
                excludedMediaIds: ["a3"],
                unsureMediaIds: [],
                shownFaceIds: ["a1-f", "a2-f", "a3-f"],
            },
            admin
        );

        expect(state.refusedOn).toEqual([["a3", "jane", ["g1"]]]);
        expect(state.confirmedOn).toEqual([["g1", "jane", ["a1", "a2"]]]);
        expect(state.assigned.map((row) => row.mediaId)).toEqual(["a1", "a2"]);
        expect(result).toEqual({ name: "Jane", tagged: 2, coined: false });
    });

    it("leaves the faces marked unsure undecided, to be asked about again", () => {
        state.inGroups = [shown("a1", "g1"), shown("a2", "g1"), shown("a3", "g1")];

        const result = decideFaceReview(
            {
                verdict: "accept",
                groupId: "g1",
                tagId: "jane",
                mediaIds: ["a1", "a2"],
                // Marked unsure: excluded from both lists, whatever a client sent.
                excludedMediaIds: ["a3"],
                unsureMediaIds: ["a2", "a3"],
                shownFaceIds: ["a1-f", "a2-f", "a3-f"],
            },
            admin
        );

        expect(state.skippedOn).toEqual([]);
        expect(state.refusedOn).toEqual([]);
        expect(state.assigned.map((row) => row.mediaId)).toEqual(["a1"]);
        expect(result.tagged).toBe(1);
    });

    it("names someone else for the ticked faces only, and coins a new performer", () => {
        state.inGroups = [shown("a1", "g1")];

        const result = decideFaceReview(
            {
                verdict: "name",
                groupId: "g1",
                name: "Lee",
                instead: "jane",
                mediaIds: ["a1"],
                excludedMediaIds: [],
                unsureMediaIds: [],
                shownFaceIds: ["a1-f"],
            },
            admin
        );

        // Not the whole group: the rest may still be her.
        expect(state.decided).toEqual([]);
        expect(state.refusedOn).toEqual([["a1", "jane", ["g1"]]]);
        expect(state.confirmedOn).toEqual([["g1", "lee", ["a1"]]]);
        expect(state.assigned).toEqual([{ mediaId: "a1", tagId: "lee" }]);
        expect(result).toEqual({ name: "Lee", tagged: 1, coined: true });
    });

    it('remembers a "can\'t tell" on the faces shown', () => {
        decideFaceReview({ verdict: "skip", groupId: "g1", mediaIds: ["a1", "a2"] }, admin);

        expect(state.skippedOn).toEqual([["g1", ["a1", "a2"]]]);
    });

    it("refuses a name with nothing in it, and anybody but an administrator", () => {
        expect(() =>
            decideFaceReview(
                {
                    verdict: "name",
                    groupId: "g1",
                    name: "!!",
                    mediaIds: ["a1"],
                    excludedMediaIds: [],
                    unsureMediaIds: [],
                    shownFaceIds: [],
                },
                admin
            )
        ).toThrow(/letter or digit/);
        expect(() => reviewFaces({ tab: "matches", ...page }, { ...admin, scopes: [] })).toThrow(
            /administrator/
        );
    });
});

describe("maybe in this item", () => {
    const matched = (
        mediaId: string,
        tagId: string,
        atMs: number,
        score: number,
        second = 0.1
    ) => ({
        ...shown(mediaId, "g1"),
        id: `${mediaId}-${atMs}`,
        atMs,
        tagId,
        score,
        second,
    });

    it("suggests who a face looks like or the item names, surest first, never a near thing", () => {
        state.suspectFaces = [
            matched("m1", "jane", 1000, 0.72),
            matched("m1", "jane", 5000, 0.65),
            matched("m1", "kim", 2000, 0.5),
            // Barely more like her than like somebody else.
            matched("m1", "jane", 9000, 0.6, 0.55),
        ];
        state.namedOn = [{ tagId: "kim", field: "filename" }];

        const { suspects } = itemSuspects("m1", admin);

        expect(suspects.map((s) => [s.tagId, s.strongFaces, s.score, s.mentions])).toEqual([
            ["jane", 2, 0.72, []],
            ["kim", 0, 0.5, ["filename"]],
        ]);
        expect(suspects[0].face?.atMs).toBe(1000);
        expect(() => itemSuspects("m1", { ...admin, scopes: [] })).toThrow(/administrator/);
    });

    it("adds as an undoable batch with the face confirmed, or refuses as an untag does", () => {
        expect(
            decideItemSuspect("m1", { tagId: "jane", verdict: "add", faceId: "m1-1000" }, admin)
        ).toEqual({ changed: 1 });
        expect(state.assigned).toEqual([{ mediaId: "m1", tagId: "jane" }]);

        decideItemSuspect("m1", { tagId: "jane", verdict: "refuse", faceId: null }, admin);

        expect(state.notThem).toEqual([[["m1"], "jane", "u1", "item"]]);
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
