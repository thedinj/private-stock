import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    AuthorizationError,
    COMPANION_STRIPS,
    ConflictError,
    NotFoundError,
    SELECTION_TAG_LIMIT,
    ValidationError,
} from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * Who may change the vocabulary, and whose tagging everybody else sees (§6).
 *
 * The schema has always had `MediaTag.userId`, the read paths have always honoured it, and
 * no write path ever set it — so every tag anybody applied was library-wide, and a library
 * shared by several people had one shared set of opinions about every item whether or not
 * they agreed. These tests are the rule that replaced that.
 *
 * Both directions matter and both fail quietly. A non-admin's tagging leaking into the
 * library changes what everyone sees with nothing on screen to say so; an administrator's
 * tagging landing in their own vocabulary means the curated names nobody else can see, and
 * the library slowly stops having any.
 */

interface TagFixture {
    id: string;
    kind: string;
    name: string;
    nameNorm: string;
    colorKey: string | null;
    description: string | null;
    ownerId: string | null;
    createdById: string | null;
}

interface AssignmentFixture {
    mediaId: string;
    tagId: string;
    userId: string | null;
    createdById: string | null;
    source: string;
}

let tags: TagFixture[] = [];
let assignments: AssignmentFixture[] = [];
/** Aliases, as `{ tagId, name }`. Normalised by `norm` wherever they are compared. */
let aliases: { tagId: string; name: string }[] = [];
let reindexed: string[] = [];
/** `userId:tagId` for each favourite. */
let favorites: Set<string> = new Set();
/** Items the viewer's libraries actually hold. */
let visibleMedia: Set<string> = new Set();
/** What `tagRepo.companions` answers, and how often it was asked. */
let companionRows: { tagId: string; name: string; shared: number }[] = [];
let companionCalls = 0;
/** Shared items per companion, as `sampleSharedMediaIds` would sample them. */
let sharedSamples: Map<string, string[]> = new Map();
/** Rows `listForSelection` should answer with, in the order the repo would. */
let selectionRows: {
    tagId: string;
    kind: string;
    name: string;
    colorKey: string | null;
    private: 1 | null;
    count: number;
}[] = [];

const norm = (name: string) => name.trim().toLowerCase();

/** The repo's `resolveName`, by name first and then by alias, within one vocabulary. */
const resolve = (kind: string, name: string, ownerId: string | null) => {
    const inVocabulary = tags.filter((row) => row.kind === kind && row.ownerId === ownerId);
    const named = inVocabulary.find((row) => row.nameNorm === norm(name));

    if (named) return { tag: named, via: "name" as const };

    const alias = aliases.find(
        (row) => norm(row.name) === norm(name) && inVocabulary.some((tag) => tag.id === row.tagId)
    );
    const tag = alias && tags.find((row) => row.id === alias.tagId);

    return tag ? { tag, via: "alias" as const } : undefined;
};

const takenMessage = (clash: { tag: TagFixture; via: "name" | "alias" }, typed: string) =>
    clash.via === "alias"
        ? `"${typed}" is already an alias of ${clash.tag.name}`
        : `A ${clash.tag.kind} tag named "${clash.tag.name}" already exists — merge instead`;

vi.mock("./notThem", () => ({ notThem: vi.fn() }));

vi.mock("@private-stock/db", () => ({
    db: {
        transaction: (fn: () => unknown) =>
            Object.assign(() => fn(), { deferred: () => fn(), immediate: () => fn() }),
    },
    // The OCR match queue's hooks (§5d): nothing here reads what they do.
    jobRepo: { enqueueKind: () => undefined },
    // Tags' pictures (§6): none here.
    tagPictureRepo: { effectiveFor: () => new Map() },
    ocrTagMatchRepo: {
        declineRules: () => undefined,
        pairsTouching: () => [],
        recountPending: () => 0,
    },
    isBusyError: () => false,
    userTagRepo: {
        setFavorite: (userId: string, tagId: string, favorite: boolean) => {
            if (favorite) favorites.add(`${userId}:${tagId}`);
            else favorites.delete(`${userId}:${tagId}`);
        },
        isFavorite: (userId: string, tagId: string) => favorites.has(`${userId}:${tagId}`),
    },
    tagRepo: {
        findById: (id: string) => tags.find((row) => row.id === id),
        listForSelection: (mediaIds: string[], _userId: string, limit: number) =>
            mediaIds.length === 0 ? [] : selectionRows.slice(0, limit),
        ensureTag: (
            kind: string,
            name: string,
            ownerId: string | null = null,
            createdById: string | null = null,
            colorKey: string | null = null
        ) => {
            const existing = tags.find(
                (row) => row.kind === kind && row.nameNorm === norm(name) && row.ownerId === ownerId
            );

            if (existing) return existing.id;

            const row: TagFixture = {
                id: `t${tags.length + 1}`,
                kind,
                name: name.trim(),
                nameNorm: norm(name),
                colorKey,
                description: null,
                ownerId,
                createdById,
            };
            tags.push(row);

            return row.id;
        },
        updateTag: (id: string, input: { name?: string; kind?: string; description?: string }) => {
            const row = tags.find((entry) => entry.id === id);

            if (!row) return;
            if (input.kind !== undefined) row.kind = input.kind;
            if (input.name !== undefined) {
                row.name = input.name;
                row.nameNorm = norm(input.name);
            }
            if (input.description !== undefined) row.description = input.description;
        },
        removeTag: (id: string) => {
            tags = tags.filter((row) => row.id !== id);
            assignments = assignments.filter((row) => row.tagId !== id);
        },
        mergeTags: (sourceId: string, targetId: string, options: { keepAlias?: boolean } = {}) => {
            const source = tags.find((row) => row.id === sourceId);

            assignments = assignments.map((row) =>
                row.tagId === sourceId ? { ...row, tagId: targetId } : row
            );
            aliases = aliases.map((row) =>
                row.tagId === sourceId ? { ...row, tagId: targetId } : row
            );
            if (options.keepAlias && source) aliases.push({ tagId: targetId, name: source.name });
            tags = tags.filter((row) => row.id !== sourceId);

            return 1;
        },
        resolveName: resolve,
        nameTakenMessage: takenMessage,
        aliasesByTag: (tagIds: string[]) =>
            new Map(
                tagIds.map((id) => [
                    id,
                    aliases
                        .filter((row) => row.tagId === id)
                        .map((row) => row.name)
                        .sort(),
                ])
            ),
        setAliases: (tagId: string, names: string[]) => {
            const tag = tags.find((row) => row.id === tagId)!;
            const wanted = [
                ...new Map(
                    names
                        .filter((name) => norm(name) !== tag.nameNorm)
                        .map((name) => [norm(name), name.trim()])
                ).values(),
            ];

            for (const name of wanted) {
                const clash = resolve(tag.kind, name, tag.ownerId);

                if (clash && clash.tag.id !== tagId) {
                    throw new ConflictError(takenMessage(clash, name));
                }
            }

            aliases = [
                ...aliases.filter((row) => row.tagId !== tagId),
                ...wanted.map((name) => ({ tagId, name })),
            ];
        },
        dropClashingAliases: () => 0,
        // One vocabulary at a time, matching the repo: the two boxes suggest separately.
        listByKind: (kind: string, owner: string | null) =>
            tags
                .filter((row) => row.kind === kind && row.ownerId === owner)
                .map((row) => ({ ...row, mediaCount: 0 })),
        listKinds: (userId: string) =>
            [
                ...new Set(
                    tags
                        .filter((row) => row.ownerId === null || row.ownerId === userId)
                        .map((row) => row.kind)
                ),
            ].map((kind) => ({ kind, tagCount: 1 })),
        listForMedia: (mediaId: string, userId: string | null) =>
            assignments
                .filter(
                    (row) =>
                        row.mediaId === mediaId && (row.userId === null || row.userId === userId)
                )
                .map((row) => {
                    const tag = tags.find((entry) => entry.id === row.tagId)!;

                    return {
                        tagId: row.tagId,
                        kind: tag.kind,
                        name: tag.name,
                        colorKey: tag.colorKey,
                        source: row.source,
                        confidence: null,
                        position: null,
                        private: row.userId === null ? null : 1,
                    };
                }),
        assign: (input: {
            mediaId: string;
            tagId: string;
            userId: string | null;
            createdById: string | null;
            source?: string;
        }) => {
            assignments.push({
                mediaId: input.mediaId,
                tagId: input.tagId,
                userId: input.userId,
                createdById: input.createdById,
                source: input.source ?? "user",
            });
        },
        nextPosition: () => 0,
        unassign: (mediaId: string, tagId: string, userId: string | null) => {
            const before = assignments.length;

            assignments = assignments.filter(
                (row) => !(row.mediaId === mediaId && row.tagId === tagId && row.userId === userId)
            );

            return before - assignments.length;
        },
        replaceFacet: (
            mediaId: string,
            kind: string,
            tagIds: string[],
            options: { userId: string | null; createdById: string | null; source?: string }
        ) => {
            const userId = options.userId;
            const inFacet = (row: (typeof assignments)[number]): boolean => {
                const tag = tags.find((entry) => entry.id === row.tagId);

                return row.mediaId === mediaId && tag?.kind === kind && row.userId === userId;
            };
            const removed = assignments
                .filter((row) => inFacet(row) && !tagIds.includes(row.tagId))
                .map((row) => row.tagId);

            assignments = assignments.filter((row) => !inFacet(row));

            tagIds.forEach((tagId) =>
                assignments.push({
                    mediaId,
                    tagId,
                    userId,
                    createdById: options.createdById,
                    source: options.source ?? "user",
                })
            );

            return removed;
        },
        mediaIdsWithTag: (tagId: string) =>
            assignments.filter((row) => row.tagId === tagId).map((row) => row.mediaId),
        /**
         * The filter panel reads the vocabulary rather than scanning the library (§20), so
         * these two are on the tag repo now. Empty here: what this file tests is who may
         * write to which system, and the facet reads have their own tests against a real
         * database, where an in-memory stub would only restate the fixture back at itself.
         */
        listFacetValues: () => [],
        countFacetValues: () => [],
        /** Every tag of the owner's vocabulary with an assignment, as the browse query would. */
        browseTags: (owner: string | null) => {
            const rows = tags
                .filter((row) => row.ownerId === owner)
                .filter((row) => assignments.some((a) => a.tagId === row.id))
                .map((row) => ({
                    ...row,
                    videoCount: 1,
                    imageCount: 0,
                    aliases: aliases
                        .filter((alias) => alias.tagId === row.id)
                        .map((alias) => alias.name),
                    favorite: null,
                }));

            return { rows, total: rows.length };
        },
        sampleMediaIdsByTag: (tagIds: string[]) =>
            new Map(
                tagIds.map((tagId) => [
                    tagId,
                    assignments.filter((row) => row.tagId === tagId).map((row) => row.mediaId),
                ])
            ),
        countByKind: () => ({ videoCount: 1, imageCount: 0 }),
        companions: () => {
            companionCalls++;

            return companionRows;
        },
        sampleSharedMediaIds: (_tagId: string, companionIds: string[]) =>
            new Map(companionIds.map((id) => [id, sharedSamples.get(id) ?? []])),
        listVocabulary: (owner: string | null, options: { limit: number; offset: number }) => {
            const rows = tags
                .filter((row) => row.ownerId === owner)
                .map((row) => ({ ...row, mediaCount: 0, createdBy: null }));

            return {
                rows: rows.slice(options.offset, options.offset + options.limit),
                total: rows.length,
            };
        },
        hasAssignmentsByOthers: (tagId: string, userId: string) =>
            assignments.some((row) => row.tagId === tagId && row.createdById !== userId),
        setScope: (tagId: string, owner: string | null) => {
            const tag = tags.find((row) => row.id === tagId);

            if (tag) tag.ownerId = owner;
            assignments = assignments.map((row) =>
                row.tagId === tagId ? { ...row, userId: owner } : row
            );

            return assignments.filter((row) => row.tagId === tagId).map((row) => row.mediaId);
        },
        moveAssignments: (fromTagId: string, toTagId: string, owner: string | null) => {
            const moved = assignments
                .filter((row) => row.tagId === fromTagId)
                .map((row) => row.mediaId);

            assignments = assignments.map((row) =>
                row.tagId === fromTagId ? { ...row, tagId: toTagId, userId: owner } : row
            );
            tags = tags.filter((row) => row.id !== fromTagId);

            return moved;
        },
    },
    mediaRepo: {
        findDetail: () => ({ id: "m1" }),
        /** Only the ids the fixture admits exist, which is how an unreachable one is tested. */
        listByIds: (ids: string[]) =>
            ids.filter((id) => visibleMedia.has(id)).map((id) => ({ id })),
        facetCountsForTags: () => [],
    },
    searchRepo: {
        requestReindex: (ids: string[]) => {
            reindexed.push(...ids);
        },
    },
    changeLogRepo: { record: () => undefined },
}));

/** Tiles as the ids alone; what a tile looks like is `mediaService`'s business, not this. */
vi.mock("./mediaService", () => ({
    toListPage: (rows: { id: string }[]) => rows.map((row) => ({ id: row.id })),
    listMedia: () => ({ items: [] }),
}));

const {
    applyTags,
    browseTags,
    getTagCompanions,
    getTagProfile,
    setTagFavorite,
    createTag,
    deleteTag,
    getMediaTags,
    listSelectionTags,
    listTags,
    listVocabulary,
    mergeTags,
    publishTag,
    unpublishTag,
    updateTag,
} = await import("./tagService");

const ADMIN = {
    userId: "admin",
    accessibleRootIds: ["root"],
    scopes: ["admin"],
} as unknown as AuthContext;

const ANNA = { userId: "anna", accessibleRootIds: ["root"], scopes: [] } as unknown as AuthContext;
const BEN = { userId: "ben", accessibleRootIds: ["root"], scopes: [] } as unknown as AuthContext;

/** What the library sees: assignments with no owner. */
const libraryTags = (mediaId: string) =>
    assignments
        .filter((row) => row.mediaId === mediaId && row.userId === null)
        .map((row) => tags.find((tag) => tag.id === row.tagId)!.name);

beforeEach(() => {
    tags = [];
    assignments = [];
    aliases = [];
    reindexed = [];
    favorites = new Set();
    visibleMedia = new Set(["m1", "m2"]);
    selectionRows = [];
    companionRows = [];
    companionCalls = 0;
    sharedSamples = new Map();
});

describe("applying a tag", () => {
    /**
     * The change these tests exist for.
     *
     * Scope used to follow the *role*: an administrator's tagging was the library's and
     * everybody else's was silently private. That made a second household member unable to
     * contribute to the shared vocabulary at all, and an administrator unable to keep a note
     * to themselves. It is the request that decides now, and the role decides nothing (§6).
     */
    it("lets anybody write a public tag, administrator or not", () => {
        applyTags("m1", { kind: "genre", names: ["Drama"], scope: "public", mode: "add" }, ANNA);

        expect(libraryTags("m1")).toEqual(["Drama"]);
        expect(getMediaTags("m1", BEN).map((tag) => tag.name)).toEqual(["Drama"]);
    });

    it("lets anybody keep one to themselves, administrator or not", () => {
        applyTags("m1", { kind: "genre", names: ["To cut"], scope: "private", mode: "add" }, ADMIN);

        expect(libraryTags("m1")).toEqual([]);
        expect(getMediaTags("m1", ADMIN).map((tag) => tag.name)).toEqual(["To cut"]);
        expect(getMediaTags("m1", ANNA)).toEqual([]);
    });

    it("keeps one person's private tag from another", () => {
        applyTags("m1", { kind: "genre", names: ["Slow"], scope: "private", mode: "add" }, ANNA);

        expect(getMediaTags("m1", ANNA).map((tag) => tag.name)).toEqual(["Slow"]);
        expect(getMediaTags("m1", BEN)).toEqual([]);
        expect(getMediaTags("m1", ADMIN)).toEqual([]);
    });

    /**
     * The fallback that used to exist, and why it does not.
     *
     * Typing "drama" privately once resolved to the library's "Drama" and applied it
     * privately, so one chip meant "the library's tag, used privately" in one place and "my
     * own tag" in another — and a public tag's count was the viewer's own total rather than
     * the library's. Separate systems, separate names.
     */
    it("coins a private tag even when the library has the same name", () => {
        applyTags("m1", { kind: "genre", names: ["Drama"], scope: "public", mode: "add" }, ADMIN);
        applyTags("m2", { kind: "genre", names: ["drama"], scope: "private", mode: "add" }, ANNA);

        expect(tags.filter((tag) => tag.nameNorm === "drama")).toHaveLength(2);
        expect(tags.map((tag) => tag.ownerId).sort()).toEqual(["anna", null]);
        expect(libraryTags("m2")).toEqual([]);
    });

    it("hides a private name from everybody else's vocabulary", () => {
        applyTags(
            "m1",
            { kind: "genre", names: ["Gift ideas"], scope: "private", mode: "add" },
            ANNA
        );

        expect(listTags("genre", "private", BEN)).toEqual([]);
        expect(listTags("genre", "private", ANNA).map((tag) => tag.name)).toEqual(["Gift ideas"]);
        // And it is not in the public vocabulary either, which is what "private name" means.
        expect(listTags("genre", "public", ANNA)).toEqual([]);
    });

    it("gives two people the same private name without either taking it from the other", () => {
        applyTags("m1", { kind: "genre", names: ["Beach"], scope: "private", mode: "add" }, ANNA);
        applyTags("m1", { kind: "genre", names: ["Beach"], scope: "private", mode: "add" }, BEN);

        // A single UNIQUE (kind, nameNorm) would have let whoever typed it first own the
        // name for everybody. The two partial uniques are what make this work.
        expect(tags.map((tag) => tag.ownerId).sort()).toEqual(["anna", "ben"]);
    });

    it("does not let a replace in one system clear the other", () => {
        applyTags("m1", { kind: "genre", names: ["Drama"], scope: "public", mode: "add" }, ADMIN);
        applyTags("m1", { kind: "genre", names: ["Slow"], scope: "private", mode: "add" }, ANNA);

        applyTags(
            "m1",
            { kind: "genre", names: ["Thriller"], scope: "public", mode: "replace" },
            ANNA
        );

        expect(libraryTags("m1")).toEqual(["Thriller"]);
        expect(
            getMediaTags("m1", ANNA)
                .map((tag) => tag.name)
                .sort()
        ).toEqual(["Slow", "Thriller"]);
    });

    it("says which tags on an item the viewer alone can see", () => {
        applyTags("m1", { kind: "genre", names: ["Drama"], scope: "public", mode: "add" }, ADMIN);
        applyTags("m1", { kind: "genre", names: ["Slow"], scope: "private", mode: "add" }, ANNA);

        expect(
            Object.fromEntries(getMediaTags("m1", ANNA).map((tag) => [tag.name, tag.private]))
        ).toEqual({ Drama: false, Slow: true });
    });

    /**
     * The item page's box sends one chip per request now. Removing by name is what keeps two
     * quick edits from erasing each other, which "replace" with a stale list did.
     */
    it("removes one name and leaves the rest of the facet alone", () => {
        applyTags(
            "m1",
            { kind: "genre", names: ["Drama", "Slow"], scope: "public", mode: "add" },
            ANNA
        );

        applyTags("m1", { kind: "genre", names: ["drama"], scope: "public", mode: "remove" }, ANNA);

        expect(libraryTags("m1")).toEqual(["Slow"]);
    });

    it("removes a suggestion as well as a typed tag", () => {
        applyTags("m1", { kind: "genre", names: ["Drama"], scope: "public", mode: "add" }, ANNA);
        assignments[0].source = "ai";

        applyTags("m1", { kind: "genre", names: ["Drama"], scope: "public", mode: "remove" }, ANNA);

        expect(libraryTags("m1")).toEqual([]);
    });

    it("does not coin a name it is asked to remove, nor touch the other system", () => {
        applyTags("m1", { kind: "genre", names: ["Slow"], scope: "private", mode: "add" }, ANNA);

        applyTags("m1", { kind: "genre", names: ["Slow"], scope: "public", mode: "remove" }, ANNA);
        applyTags("m1", { kind: "genre", names: ["Nope"], scope: "public", mode: "remove" }, ANNA);

        expect(tags.map((tag) => tag.name)).toEqual(["Slow"]);
        expect(getMediaTags("m1", ANNA).map((tag) => tag.name)).toEqual(["Slow"]);
    });

    /** Attribution: a public tag's only record of where it came from (§6). */
    it("records who applied a public tag", () => {
        applyTags("m1", { kind: "genre", names: ["Drama"], scope: "public", mode: "add" }, ANNA);

        expect(assignments[0].createdById).toBe("anna");
    });
});

describe("coining a tag directly", () => {
    it("puts an administrator's in the library and everybody else's in their own", () => {
        expect(createTag({ kind: "genre", name: "Noir", scope: "public" }, ADMIN).private).toBe(
            false
        );
        expect(createTag({ kind: "genre", name: "To watch", scope: "private" }, ANNA).private).toBe(
            true
        );
    });

    it("checks for a clash only in the vocabulary being written to", () => {
        createTag({ kind: "genre", name: "Beach", scope: "private" }, ANNA);

        // Anna's private "Beach" must not stop the administrator coining the library's --
        // she would otherwise be able to reserve any name she liked against everyone.
        expect(() =>
            createTag({ kind: "genre", name: "Beach", scope: "public" }, ADMIN)
        ).not.toThrow();
        // And a second one of her own is still a genuine duplicate.
        expect(() => createTag({ kind: "genre", name: "Beach", scope: "private" }, ANNA)).toThrow(
            ConflictError
        );
    });
});

describe("curating the vocabulary", () => {
    const library = () => createTag({ kind: "genre", name: "Drama", scope: "public" }, ADMIN).id;
    const annas = () => createTag({ kind: "genre", name: "Mine", scope: "private" }, ANNA).id;

    it("lets only an administrator rename or delete a library tag", () => {
        const id = library();

        expect(() => updateTag(id, { name: "Dramatic" }, ANNA)).toThrow(AuthorizationError);
        expect(() => deleteTag(id, ANNA)).toThrow(AuthorizationError);
        expect(() => updateTag(id, { name: "Dramatic" }, ADMIN)).not.toThrow();
    });

    it("lets its owner rename or delete a private tag", () => {
        const id = annas();

        expect(() => updateTag(id, { name: "Ours" }, ANNA)).not.toThrow();
        expect(() => deleteTag(id, ANNA)).not.toThrow();
    });

    it("hides somebody else's private tag from everyone, administrators included", () => {
        const id = annas();

        // Not-found rather than forbidden: forbidden would confirm it exists, which is half
        // of what was being kept private. And the administrator gets the same answer Ben
        // does -- `admin` manages the library, not other people's collections (§6), the
        // same line playlists and saved filters draw.
        expect(() => updateTag(id, { name: "Theirs" }, BEN)).toThrow(NotFoundError);
        expect(() => deleteTag(id, BEN)).toThrow(NotFoundError);
        expect(() => updateTag(id, { name: "Ours" }, ADMIN)).toThrow(NotFoundError);
        expect(() => deleteTag(id, ADMIN)).toThrow(NotFoundError);
    });

    it("refuses to merge across vocabularies", () => {
        const shared = library();
        const mine = annas();

        // Folding a private tag into the library's publishes every item somebody had kept
        // to themselves; the other direction takes a shared name away from everybody else.
        // Neither is what the person clicking "merge" is asking for.
        expect(() => mergeTags(mine, shared, ADMIN)).toThrow();
        expect(() => mergeTags(shared, mine, ANNA)).toThrow();
    });

    it("merges within one vocabulary", () => {
        const a = createTag({ kind: "genre", name: "Sci-fi", scope: "private" }, ANNA).id;
        const b = createTag({ kind: "genre", name: "Science fiction", scope: "private" }, ANNA).id;

        mergeTags(a, b, ANNA);

        expect(tags.map((tag) => tag.name)).toEqual(["Science fiction"]);
    });
});

describe("moving a tag between the two systems", () => {
    /**
     * The owner's call, and nobody else's — an administrator included.
     *
     * `admin` curates the library; moving somebody's private tag into it is a decision about
     * their collection rather than about the library (§6). Not-found rather than forbidden,
     * like every other read of a private tag: forbidden confirms it exists.
     */
    it("refuses to publish a tag that is not yours", () => {
        applyTags("m1", { kind: "tag", names: ["Mine"], scope: "private", mode: "add" }, ANNA);

        expect(() => publishTag(tags[0].id, BEN)).toThrow(NotFoundError);
        expect(() => publishTag(tags[0].id, ADMIN)).toThrow(NotFoundError);
    });

    it("publishes your own, with everything you put it on", () => {
        applyTags("m1", { kind: "tag", names: ["Mine"], scope: "private", mode: "add" }, ANNA);

        expect(publishTag(tags[0].id, ANNA)).toEqual({ affected: 1 });
        expect(tags[0].ownerId).toBeNull();
        expect(libraryTags("m1")).toEqual(["Mine"]);
    });

    /**
     * Publishing is the one vocabulary change that reaches people who were not looking at it:
     * public tags are in the search document and private ones are not (§5c).
     */
    it("rebuilds the search document for the items it published", () => {
        applyTags("m1", { kind: "tag", names: ["Mine"], scope: "private", mode: "add" }, ANNA);
        reindexed = [];
        publishTag(tags[0].id, ANNA);

        expect(reindexed).toContain("m1");
    });

    /**
     * A name already taken in the public vocabulary is not a failure. The items end up tagged
     * either way, which is what was asked for, and the name everybody already uses survives.
     */
    it("folds into the public tag when the name is taken", () => {
        applyTags("m1", { kind: "tag", names: ["Beach"], scope: "public", mode: "add" }, ADMIN);
        applyTags("m2", { kind: "tag", names: ["Beach"], scope: "private", mode: "add" }, ANNA);

        const mine = tags.find((tag) => tag.ownerId === "anna")!;

        expect(publishTag(mine.id, ANNA)).toEqual({ affected: 1 });
        expect(tags.filter((tag) => tag.nameNorm === "beach")).toHaveLength(1);
        expect(libraryTags("m2")).toEqual(["Beach"]);
    });

    it("unpublishes one only you have used", () => {
        applyTags("m1", { kind: "tag", names: ["Mine"], scope: "public", mode: "add" }, ANNA);

        expect(unpublishTag(tags[0].id, ANNA)).toEqual({ affected: 1 });
        expect(tags[0].ownerId).toBe("anna");
        expect(libraryTags("m1")).toEqual([]);
    });

    /**
     * The rule that keeps unpublishing safe. Once somebody else has used the tag, taking it
     * private removes a shared name from everybody and strands their work — the same objection
     * `mergeTags` raises against folding the library's tag into a private one.
     */
    it("refuses once somebody else has used it", () => {
        applyTags("m1", { kind: "tag", names: ["Beach"], scope: "public", mode: "add" }, ANNA);
        applyTags("m2", { kind: "tag", names: ["Beach"], scope: "public", mode: "add" }, BEN);

        expect(() => unpublishTag(tags[0].id, ANNA)).toThrow(ConflictError);
    });

    it("refuses when it would collide with one of your own", () => {
        applyTags("m1", { kind: "tag", names: ["Beach"], scope: "public", mode: "add" }, ANNA);
        applyTags("m2", { kind: "tag", names: ["Beach"], scope: "private", mode: "add" }, ANNA);

        const shared = tags.find((tag) => tag.ownerId === null)!;

        expect(() => unpublishTag(shared.id, ANNA)).toThrow(ConflictError);
    });

    /**
     * Nobody else having used a tag does not make it yours. Without this, anybody could take a
     * name somebody else had just coined out of the library before it was ever applied.
     */
    it("refuses a tag somebody else coined, even one nobody has used", () => {
        createTag({ kind: "tag", name: "Road trip", scope: "public" }, ADMIN);

        expect(() => unpublishTag(tags[0].id, ANNA)).toThrow(NotFoundError);
        expect(tags[0].ownerId).toBeNull();
    });
});

describe("reading a vocabulary", () => {
    it("gives the public one to anybody", () => {
        applyTags("m1", { kind: "tag", names: ["Beach"], scope: "public", mode: "add" }, ANNA);

        expect(
            listVocabulary({ scope: "public", sort: "name", limit: 50, offset: 0 }, BEN).tags.map(
                (t) => t.name
            )
        ).toEqual(["Beach"]);
    });

    /** `writesTo` resolves the private scope to the caller, so it can never name anybody else. */
    it("gives the private one only to its owner", () => {
        applyTags("m1", { kind: "tag", names: ["Mine"], scope: "private", mode: "add" }, ANNA);

        expect(
            listVocabulary({ scope: "private", sort: "name", limit: 50, offset: 0 }, ANNA).tags
        ).toHaveLength(1);
        expect(
            listVocabulary({ scope: "private", sort: "name", limit: 50, offset: 0 }, BEN).tags
        ).toEqual([]);
    });
});

describe("what a selection carries", () => {
    const row = (name: string, owner: 1 | null, count: number) => ({
        tagId: `t-${name}`,
        kind: "tag",
        name,
        colorKey: null,
        private: owner,
        count,
    });

    it("counts only the items the viewer can see", () => {
        selectionRows = [row("Beach", null, 1)];

        // The denominator of "on 1 of 2" has to be what was counted. An id on a library this
        // account was never granted is in no count, and including it in the total presents a
        // number that is wrong as though it were exact.
        expect(listSelectionTags(["m1", "elsewhere"], ANNA).selected).toBe(1);
    });

    it("reports the scope from the tag rather than from the request", () => {
        selectionRows = [row("Mine", 1, 2), row("Shared", null, 2)];

        expect(listSelectionTags(["m1", "m2"], ANNA).tags.map((tag) => tag.scope)).toEqual([
            "private",
            "public",
        ]);
    });

    it("says when there is more than it will name, without naming it", () => {
        selectionRows = Array.from({ length: SELECTION_TAG_LIMIT + 1 }, (_, index) =>
            row(`Tag ${index}`, null, 1)
        );

        const result = listSelectionTags(["m1"], ANNA);

        // A list somebody cannot see the end of is a tag they cannot remove, so the overflow
        // is reported -- and the row that proved it exists is not passed off as part of the
        // list.
        expect(result.tags).toHaveLength(SELECTION_TAG_LIMIT);
        expect(result.truncated).toBe(true);
    });

    it("answers a selection of nothing visible without a list", () => {
        visibleMedia = new Set();
        selectionRows = [row("Beach", null, 1)];

        expect(listSelectionTags(["gone"], ANNA)).toEqual({
            tags: [],
            selected: 0,
            truncated: false,
        });
    });
});

describe("aliases", () => {
    const givenJane = (): string =>
        createTag({ kind: "performer", name: "Jane Doe", scope: "public" }, ADMIN).id;

    it("are edited with the tag, and returned with it", () => {
        const id = givenJane();

        const saved = updateTag(id, { aliases: ["Jane Smith"] }, ADMIN);

        expect(saved.aliases).toEqual(["Jane Smith"]);
        expect(reindexed).toEqual([]);
    });

    it("are the vocabulary's to curate, so only an administrator edits a library tag's", () => {
        const id = givenJane();

        expect(() => updateTag(id, { aliases: ["Jane Smith"] }, ANNA)).toThrow(AuthorizationError);
    });

    it("swap with the name when renaming onto one and keeping the old name", () => {
        const id = givenJane();
        updateTag(id, { aliases: ["Jane Smith"] }, ADMIN);

        const saved = updateTag(id, { name: "Jane Smith", keepOldNameAsAlias: true }, ADMIN);

        expect(saved.name).toBe("Jane Smith");
        expect(saved.aliases).toEqual(["Jane Doe"]);
    });

    it("do not keep the old name after a plain rename", () => {
        const id = givenJane();

        expect(updateTag(id, { name: "Jane Do" }, ADMIN).aliases).toEqual([]);
    });

    it("refuse a rename onto another tag's alias", () => {
        const id = givenJane();
        updateTag(id, { aliases: ["Jane Smith"] }, ADMIN);
        const other = createTag({ kind: "performer", name: "J", scope: "public" }, ADMIN).id;

        expect(() => updateTag(other, { name: "jane smith" }, ADMIN)).toThrow(
            "already an alias of Jane Doe"
        );
    });

    it("refuse to be coined as a tag of their own", () => {
        const id = givenJane();
        updateTag(id, { aliases: ["Jane Smith"] }, ADMIN);

        expect(() =>
            createTag({ kind: "performer", name: "Jane Smith", scope: "public" }, ANNA)
        ).toThrow(ConflictError);
    });

    it("keep the folded name when a merge asks to", () => {
        const doe = givenJane();
        const smith = createTag(
            { kind: "performer", name: "Jane Smith", scope: "public" },
            ADMIN
        ).id;

        mergeTags(smith, doe, ADMIN, true);

        expect(updateTag(doe, {}, ADMIN).aliases).toEqual(["Jane Smith"]);
    });

    it("fold a publish into the library tag that has the name as an alias", () => {
        const mine = createTag({ kind: "tag", name: "Jane Smith", scope: "private" }, ANNA).id;
        // A performer cannot be private, so the library's alias here is on a plain tag.
        const library = createTag({ kind: "tag", name: "Jane Doe", scope: "public" }, ADMIN).id;
        updateTag(library, { aliases: ["Jane Smith"] }, ADMIN);
        applyTags(
            "m1",
            { kind: "tag", names: ["Jane Smith"], scope: "private", mode: "add" },
            ANNA
        );

        publishTag(mine, ANNA);

        expect(libraryTags("m1")).toEqual(["Jane Doe"]);
    });
});

describe("moving a tag to another facet", () => {
    it("moves it, which is what the facet control always claimed to do", () => {
        const id = createTag({ kind: "tag", name: "Jane Doe", scope: "public" }, ADMIN).id;
        applyTags("m1", { kind: "tag", names: ["Jane Doe"], scope: "public", mode: "add" }, ANNA);
        reindexed = [];

        const saved = updateTag(id, { kind: "performer" }, ADMIN);

        expect(saved.kind).toBe("performer");
        // The search document files performers in their own column, so it has to be rebuilt.
        expect(reindexed).toEqual(["m1"]);
    });

    it("refuses when the destination already has a tag of that name", () => {
        createTag({ kind: "performer", name: "Jane Doe", scope: "public" }, ADMIN);
        const id = createTag({ kind: "tag", name: "jane doe", scope: "public" }, ADMIN).id;

        expect(() => updateTag(id, { kind: "performer" }, ADMIN)).toThrow(/cannot move there/);
        expect(tags.find((row) => row.id === id)?.kind).toBe("tag");
    });

    it("refuses when one of its aliases is taken in the destination", () => {
        const performer = createTag({ kind: "performer", name: "J", scope: "public" }, ADMIN).id;
        updateTag(performer, { aliases: ["Jane Smith"] }, ADMIN);
        const id = createTag({ kind: "tag", name: "Jane Doe", scope: "public" }, ADMIN).id;
        updateTag(id, { aliases: ["Jane Smith"] }, ADMIN);

        expect(() => updateTag(id, { kind: "performer" }, ADMIN)).toThrow("already an alias of J");
    });

    it("refuses to move a private tag out of the one facet that can be private", () => {
        const id = createTag({ kind: "tag", name: "mine", scope: "private" }, ANNA).id;

        expect(() => updateTag(id, { kind: "performer" }, ANNA)).toThrow(ValidationError);
    });

    it("is a curator's change, like a rename", () => {
        const id = createTag({ kind: "tag", name: "Jane Doe", scope: "public" }, ADMIN).id;

        expect(() => updateTag(id, { kind: "performer" }, ANNA)).toThrow(AuthorizationError);
    });
});

describe("browsing and a tag's page", () => {
    const browse = (auth: AuthContext, scope: "public" | "private" = "public") =>
        browseTags({ kind: "performer", scope, sort: "count", page: 0, seed: 1 }, auth);

    it("leaves out of a strip the items this viewer cannot open", () => {
        applyTags("m1", { kind: "performer", names: ["Dad"], scope: "public", mode: "add" }, ANNA);
        applyTags("m2", { kind: "performer", names: ["Dad"], scope: "public", mode: "add" }, ANNA);
        visibleMedia = new Set(["m1"]);

        expect(browse(BEN).rows[0].strip.map((item) => item.id)).toEqual(["m1"]);
    });

    it("carries each tag's aliases, so a row can show its other names", () => {
        applyTags("m1", { kind: "performer", names: ["Dad"], scope: "public", mode: "add" }, ANNA);
        updateTag(tags[0].id, { aliases: ["Pops"] }, ADMIN);

        expect(browse(BEN).rows[0].tag.aliases).toEqual(["Pops"]);
    });

    it("shows a private tag's page to its owner and to nobody else", () => {
        applyTags("m1", { kind: "tag", names: ["Mine"], scope: "private", mode: "add" }, ANNA);
        const id = tags[0].id;

        expect(getTagProfile(id, 1, ANNA).tag.name).toBe("Mine");
        expect(() => getTagProfile(id, 1, BEN)).toThrow(NotFoundError);
        expect(() => getTagProfile(id, 1, ADMIN)).toThrow(NotFoundError);
    });

    it("lets anybody favourite a tag they can see, for themselves alone", () => {
        applyTags("m1", { kind: "performer", names: ["Dad"], scope: "public", mode: "add" }, ANNA);
        const id = tags[0].id;

        expect(setTagFavorite(id, true, BEN)).toEqual({ favorite: true });
        expect(getTagProfile(id, 1, BEN).favorite).toBe(true);
        expect(getTagProfile(id, 1, ANNA).favorite).toBe(false);
    });

    it("draws the picture as the first of the shuffled shelf, from one sample", () => {
        applyTags("m1", { kind: "performer", names: ["Dad"], scope: "public", mode: "add" }, ANNA);
        applyTags("m2", { kind: "performer", names: ["Dad"], scope: "public", mode: "add" }, ANNA);
        visibleMedia = new Set(["m2"]);

        const profile = getTagProfile(tags[0].id, 1, BEN);

        expect(profile.shelves.shuffled.map((item) => item.id)).toEqual(["m2"]);
        expect(profile.hero?.id).toBe("m2");
    });

    /**
     * "Appears with" is its own request (§20): the page must not wait on it, so the profile
     * must not so much as ask.
     */
    it("leaves who appears with a performer out of the profile", () => {
        applyTags("m1", { kind: "performer", names: ["Dad"], scope: "public", mode: "add" }, ANNA);
        companionRows = [{ tagId: "x", name: "Mum", shared: 1 }];

        const profile = getTagProfile(tags[0].id, 1, BEN);

        expect(profile).not.toHaveProperty("companions");
        expect(companionCalls).toBe(0);
    });

    it("answers a performer's companions, strips only for the first few and only what is visible", () => {
        applyTags("m1", { kind: "performer", names: ["Dad"], scope: "public", mode: "add" }, ANNA);
        visibleMedia = new Set(["m1"]);
        companionRows = Array.from({ length: COMPANION_STRIPS + 2 }, (_, index) => ({
            tagId: `c${index}`,
            name: `Companion ${index}`,
            shared: 10 - index,
        }));
        sharedSamples = new Map(companionRows.map((row) => [row.tagId, ["m1", "m2"]]));

        const { companions } = getTagCompanions(tags[0].id, 1, BEN);

        expect(companions.map((row) => row.tagId)).toEqual(companionRows.map((row) => row.tagId));
        // m2 is in a library this viewer cannot open, so it never reaches a strip.
        expect(companions[0].strip.map((item) => item.id)).toEqual(["m1"]);
        expect(companions[COMPANION_STRIPS].strip).toEqual([]);
    });

    it("asks nothing for a tag that cannot have companions", () => {
        applyTags("m1", { kind: "tag", names: ["Beach"], scope: "public", mode: "add" }, ANNA);
        applyTags("m1", { kind: "performer", names: ["Me"], scope: "private", mode: "add" }, ANNA);
        companionRows = [{ tagId: "x", name: "Mum", shared: 1 }];

        expect(getTagCompanions(tags[0].id, 1, BEN)).toEqual({ companions: [] });
        expect(getTagCompanions(tags[1].id, 1, ANNA)).toEqual({ companions: [] });
        expect(companionCalls).toBe(0);
    });

    /** The second request must not confirm what the first one denies. */
    it("keeps somebody else's private tag not found on the companions request too", () => {
        applyTags("m1", { kind: "performer", names: ["Me"], scope: "private", mode: "add" }, ANNA);

        expect(() => getTagCompanions(tags[0].id, 1, BEN)).toThrow(NotFoundError);
        expect(() => getTagCompanions("missing", 1, BEN)).toThrow(NotFoundError);
    });

    /** Favouriting must not become a way to confirm somebody else's private tag exists. */
    it("refuses a favourite on somebody else's private tag as not found", () => {
        applyTags("m1", { kind: "tag", names: ["Mine"], scope: "private", mode: "add" }, ANNA);
        const id = tags[0].id;

        expect(() => setTagFavorite(id, true, BEN)).toThrow(NotFoundError);
        expect(() => setTagFavorite(id, true, ADMIN)).toThrow(NotFoundError);
        expect(favorites.size).toBe(0);
    });

    it("browses only the caller's own private vocabulary", () => {
        applyTags("m1", { kind: "tag", names: ["Mine"], scope: "private", mode: "add" }, ANNA);

        expect(
            browseTags({ kind: "tag", scope: "private", sort: "count", page: 0, seed: 1 }, BEN).rows
        ).toEqual([]);
    });
});
