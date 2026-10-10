import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../auth/withAuth";

/**
 * History and undo (§5f "Decisions you can take back"): who may, what an undo takes back, and
 * what "Wrong" adds for the app's own tags.
 */

const state = vi.hoisted(() => ({
    decisions: new Map<string, Record<string, unknown>>(),
    undone: [] as string[],
    batchesUndone: [] as string[],
    batches: new Map<string, { id: string; undoneAt: string | null; items: string[] }>(),
    notThem: [] as unknown[][],
    jobs: [] as string[],
}));

vi.mock("@private-stock/db", () => ({
    db: { transaction: <T>(fn: () => T) => fn },
    faceDecisionRepo: {
        find: (id: string) => state.decisions.get(id),
        undo: (id: string) => {
            state.undone.push(id);
            return { faces: 1, refusals: 0, items: 0, scattered: 0 };
        },
        page: () => [...state.decisions.values()],
        sampleFaceIds: () => [],
        batchItems: () => [],
    },
    faceAutoTagRepo: { find: () => undefined },
    faceRepo: { shownFaces: () => [] },
    jobRepo: { enqueueKind: (kind: string) => state.jobs.push(kind) },
    searchRepo: { requestReindex: () => undefined },
    tagBatchRepo: {
        findById: (id: string) => state.batches.get(id),
        affectedMediaIds: (id: string) => state.batches.get(id)?.items ?? [],
        affectedTagIds: () => ["jane"],
        undo: (id: string) => {
            state.batchesUndone.push(id);
            return 1;
        },
    },
}));

vi.mock("./notThem", () => ({ notThem: (...args: unknown[]) => state.notThem.push(args) }));
vi.mock("./ocrMatchHooks", () => ({ batchUndone: () => undefined }));
vi.mock("./faceService", () => ({ reviewFace: () => [] }));

const { faceHistory, undoFaceDecision } = await import("./faceHistoryService");

const admin: AuthContext = {
    userId: "u1",
    email: "u1@example.test",
    displayName: "U",
    scopes: ["admin"],
    accessibleRootIds: ["r1"],
    tokenEpoch: 0,
};

const decision = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    actor: "user",
    userId: "u1",
    verdict: "is",
    tagId: "jane",
    tagName: "Jane",
    surface: "review",
    tagBatchId: null,
    faceCount: 3,
    itemCount: 2,
    createdAt: "2026-10-10 10:00:00",
    undoneAt: null,
    ...extra,
});

beforeEach(() => {
    state.decisions = new Map();
    state.undone = [];
    state.batchesUndone = [];
    state.batches = new Map();
    state.notThem = [];
    state.jobs = [];
});

describe("undo", () => {
    it("takes back what a decision wrote, and the tag batch it made while that still stands", () => {
        state.decisions.set("d1", decision("d1", { tagBatchId: "b1" }));
        state.batches.set("b1", { id: "b1", undoneAt: null, items: ["m1", "m2"] });

        undoFaceDecision("d1", { wrong: false }, admin);

        expect(state.undone).toEqual(["d1"]);
        expect(state.batchesUndone).toEqual(["b1"]);
        expect(state.notThem).toEqual([]);
        expect(state.jobs).toContain("faceAnchors");
    });

    it("leaves a batch already withdrawn alone, and refuses to undo twice", () => {
        state.decisions.set("d1", decision("d1", { tagBatchId: "b1" }));
        state.batches.set("b1", { id: "b1", undoneAt: "2026-10-10 11:00:00", items: [] });

        undoFaceDecision("d1", { wrong: false }, admin);

        expect(state.batchesUndone).toEqual([]);

        state.decisions.set("d2", decision("d2", { undoneAt: "2026-10-10 12:00:00" }));

        expect(() => undoFaceDecision("d2", { wrong: false }, admin)).toThrow(/already/);
        expect(() => undoFaceDecision("nope", { wrong: false }, admin)).toThrow(/not there/);
    });

    it("says not them on the items of an app's tag marked wrong", () => {
        state.decisions.set(
            "a1",
            decision("a1", { actor: "app", surface: "auto", tagBatchId: "b1" })
        );
        state.batches.set("b1", { id: "b1", undoneAt: null, items: ["m1", "m2"] });

        undoFaceDecision("a1", { wrong: true }, admin);

        expect(state.notThem).toEqual([[["m1", "m2"], "jane", "u1", "history"]]);
    });

    it("is for administrators only", () => {
        state.decisions.set("d1", decision("d1"));

        expect(() => undoFaceDecision("d1", { wrong: false }, { ...admin, scopes: [] })).toThrow(
            /administrator/
        );
        expect(() => faceHistory({ actor: "all", limit: 30 }, { ...admin, scopes: [] })).toThrow(
            /administrator/
        );
    });
});

describe("History", () => {
    it("lists decisions with who they were about, and where the next page starts", () => {
        state.decisions.set("d1", decision("d1"));
        state.decisions.set("d2", decision("d2", { createdAt: "2026-10-10 09:00:00" }));

        const page = faceHistory({ actor: "all", limit: 1 }, admin);

        expect(page.entries).toEqual([
            expect.objectContaining({ id: "d1", performer: { id: "jane", name: "Jane" } }),
        ]);
        expect(page.next).toBe("2026-10-10 10:00:00|d1");
    });
});
