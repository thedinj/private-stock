import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthorizationError, NotFoundError } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * Who may do what to a reel and to a clip (§14d).
 *
 * The repo tests cover ordering, density and the owner invariant as the table sees it. This
 * covers the rules, each of which fails silently if nobody checks it:
 *
 *  - Sharing a reel grants reading and never writing, **including to an administrator**.
 *  - A reel you cannot see reads as missing rather than forbidden, so the error does not
 *    confirm the id exists.
 *  - A clip is private: the browser and the item page never return somebody else's, and the
 *    only door that does is a reel you can open.
 *  - A reel refuses a clip that is not its owner's, even though nothing in the UI can offer one.
 *  - A clip's tags are its owner's: never shown through a reel, never written by anybody else
 *    (§14d "Tagging clips").
 */

const OWNER = "user-owner";
const OTHER = "user-other";

interface ReelFixture {
    id: string;
    ownerId: string;
    visibility: "private" | "shared";
    name: string;
}

interface ClipFixture {
    id: string;
    mediaId: string;
    userId: string | null;
    startMs: number;
    endMs: number;
    speed: number | null;
}

let reels: ReelFixture[] = [];
let clips: ClipFixture[] = [];
let renumbered: string[] = [];
let removedClips: string[] = [];
/** Media the viewer may reach. Anything else behaves as though it does not exist. */
let visibleMedia: string[] = [];
/** Tags on clips, by name; the tag id is the name, which is all these tests need of it. */
let clipTags: { clipId: string; name: string }[] = [];
const applyToClips = vi.fn((_input: unknown) => ({ batchId: "batch-1", assigned: 1 }));

const summary = (row: ReelFixture) => ({
    ...row,
    description: null,
    itemCount: 0,
    runningMs: 0,
    ownerName: "Someone",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
});

const clipSummary = (row: ClipFixture) => ({
    ...row,
    label: null,
    mediaTitle: "A film",
    mediaRootId: "root",
    mediaDurationMs: 600_000,
    reelCount: 0,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
});

vi.mock("@private-stock/db", () => ({
    db: { transaction: (fn: () => unknown) => () => fn() },
    reelRepo: {
        findById: (id: string) => reels.find((reel) => reel.id === id),
        findSummary: (id: string) => {
            const row = reels.find((reel) => reel.id === id);

            return row ? summary(row) : undefined;
        },
        findByName: (ownerId: string, name: string) =>
            reels.find((reel) => reel.ownerId === ownerId && reel.name === name),
        create: (input: { ownerId: string; name: string; visibility: "private" | "shared" }) => {
            const id = `reel-${reels.length + 1}`;

            reels.push({
                id,
                ownerId: input.ownerId,
                visibility: input.visibility,
                name: input.name,
            });

            return id;
        },
        update: vi.fn(),
        remove: (id: string) => {
            reels = reels.filter((reel) => reel.id !== id);
        },
        listVisibleTo: () => reels.map(summary),
        countVisibleTo: () => reels.length,
        listEntries: () => [],
        countItems: () => 0,
        runningMs: () => 0,
        sampleMediaIds: () => [],
        /** Mirrors the repo's own filter: only the owner's clips go in. */
        addItems: (_reelId: string, ownerId: string, clipIds: string[]) =>
            clipIds.filter((id) => clips.find((clip) => clip.id === id)?.userId === ownerId).length,
        removeItem: () => true,
        moveItem: () => true,
        renumber: (id: string) => renumbered.push(id),
    },
    clipRepo: {
        findById: (id: string) => clips.find((clip) => clip.id === id),
        findSummary: (id: string) => {
            const row = clips.find((clip) => clip.id === id);

            return row ? clipSummary(row) : undefined;
        },
        listForMedia: (mediaId: string, userId: string) =>
            clips
                .filter((clip) => clip.mediaId === mediaId && clip.userId === userId)
                .map(clipSummary),
        listByIds: (ids: string[]) =>
            ids
                .map((id) => clips.find((clip) => clip.id === id))
                .filter((clip): clip is ClipFixture => Boolean(clip))
                .map(clipSummary),
        search: (_query: unknown, scope: { userId: string }) =>
            clips.filter((clip) => clip.userId === scope.userId).map(clipSummary),
        countSearch: () => clips.length,
        distinctLabels: () => [],
        create: (input: ClipFixture) => {
            const id = `clip-${clips.length + 1}`;

            clips.push({ ...input, id });

            return id;
        },
        update: vi.fn(),
        remove: (id: string) => {
            removedClips.push(id);
            clips = clips.filter((clip) => clip.id !== id);
        },
        reelsUsing: (clipId: string) =>
            clips.some((clip) => clip.id === clipId)
                ? reels.map((r) => ({ id: r.id, name: r.name }))
                : [],
    },
    mediaRepo: {
        findDetail: (mediaId: string) =>
            visibleMedia.includes(mediaId)
                ? { id: mediaId, kind: "video", durationMs: 600_000, relPath: "a.mp4" }
                : undefined,
        findBasic: (mediaId: string) => ({ id: mediaId, durationMs: 600_000 }),
        listByIds: (ids: string[]) =>
            ids
                .filter((id) => visibleMedia.includes(id))
                .map((id) => ({
                    id,
                    title: "A film",
                    coverPath: null,
                    coverGeneratedAt: null,
                    durationMs: 1,
                })),
    },
    artifactRepo: { listForMedia: () => [] },
    clipTagRepo: {
        listForClipIds: (ids: string[]) =>
            new Map(
                ids
                    .map(
                        (id) =>
                            [
                                id,
                                clipTags
                                    .filter((tag) => tag.clipId === id)
                                    .map((tag) => ({
                                        clipId: id,
                                        tagId: tag.name,
                                        kind: "tag",
                                        name: tag.name,
                                        colorKey: null,
                                        position: null,
                                        ownerId: null,
                                    })),
                            ] as const
                    )
                    .filter(([, rows]) => rows.length > 0)
            ),
        assign: ({ clipId, tagId }: { clipId: string; tagId: string }) => {
            clipTags.push({ clipId, name: tagId });

            return true;
        },
        unassign: vi.fn(),
        nextPosition: () => 0,
        ownedClipIds: (ids: string[], userId: string) =>
            ids.filter((id) => clips.find((clip) => clip.id === id)?.userId === userId),
    },
    tagRepo: {
        ensureTag: (_kind: string, name: string) => name,
        resolveName: () => undefined,
    },
    tagBatchRepo: {
        applyToClips,
        findById: (id: string) => ({
            id,
            userId: OWNER,
            summary: "Tagged",
            mediaCount: 0,
            clipCount: 1,
            createdAt: "2026-01-01",
            undoneAt: null,
        }),
    },
}));

const { createReel, updateReel, deleteReel, getReel, addReelItems } = await import("./reelService");
const {
    listClipsFor,
    listClips,
    createClip,
    updateClip,
    deleteClip,
    clipsByIds,
    editClipTags,
    bulkTagClips,
} = await import("./clipService");

const auth = (userId: string, scopes: string[] = []): AuthContext =>
    ({ userId, scopes, accessibleRootIds: ["root"], tokenEpoch: 0 }) as unknown as AuthContext;

beforeEach(() => {
    reels = [];
    clips = [];
    renumbered = [];
    removedClips = [];
    visibleMedia = ["media-1"];
    clipTags = [];
    applyToClips.mockClear();
});

describe("who may see a reel", () => {
    it("shows the owner their own private reel", () => {
        reels.push({ id: "r1", ownerId: OWNER, visibility: "private", name: "Mine" });

        expect(getReel("r1", auth(OWNER)).name).toBe("Mine");
    });

    it("reports somebody else's private reel as missing, not as forbidden", () => {
        reels.push({ id: "r1", ownerId: OWNER, visibility: "private", name: "Mine" });

        // Missing rather than forbidden: the error must not confirm that r1 exists.
        expect(() => getReel("r1", auth(OTHER))).toThrow(NotFoundError);
    });

    it("hides it from an administrator too, who manages the library and not somebody's work", () => {
        reels.push({ id: "r1", ownerId: OWNER, visibility: "private", name: "Mine" });

        expect(() => getReel("r1", auth(OTHER, ["admin"]))).toThrow(NotFoundError);
    });

    it("shows a shared reel to everybody", () => {
        reels.push({ id: "r1", ownerId: OWNER, visibility: "shared", name: "Ours" });

        expect(getReel("r1", auth(OTHER)).name).toBe("Ours");
    });
});

describe("who may change a reel", () => {
    it("refuses a viewer of a shared reel, because sharing grants reading only", () => {
        reels.push({ id: "r1", ownerId: OWNER, visibility: "shared", name: "Ours" });

        expect(() => updateReel("r1", { name: "Theirs" }, auth(OTHER))).toThrow(AuthorizationError);
    });

    it("refuses an administrator: admin is not a master key to somebody's reel", () => {
        reels.push({ id: "r1", ownerId: OWNER, visibility: "shared", name: "Ours" });

        expect(() => deleteReel("r1", auth(OTHER, ["admin"]))).toThrow(AuthorizationError);
        expect(reels).toHaveLength(1);
    });

    it("lets the owner delete their own", () => {
        reels.push({ id: "r1", ownerId: OWNER, visibility: "shared", name: "Ours" });

        deleteReel("r1", auth(OWNER));

        expect(reels).toHaveLength(0);
    });
});

describe("sharing", () => {
    it("needs the scope to make one shared", () => {
        expect(() => createReel({ name: "Ours", visibility: "shared" }, auth(OWNER))).toThrow(
            AuthorizationError
        );
    });

    it("allows it with the scope", () => {
        expect(
            createReel({ name: "Ours", visibility: "shared" }, auth(OWNER, ["admin"]))
        ).toBeTruthy();
    });

    it("lets the owner unshare without the scope, so nothing can get stuck shared", () => {
        reels.push({ id: "r1", ownerId: OWNER, visibility: "shared", name: "Ours" });

        expect(() => updateReel("r1", { visibility: "private" }, auth(OWNER))).not.toThrow();
    });
});

describe("the owner invariant", () => {
    it("refuses a clip belonging to somebody else", () => {
        reels.push({ id: "r1", ownerId: OWNER, visibility: "private", name: "Mine" });
        clips.push({
            id: "c1",
            mediaId: "media-1",
            userId: OTHER,
            startMs: 0,
            endMs: 5_000,
            speed: null,
        });

        expect(() => addReelItems("r1", { clipIds: ["c1"] }, auth(OWNER))).toThrow(
            AuthorizationError
        );
    });

    it("accepts the owner's own", () => {
        reels.push({ id: "r1", ownerId: OWNER, visibility: "private", name: "Mine" });
        clips.push({
            id: "c1",
            mediaId: "media-1",
            userId: OWNER,
            startMs: 0,
            endMs: 5_000,
            speed: null,
        });

        expect(() => addReelItems("r1", { clipIds: ["c1"] }, auth(OWNER))).not.toThrow();
    });
});

describe("who may see a clip", () => {
    it("never lists another account's clips on the item page", () => {
        clips.push({
            id: "c1",
            mediaId: "media-1",
            userId: OTHER,
            startMs: 0,
            endMs: 5_000,
            speed: null,
        });

        expect(listClipsFor("media-1", auth(OWNER))).toHaveLength(0);
    });

    it("never lists them in the browser either", () => {
        clips.push({
            id: "c1",
            mediaId: "media-1",
            userId: OTHER,
            startMs: 0,
            endMs: 5_000,
            speed: null,
        });
        clips.push({
            id: "c2",
            mediaId: "media-1",
            userId: OWNER,
            startMs: 0,
            endMs: 5_000,
            speed: null,
        });

        const found = listClips(
            { sort: "created", direction: undefined, limit: 50, page: 0 } as never,
            auth(OWNER)
        );

        expect(found.items).toHaveLength(1);
        expect(found.items[0].mine).toBe(true);
    });

    it("reports an item this account cannot reach as missing", () => {
        visibleMedia = [];

        expect(() => listClipsFor("media-1", auth(OWNER))).toThrow(NotFoundError);
    });
});

describe("who may change a clip", () => {
    it("says so plainly once you can see it, rather than pretending it is not there", () => {
        clips.push({
            id: "c1",
            mediaId: "media-1",
            userId: OTHER,
            startMs: 0,
            endMs: 5_000,
            speed: null,
        });

        // Forbidden rather than missing: it is on screen in front of them inside a shared reel,
        // so there is nothing to conceal and "it is not yours" is the useful answer.
        expect(() => updateClip("c1", { label: "mine now" }, auth(OWNER))).toThrow(
            AuthorizationError
        );
    });

    it("lets an administrator retime an unattributed clip, which nobody can claim", () => {
        clips.push({
            id: "c1",
            mediaId: "media-1",
            userId: null,
            startMs: 0,
            endMs: 5_000,
            speed: null,
        });

        expect(() => updateClip("c1", { label: "tidied" }, auth(OTHER, ["admin"]))).not.toThrow();
    });

    it("refuses an ordinary account the same clip", () => {
        clips.push({
            id: "c1",
            mediaId: "media-1",
            userId: null,
            startMs: 0,
            endMs: 5_000,
            speed: null,
        });

        expect(() => updateClip("c1", { label: "tidied" }, auth(OTHER))).toThrow(
            AuthorizationError
        );
    });
});

describe("discarding a clip", () => {
    it("removes it and renumbers every reel it was in", () => {
        reels.push({ id: "r1", ownerId: OWNER, visibility: "private", name: "Mine" });
        clips.push({
            id: "c1",
            mediaId: "media-1",
            userId: OWNER,
            startMs: 0,
            endMs: 5_000,
            speed: null,
        });

        // Cascade rather than refusal: every reel here is the deleter's own, so there is no
        // stranger's arrangement to protect and no invisible object holding a veto.
        expect(deleteClip("c1", auth(OWNER))).toEqual({ reelsChanged: 1 });
        expect(removedClips).toEqual(["c1"]);
        // The rows left through the foreign key, so nothing else would close the holes.
        expect(renumbered).toEqual(["r1"]);
    });
});

describe("marking a clip", () => {
    it("refuses a span shorter than a mis-press", () => {
        expect(() =>
            createClip("media-1", { startMs: 1_000, endMs: 1_050 } as never, auth(OWNER))
        ).toThrow();
    });

    it("clamps to the probed duration rather than refusing at the tail", () => {
        const clip = createClip(
            "media-1",
            { startMs: 599_000, endMs: 999_000 } as never,
            auth(OWNER)
        );

        expect(clip.endMs).toBe(600_000);
    });

    it("keeps a chosen speed, and a run time longer than the span", () => {
        const clip = createClip(
            "media-1",
            { startMs: 0, endMs: 10_000, speed: 0.5 } as never,
            auth(OWNER)
        );

        expect(clip.speed).toBe(0.5);
        expect(clip.runMs).toBe(20_000);
    });
});

describe("a clip's tags", () => {
    const ownClip = (): void => {
        clips.push({
            id: "c1",
            mediaId: "media-1",
            userId: OWNER,
            startMs: 0,
            endMs: 5_000,
            speed: null,
        });
    };

    it("shows them to the owner in the browser", () => {
        ownClip();
        clipTags.push({ clipId: "c1", name: "jumping" });

        const found = listClips(
            { sort: "created", direction: undefined, limit: 50, page: 0 } as never,
            auth(OWNER)
        );

        expect(found.items[0].tags.map((tag) => tag.name)).toEqual(["jumping"]);
    });

    it("leaves them off a clip read through a reel, which grants the span and not its filing", () => {
        ownClip();
        clipTags.push({ clipId: "c1", name: "jumping" });

        expect(clipsByIds(["c1"], auth(OTHER)).get("c1")?.tags).toEqual([]);
    });

    it("puts them on as the clip is saved", () => {
        const clip = createClip(
            "media-1",
            {
                startMs: 0,
                endMs: 10_000,
                tags: [{ kind: "tag", name: "jumping", scope: "public" }],
            } as never,
            auth(OWNER)
        );

        expect(clip.tags.map((tag) => tag.name)).toEqual(["jumping"]);
    });

    it("reports somebody else's clip as missing to a tag edit", () => {
        ownClip();

        expect(() =>
            editClipTags(
                "c1",
                { kind: "tag", names: ["mine now"], scope: "public", mode: "add" },
                auth(OTHER, ["admin"])
            )
        ).toThrow(NotFoundError);
        expect(clipTags).toEqual([]);
    });

    it("refuses a bulk apply naming anybody else's clip, rather than tagging the rest", () => {
        ownClip();
        clips.push({
            id: "c2",
            mediaId: "media-1",
            userId: OTHER,
            startMs: 0,
            endMs: 5_000,
            speed: null,
        });

        expect(() =>
            bulkTagClips(
                { clipIds: ["c1", "c2"], kind: "tag", names: ["jumping"], scope: "public" },
                auth(OWNER)
            )
        ).toThrow(NotFoundError);
        expect(applyToClips).not.toHaveBeenCalled();
    });

    it("writes one batch for a selection of the caller's own", () => {
        ownClip();

        const result = bulkTagClips(
            { clipIds: ["c1"], kind: "tag", names: ["jumping"], scope: "public" },
            auth(OWNER)
        );

        expect(applyToClips).toHaveBeenCalledWith(
            expect.objectContaining({ clipIds: ["c1"], tagIds: ["jumping"], userId: OWNER })
        );
        expect(result.batch.clipCount).toBe(1);
    });
});
