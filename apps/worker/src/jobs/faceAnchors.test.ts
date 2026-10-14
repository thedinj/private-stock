import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
    EMBED_DIMS,
    FACE_ANCHORS_REL_PATH,
    decodeFaceAnchors,
    encodeVectorFile,
    faceFileRelPath,
    normaliseVector,
    quantize,
} from "@private-stock/core";

/**
 * Every performer's face reference, and every face's best match (§5f "One face, one score"): from
 * confirmations, from the face their tagged items share, and never a reference of one item.
 * Real faces files in a temporary data directory; the rows are stood in for.
 */

const dataDir = mkdtempSync(path.join(tmpdir(), "ps-faceanchors-"));

const state = vi.hoisted(() => ({
    decisions: [] as unknown[],
    /** The FaceAppearance table, by id. */
    appearances: new Map<
        string,
        {
            id: string;
            mediaId: string;
            faceIds: string[];
            bestFaceId: string;
            legible: boolean;
            matchTagId: string | null;
            score: number | null;
            second: number | null;
            newPersonId: string | null;
        }
    >(),
    /** The FaceAnchor table, by tag. */
    anchors: new Map<
        string,
        { tagId: string; items: number; confirmedItems: number; sharedItems: number }
    >(),
    confirmed: [] as { tagId: string; mediaId: string; vectorIndex: number }[],
    tagged: [] as { tagId: string; faceId: string; mediaId: string; vectorIndex: number }[],
    faces: [] as { id: string; mediaId: string; vectorIndex: number; decided?: 0 | 1 }[],
    stale: { tags: [] as string[], items: [] as string[] },
    /** What each run asked for and wrote, in order. */
    sourced: [] as (string[] | null)[],
    writes: [] as { removed: string[]; added: unknown[]; rescored: unknown[] }[],
    failWrite: false,
    candidates: [] as Record<string, unknown>[],
    counts: { proposed: 0, right: 0, wrong: 0, applied: 0, removed: 0 },
    trial: { right: 30, wrong: 0 },
    setting: {} as Record<string, unknown>,
    decided: [] as string[][],
    batches: [] as { assignments: unknown[]; source: string; userId: string }[],
}));

const only = <T extends Record<K, string>, K extends string>(
    rows: readonly T[],
    key: K,
    ids: readonly string[] | null
): T[] => (ids === null ? [...rows] : rows.filter((row) => ids.includes(row[key])));

vi.mock("@private-stock/db", () => ({
    db: { transaction: <T>(fn: () => T) => fn },
    // A press runs its writes, as one decision (§5f "Decisions you can take back").
    faceDecisionRepo: {
        record: (decision: unknown, write: () => unknown) => {
            state.decisions.push(decision);
            return { decisionId: "d1", result: write() };
        },
    },
    faceAutoTagRepo: {
        candidates: () => state.candidates,
        replaceProposals: () => undefined,
        counts: () => state.counts,
        trial: () => state.trial,
        decide: (mediaId: string, tagId: string, verdict: string) =>
            state.decided.push([mediaId, tagId, verdict]),
    },
    settingRepo: { get: () => state.setting },
    tagRepo: { findById: (id: string) => ({ id, name: id }) },
    tagBatchRepo: {
        applyAssignments: (input: { assignments: unknown[]; source: string; userId: string }) => {
            state.batches.push(input);
            return { batchId: "b", assigned: input.assignments.length };
        },
    },
    searchRepo: { requestReindex: () => undefined },
    appearanceRepo: {
        sourceFaces: (mediaIds: string[] | null) => {
            state.sourced.push(mediaIds);

            return only(state.faces, "mediaId", mediaIds)
                .sort((a, b) =>
                    a.mediaId === b.mediaId
                        ? a.vectorIndex - b.vectorIndex
                        : a.mediaId < b.mediaId
                          ? -1
                          : 1
                )
                .map((face) => ({
                    ...face,
                    eyes: 30,
                    score: 0.9,
                    kind: "video",
                    scattered: 0,
                    decided: face.decided ?? 0,
                }));
        },
        writtenAppearances: () => [...state.appearances.values()].map((row) => ({ ...row })),
        writeAppearances: (changes: {
            removed: string[];
            added: (typeof state.appearances extends Map<string, infer R> ? R : never)[];
            rescored: { id: string }[];
        }) => {
            if (state.failWrite) throw new Error("disk full");

            state.writes.push(changes);
            for (const id of changes.removed) state.appearances.delete(id);
            for (const row of changes.added) state.appearances.set(row.id, { ...row });
            for (const row of changes.rescored) {
                Object.assign(state.appearances.get(row.id)!, row);
            }
        },
    },
    changeLogRepo: { recordMany: () => undefined },
    faceRepo: {
        takeStale: () => {
            const stale = state.stale;
            state.stale = { tags: [], items: [] };
            return stale;
        },
        confirmedFaceRefs: (tagIds: string[] | null) => only(state.confirmed, "tagId", tagIds),
        taggedFaceRefs: (_perTag: number, tagIds: string[] | null) =>
            only(state.tagged, "tagId", tagIds),
        performersOn: (mediaIds: string[]) => [
            ...new Set(only(state.tagged, "mediaId", mediaIds).map((row) => row.tagId)),
        ],
        anchorRows: () => [...state.anchors.values()],
        writeAnchors: (
            changed: {
                tagId: string;
                items: number;
                confirmedItems: number;
                sharedItems: number;
            }[],
            removed: string[]
        ) => {
            for (const tagId of removed) state.anchors.delete(tagId);
            for (const row of changed) state.anchors.set(row.tagId, { ...row });
        },
    },
}));

vi.mock("@private-stock/core/server", async (original) => ({
    ...(await original<typeof import("@private-stock/core/server")>()),
    loadConfig: () => ({ dataDir }),
}));

vi.mock("../queue.js", () => ({ enqueue: vi.fn() }));
vi.mock("../eventLoop.js", () => ({ breathe: async (since: number) => since }));

const { forgetFaceReferences, runFaceAnchors } = await import("./faceAnchors.js");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** Somebody's face: mostly one axis, with a little of another so no two are identical. */
const faceOf = (who: number, wobble: number): Float32Array => {
    const vector = new Float32Array(EMBED_DIMS);

    vector[who] = 1;
    vector[100 + wobble] = 0.2;

    return normaliseVector(vector);
};

/** An item with these people's faces, written to disk and registered. */
const item = (
    mediaId: string,
    people: number[],
    faceFor: (who: number, i: number) => Float32Array = (who, i) => faceOf(who, i + mediaId.length)
): void => {
    const file = path.join(dataDir, faceFileRelPath(mediaId));

    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
        file,
        encodeVectorFile({
            model: "face-rec-arcface-r50",
            stageVersion: 1,
            dims: EMBED_DIMS,
            vectors: people.map((who, i) => ({
                atMs: 0,
                square: 0,
                vector: quantize(faceFor(who, i)),
            })),
            representatives: [],
        })
    );
    people.forEach((_, vectorIndex) =>
        state.faces.push({ id: `${mediaId}-${vectorIndex}`, mediaId, vectorIndex })
    );
};

const tag = (tagId: string, mediaId: string, count: number): void => {
    for (let vectorIndex = 0; vectorIndex < count; vectorIndex++) {
        state.tagged.push({ tagId, faceId: `${mediaId}-${vectorIndex}`, mediaId, vectorIndex });
    }
};

beforeEach(() => {
    forgetFaceReferences();
    state.confirmed = [];
    state.tagged = [];
    state.faces = [];
    state.anchors = new Map();
    state.appearances = new Map();
    state.stale = { tags: [], items: [] };
    state.sourced = [];
    state.writes = [];
    state.failWrite = false;
    state.candidates = [];
    state.trial = { right: 30, wrong: 0 };
    state.counts = { proposed: 0, right: 0, wrong: 0, applied: 0, removed: 0 };
    state.setting = {};
    state.decided = [];
    state.decisions = [];
    state.batches = [];
});

/** The people of an item, as the table holds them. */
const peopleOf = (mediaId: string) =>
    [...state.appearances.values()].filter((person) => person.mediaId === mediaId);

/** The tables as a run from nothing would leave them, ids aside: what any run must agree with. */
const tables = () => ({
    anchors: [...state.anchors.values()].sort((a, b) => (a.tagId < b.tagId ? -1 : 1)),
    people: [...state.appearances.values()]
        .map(({ id: _id, newPersonId, ...row }) => ({ ...row, newPerson: newPersonId !== null }))
        .sort((a, b) => (a.bestFaceId < b.bestFaceId ? -1 : 1)),
});

describe("face references", () => {
    it("finds a performer's face from their tags alone, partners and all", async () => {
        // Jane (1) is in every item; each item has somebody else as well.
        item("a1", [1, 5]);
        item("a2", [1, 6]);
        item("a3", [1, 7]);
        item("stranger", [9, 9]);
        item("lookalike", [1, 1]);
        for (const id of ["a1", "a2", "a3"]) tag("jane", id, 2);

        await runFaceAnchors();

        expect([...state.anchors.values()]).toEqual([
            { tagId: "jane", items: 3, confirmedItems: 0, sharedItems: 3 },
        ]);
        expect(peopleOf("lookalike")[0].matchTagId).toBe("jane");
        expect(peopleOf("lookalike")[0].score).toBeGreaterThan(0.9);
        expect(peopleOf("stranger")[0].score ?? 0).toBeLessThan(0.3);

        const file = decodeFaceAnchors(
            new Uint8Array(readFileSync(path.join(dataDir, FACE_ANCHORS_REL_PATH)))
        );

        expect(file.map((a) => a.tagId)).toEqual(["jane"]);
    });

    it("gathers each item's people, and scores each against the references", async () => {
        item("a1", [1, 5]);
        item("a2", [1, 6]);
        item("a3", [1, 7]);
        // Jane twice, a stranger twice, and somebody seen once.
        item("both", [1, 1, 9, 9, 8]);
        for (const id of ["a1", "a2", "a3"]) tag("jane", id, 2);

        await runFaceAnchors();

        const people = peopleOf("both");

        expect(people.map((person) => person.faceIds)).toEqual([
            ["both-0", "both-1"],
            ["both-2", "both-3"],
        ]);
        expect(people[0].matchTagId).toBe("jane");
        expect(people[0].score).toBeGreaterThan(0.9);
        expect(people[1].score ?? 0).toBeLessThan(0.3);
    });

    it("gathers people who match nobody, seen on enough items, into a new person", async () => {
        item("s1", [8, 8]);
        item("s2", [8, 8]);
        item("s3", [8, 8]);
        // Seen on two items only: a face in passing.
        item("t1", [9, 9]);
        item("t2", [9, 9]);

        await runFaceAnchors();

        const of = (prefix: string) =>
            new Set(
                [...state.appearances.values()]
                    .filter((person) => person.mediaId.startsWith(prefix))
                    .map((person) => person.newPersonId)
            );

        expect(of("s").size).toBe(1);
        expect([...of("s")][0]).not.toBeNull();
        expect([...of("t")]).toEqual([null]);
    });

    it("keeps out a tags' face that is not the one people confirmed", async () => {
        // Kim is always tagged with her partner (2); people confirmed Kim's own face (3).
        item("k1", [2, 3]);
        item("k2", [2, 3]);
        item("k3", [2, 2]);
        item("k4", [2, 2]);
        for (const id of ["k1", "k2", "k3", "k4"]) tag("kim", id, 2);
        state.confirmed = [
            { tagId: "kim", mediaId: "k1", vectorIndex: 1 },
            { tagId: "kim", mediaId: "k2", vectorIndex: 1 },
        ];

        await runFaceAnchors();

        // Two confirmed items are not enough, and the partner's face is not borrowed to make up.
        expect([...state.anchors.values()]).toEqual([]);
        expect([...state.appearances.values()].every((p) => p.matchTagId === null)).toBe(true);
    });

    describe("only what changed (§5f)", () => {
        /** How many faces an item was given. */
        const faceCount = (mediaId: string): number =>
            state.faces.filter((face) => face.mediaId === mediaId).length;

        /** A library with two performers and a few strangers, run once from nothing. */
        const library = async (): Promise<void> => {
            item("a1", [1, 1, 5, 5]);
            item("a2", [1, 1, 6]);
            item("a3", [1, 7, 7]);
            item("b1", [2, 2]);
            item("b2", [2, 2, 1]);
            item("b3", [2, 2]);
            item("x1", [3, 3]);
            item("x2", [3, 3]);
            item("x3", [3, 3, 4, 4]);
            item("x4", [4, 4]);
            for (const id of ["a1", "a2", "a3"]) tag("jane", id, faceCount(id));
            for (const id of ["b1", "b2", "b3"]) tag("kim", id, faceCount(id));

            await runFaceAnchors();
        };

        /** After a run that did only what changed, one from nothing must find nothing to do. */
        const agreesWithAFullRun = async (): Promise<void> => {
            const after = tables();

            forgetFaceReferences();
            state.writes = [];
            await runFaceAnchors();

            expect(tables()).toEqual(after);
            expect(state.writes).toEqual([{ removed: [], added: [], rescored: [] }]);
        };

        it("writes nothing, and reads nothing, when nothing changed", async () => {
            await library();
            const before = tables();

            state.writes = [];
            state.sourced = [];
            await runFaceAnchors();

            expect(state.sourced).toEqual([[]]);
            expect(state.writes).toEqual([]);
            expect(tables()).toEqual(before);
        });

        it("names a new person and rescores everybody against them alone", async () => {
            await library();
            expect(peopleOf("x1")[0].newPersonId).not.toBeNull();

            // Somebody names the stranger (3): a face of theirs confirmed on three items.
            state.confirmed = ["x1", "x2", "x3"].map((mediaId) => ({
                tagId: "lee",
                mediaId,
                vectorIndex: 0,
            }));
            for (const mediaId of ["x1", "x2", "x3"]) {
                state.faces.find((face) => face.id === `${mediaId}-0`)!.decided = 1;
            }
            state.stale = { tags: ["lee"], items: ["x1", "x2", "x3"] };
            state.sourced = [];
            await runFaceAnchors();

            expect(state.sourced).toEqual([["x1", "x2", "x3"]]);
            expect(state.anchors.get("lee")).toMatchObject({ items: 3, confirmedItems: 3 });
            expect(peopleOf("x1")[0]).toMatchObject({ matchTagId: "lee", newPersonId: null });
            expect(peopleOf("x4")[0].matchTagId).not.toBe("lee");

            await agreesWithAFullRun();
        });

        it("follows a reference that went, and came back with an item more", async () => {
            await library();

            // Kim's tag taken off one item: on two items, her reference goes.
            state.tagged = state.tagged.filter((row) => row.mediaId !== "b3");
            state.stale = { tags: ["kim"], items: [] };
            await runFaceAnchors();

            expect(state.anchors.has("kim")).toBe(false);
            expect(peopleOf("b1")[0].matchTagId).toBe("jane");
            await agreesWithAFullRun();

            item("b4", [2, 2]);
            for (const id of ["b3", "b4"]) tag("kim", id, 2);
            state.stale = { tags: ["kim"], items: ["b4"] };
            await runFaceAnchors();

            expect(state.anchors.get("kim")).toMatchObject({ items: 4 });
            expect(peopleOf("b1")[0].matchTagId).toBe("kim");
            await agreesWithAFullRun();
        });

        it("rescores the people a moved reference was runner-up for", async () => {
            await library();

            // Jane gains confirmed faces of somebody else (4) as well: her centre moves, and
            // she is runner-up for most people.
            state.confirmed = ["x3", "x4"].map((mediaId) => ({
                tagId: "jane",
                mediaId,
                vectorIndex: mediaId === "x3" ? 2 : 0,
            }));
            state.stale = { tags: ["jane"], items: [] };
            await runFaceAnchors();

            await agreesWithAFullRun();
        });

        it("gathers an item again when its faces change, keeping who was the same", async () => {
            await library();
            const kept = peopleOf("a1").map((person) => person.id);

            // The stage found a third person on a2.
            state.faces = state.faces.filter((face) => face.mediaId !== "a2");
            item("a2", [1, 1, 6, 8, 8]);
            state.stale = { tags: [], items: ["a2"] };
            await runFaceAnchors();

            expect(peopleOf("a1").map((person) => person.id)).toEqual(kept);
            expect(peopleOf("a2").map((person) => person.faceIds)).toEqual([
                ["a2-0", "a2-1"],
                ["a2-3", "a2-4"],
            ]);
            await agreesWithAFullRun();
        });

        it("forgets an item that is gone", async () => {
            await library();

            state.faces = state.faces.filter((face) => face.mediaId !== "x4");
            state.stale = { tags: [], items: ["x4"] };
            await runFaceAnchors();

            expect(peopleOf("x4")).toEqual([]);
            await agreesWithAFullRun();
        });

        it.each([1, 2, 3, 4, 5, 6, 7, 8])(
            "agrees with a run from nothing after many changes, on faces that are alike (%i)",
            async (seed) => {
                // A seeded generator, so a failure can be run again.
                let s = seed * 0x9e3779b9;
                const random = (): number => {
                    s = (s + 0x6d2b79f5) | 0;
                    let t = Math.imul(s ^ (s >>> 15), 1 | s);
                    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
                };
                const gaussian = (): number =>
                    Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random());
                const identities = Array.from({ length: 10 }, () =>
                    normaliseVector(Float32Array.from({ length: EMBED_DIMS }, gaussian))
                );
                // Each face its person plus noise: alike enough to gather, unlike enough to tie never.
                const faceFor = (who: number): Float32Array =>
                    normaliseVector(identities[who].map((value) => value + gaussian() * 0.04));
                const performers = ["p0", "p1", "p2", "p3", "p4"];
                let next = 0;
                const addItem = (): string => {
                    const mediaId = `r${seed}-${next++}`;
                    const people = [Math.floor(random() * 10), Math.floor(random() * 10)];
                    const faces = people.flatMap((who) =>
                        Array.from({ length: 2 + Math.floor(random() * 2) }, () => who)
                    );

                    item(mediaId, faces, faceFor);
                    // An item carries the performers among its people.
                    for (const who of new Set(people)) {
                        if (who < performers.length) {
                            faces.forEach((_, vectorIndex) =>
                                state.tagged.push({
                                    tagId: performers[who],
                                    faceId: `${mediaId}-${vectorIndex}`,
                                    mediaId,
                                    vectorIndex,
                                })
                            );
                        }
                    }

                    return mediaId;
                };

                for (let i = 0; i < 30; i++) addItem();
                await runFaceAnchors();

                for (let round = 0; round < 12; round++) {
                    const stale = { tags: [] as string[], items: [] as string[] };
                    const ids = [...new Set(state.faces.map((face) => face.mediaId))];
                    const pick = ids[Math.floor(random() * ids.length)];
                    const action = Math.floor(random() * 4);

                    if (action === 0) {
                        // A face confirmed as somebody, rightly or not.
                        const face = state.faces.find((f) => f.mediaId === pick)!;
                        const tagId = performers[Math.floor(random() * performers.length)];

                        state.confirmed.push({
                            tagId,
                            mediaId: pick,
                            vectorIndex: face.vectorIndex,
                        });
                        face.decided = 1;
                        stale.tags.push(tagId);
                        stale.items.push(pick);
                    } else if (action === 1) {
                        // An item's performers taken off.
                        stale.tags.push(
                            ...state.tagged.filter((r) => r.mediaId === pick).map((r) => r.tagId)
                        );
                        state.tagged = state.tagged.filter((r) => r.mediaId !== pick);
                    } else if (action === 2) {
                        stale.items.push(addItem(), addItem());
                    } else {
                        // An item gone, and its faces and tags with it — whose triggers name
                        // its performers.
                        stale.tags.push(
                            ...state.tagged.filter((r) => r.mediaId === pick).map((r) => r.tagId)
                        );
                        state.faces = state.faces.filter((f) => f.mediaId !== pick);
                        state.tagged = state.tagged.filter((r) => r.mediaId !== pick);
                        state.confirmed = state.confirmed.filter((r) => {
                            if (r.mediaId === pick) stale.tags.push(r.tagId);
                            return r.mediaId !== pick;
                        });
                        stale.items.push(pick);
                    }

                    state.stale = { tags: [...new Set(stale.tags)], items: stale.items };
                    await runFaceAnchors();
                }

                expect(state.anchors.size).toBeGreaterThan(0);
                await agreesWithAFullRun();
            }
        );

        it("starts again from the tables after a run that failed", async () => {
            await library();

            state.failWrite = true;
            state.stale = { tags: [], items: ["x4"] };
            await expect(runFaceAnchors()).rejects.toThrow("disk full");

            state.failWrite = false;
            state.sourced = [];
            await runFaceAnchors();

            expect(state.sourced).toEqual([null]);
        });
    });

    describe("tagging by itself", () => {
        const proposal = (mediaId: string, tagId: string) => ({
            mediaId,
            tagId,
            faceId: `${mediaId}-0`,
            kind: "video",
            bestScore: 0.7,
            strongFaces: 3,
            named: 0,
            anchorItems: 6,
        });

        beforeEach(() => {
            item("xx", [1]);
            state.candidates = [proposal("x", "jane"), proposal("y", "jane"), proposal("z", "kim")];
        });

        it("only proposes until an administrator lets it tag", async () => {
            await runFaceAnchors();

            expect(state.batches).toEqual([]);
        });

        it("tags one batch per performer, made by faces, in the undo list of whoever allowed it", async () => {
            state.setting = { enabled: true, byUserId: "admin-1" };

            await runFaceAnchors();

            expect(state.batches.map((b) => [b.userId, b.source, b.assignments.length])).toEqual([
                ["admin-1", "ai", 2],
                ["admin-1", "ai", 1],
            ]);
            expect(state.decided.map((d) => d[2])).toEqual(["applied", "applied", "applied"]);
            // Each performer's batch is the app's own decision, undone in History with "Wrong".
            expect(state.decisions).toEqual([
                expect.objectContaining({ actor: "app", verdict: "is", surface: "auto" }),
                expect.objectContaining({ actor: "app", verdict: "is", surface: "auto" }),
            ]);
        });

        it("proposes, and does not tag, until its own trial is passed with none wrong", async () => {
            state.setting = { enabled: true, byUserId: "admin-1" };
            state.trial = { right: 29, wrong: 0 };

            await runFaceAnchors();

            expect(state.batches).toEqual([]);

            state.trial = { right: 40, wrong: 1 };

            await runFaceAnchors();

            expect(state.batches).toEqual([]);
        });

        it("never tags a photograph, or a person seen fewer than three times", async () => {
            state.setting = { enabled: true, byUserId: "admin-1" };
            state.candidates = [
                { ...proposal("photo", "jane"), kind: "image" },
                { ...proposal("brief", "jane"), strongFaces: 2 },
            ];

            await runFaceAnchors();

            expect(state.batches).toEqual([]);
        });

        it("stops when too much of what it tagged was taken back", async () => {
            state.setting = { enabled: true, byUserId: "admin-1" };
            state.counts = { proposed: 0, right: 0, wrong: 0, applied: 95, removed: 5 };

            await runFaceAnchors();

            expect(state.batches).toEqual([]);
        });
    });
});
