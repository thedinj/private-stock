import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../auth/withAuth";

/**
 * The OCR match queue's decisions, and the pending counts they move (§5d "Counts", §20).
 *
 * An accept used to recount inside its own `BEGIN IMMEDIATE`: every string its items showed, a
 * few cold pages per pair on the NAS, all while holding the write lock. A run of accepts held it
 * for seconds at a time and froze the site. What is guarded here is the shape of the fix: the
 * decision is one transaction, the recount comes after it and outside any, it is asked for only
 * the pairs the decision can have moved, and a busy database at that point does not turn a
 * decision that landed into a failure. That the counts themselves come out right is the repo's
 * test (`ocrTagMatchRepo.test.ts`).
 */

const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

let inTransaction = false;
let events: string[] = [];
let recounts: { ids: string[]; inTransaction: boolean }[] = [];
let touching: { mediaIds: string[]; tagIds: string[] | null }[] = [];
let recountFails = false;
let enqueued: { kind: string; priority: number; delay: number }[] = [];

const pair = (id: string, tagId: string, extra: Record<string, unknown> = {}) => ({
    id,
    textNorm: "jane doe",
    tagId,
    tagName: tagId === "jane" ? "Jane Doe" : "Example Site",
    tagKind: tagId === "jane" ? "performer" : "source",
    kind: "exact",
    matchedText: "Jane Doe",
    score: 1,
    state: null,
    batchId: null,
    untagged: 2,
    ...extra,
});

let stored: ReturnType<typeof pair>[] = [];

/** Records a write and whether it ran inside the decision's transaction. */
const write = (name: string): void => {
    events.push(`${name}${inTransaction ? " (in transaction)" : ""}`);
};

vi.mock("./notThem", () => ({ notThem: vi.fn() }));

vi.mock("@private-stock/db", () => ({
    isBusyError: (error: unknown) => (error as { code?: string } | null)?.code === "SQLITE_BUSY",
    db: {
        transaction: <T>(run: () => T) => {
            const call = (): T => {
                inTransaction = true;

                try {
                    return run();
                } finally {
                    inTransaction = false;
                }
            };

            return Object.assign(call, { immediate: call, deferred: call });
        },
    },
    artifactRepo: { findEffectiveCover: () => undefined },
    mediaTextRepo: {},
    searchRepo: { requestReindex: () => write("reindex") },
    jobRepo: {
        enqueueKind: (kind: string, priority: number, delay: number) =>
            enqueued.push({ kind, priority, delay }),
    },
    tagRepo: {
        unassign: () => {
            write("unassign");

            return 1;
        },
        resolveName: () => undefined,
        ensureTag: () => {
            write("ensureTag");

            return "coined";
        },
    },
    tagBatchRepo: {
        applyAssignments: (input: { assignments: unknown[] }) => {
            write("applyAssignments");

            return { batchId: "b1", assigned: input.assignments.length };
        },
        affectedMediaIds: () => ["m1", "m2"],
    },
    ocrTagMatchRepo: {
        findPairs: (_textNorm: string, tagIds: string[]) =>
            stored.filter((row) => tagIds.includes(row.tagId)),
        findPairIds: (_textNorm: string, tagIds: string[]) =>
            stored
                .filter((row) => tagIds.includes(row.tagId))
                .map((row) => ({ id: row.id, tagId: row.tagId })),
        findById: (id: string) => stored.find((row) => row.id === id),
        pendingMediaIds: () => ["m1", "m2"],
        stringText: () => "Jane Doe",
        addSkips: () => write("addSkips"),
        decide: (ids: string[], state: string) => write(`decide ${state} ${ids.join(",")}`),
        ensureManual: (_textNorm: string, tagId: string) => {
            write("ensureManual");
            stored.push(pair("p-manual", tagId, { kind: "manual" }));
        },
        reopen: (ids: string[]) => {
            write("reopen");

            return ids;
        },
        reopenForBatch: () => {
            write("reopenForBatch");

            return ["p1"];
        },
        pairsTouching: (mediaIds: string[], tagIds: string[] | null) => {
            touching.push({ mediaIds, tagIds });

            return mediaIds.length === 0 ? [] : ["p-other"];
        },
        withdrawRuleTags: () => {
            write("withdrawRuleTags");

            return ["m3"];
        },
        applyRules: (ids: string[]) => {
            write(`applyRules ${ids.join(",")}`);

            return { mediaIds: [], tagIds: [] };
        },
        declineRules: (mediaIds: string[], tagIds: string[] | null) =>
            write(`declineRules ${mediaIds.join(",")} ${tagIds?.join(",")}`),
        findRuleTag: (id: string) =>
            id === "mt1"
                ? { id, mediaId: "m3", tagId: "jane", tagName: "Jane Doe", tagKind: "performer" }
                : undefined,
        recountPending: (ids: string[]) => {
            recounts.push({ ids: [...ids].sort(), inTransaction });

            if (recountFails) {
                throw busy();
            }

            return ids.length;
        },
    },
}));

vi.mock("./artService", () => ({ coverUrl: () => null }));

vi.mock("./ocrReviewService", () => ({
    requireAdmin: () => undefined,
    decodeCursor: () => null,
    encodeCursor: () => "",
    fileNameOf: () => "",
    frameFinder: () => () => null,
    isItemCursor: () => true,
    isStringCursor: () => true,
}));

// Withdrawing a batch is the bulk service's; what it owes the queue is the real hook.
vi.mock("./bulkTagService", async () => {
    const hooks = await import("./ocrMatchHooks");

    return {
        undoBulkTag: (batchId: string) => {
            write("undoBulkTag");
            hooks.batchUndone(batchId, ["m1", "m2"], ["jane"]);

            return { removed: 2 };
        },
    };
});

const service = await import("./ocrMatchService");

const auth: AuthContext = {
    userId: "u1",
    email: "a@b.c",
    displayName: "A",
    scopes: ["admin"],
    accessibleRootIds: ["root"],
    tokenEpoch: 0,
};

beforeEach(() => {
    inTransaction = false;
    events = [];
    recounts = [];
    touching = [];
    recountFails = false;
    enqueued = [];
    stored = [pair("p1", "jane"), pair("p2", "site", { matchedText: "examplesite" })];
});

describe("accepting on an item", () => {
    const input = {
        mediaId: "m1",
        matchIds: ["p1"],
        expectedCount: 2,
        excludeMediaIds: ["m2"],
    };

    it("decides in one transaction and recounts after it, outside any", () => {
        const result = service.acceptOnItem(input, auth);

        expect(result).toEqual({ tagged: 1, mediaIds: ["m1"], textNorm: "jane doe" });
        expect(events).toEqual([
            "applyAssignments (in transaction)",
            "addSkips (in transaction)",
            "decide accepted p1 (in transaction)",
            "reindex (in transaction)",
        ]);
        expect(recounts).toEqual([{ ids: ["p-other", "p1"], inTransaction: false }]);
    });

    it("recounts only the decided pair and that tag's pairs on the tagged items", () => {
        service.acceptOnItem(input, auth);

        expect(touching).toEqual([{ mediaIds: ["m1"], tagIds: ["jane"] }]);
    });

    it("never leaves the row's own item out", () => {
        const result = service.acceptOnItem({ ...input, excludeMediaIds: ["m1"] }, auth);

        expect(result.mediaIds).toEqual(["m1", "m2"]);
        expect(events).not.toContain("addSkips (in transaction)");
    });

    it("refuses when the strings were read on more items than it showed", () => {
        expect(() => service.acceptOnItem({ ...input, expectedCount: 1 }, auth)).toThrow(
            /more items since the page loaded/
        );
        expect(events).toEqual([]);
    });

    it("refuses a pair somebody already decided", () => {
        stored = [pair("p1", "jane", { state: "accepted" })];

        expect(() => service.acceptOnItem(input, auth)).toThrow(/no longer there/);
    });

    it("still answers with what it did when the recount finds the database busy", () => {
        recountFails = true;
        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        expect(service.acceptOnItem(input, auth).tagged).toBe(1);
        expect(events).toContain("decide accepted p1 (in transaction)");
    });
});

describe("the other decisions", () => {
    it("leaving one item out skips it and recounts the pairs, after the transaction", () => {
        service.skipOnItem({ mediaId: "m2", matchIds: ["p1", "p2"] }, auth);

        expect(events).toEqual(["addSkips (in transaction)", "addSkips (in transaction)"]);
        expect(recounts).toEqual([{ ids: ["p1", "p2"], inTransaction: false }]);
    });

    it("a rejection moves no count, so recounts nothing", () => {
        service.reject({ matchIds: ["p2"] }, auth);

        expect(events).toEqual(["decide rejected p2"]);
        expect(recounts).toEqual([]);
    });

    it("an undo withdraws the batch and the rule's own tags, then recounts outside any transaction", () => {
        stored = [pair("p1", "jane", { state: "accepted", batchId: "b1" })];

        const result = service.undo({ matchIds: ["p1"] }, auth);

        expect(events).toEqual([
            "undoBulkTag",
            "reopenForBatch",
            "withdrawRuleTags (in transaction)",
            "reindex (in transaction)",
            "reopen",
            "applyRules p-other",
        ]);
        expect(result.mediaIds).toEqual(["m1", "m2", "m3"]);
        expect(recounts).toEqual([
            { ids: ["p-other", "p1"], inTransaction: false },
            { ids: ["p-other", "p1"], inTransaction: false },
        ]);
    });

    it("taking a rule's tag off one item declines the rule there", () => {
        service.undoRuleTag({ id: "mt1" }, auth);

        expect(events).toEqual([
            "unassign (in transaction)",
            "reindex (in transaction)",
            "declineRules m3 jane",
        ]);
        expect(recounts).toEqual([{ ids: ["p-other"], inTransaction: false }]);
    });

    it("filing under another tag counts the new pair after the transaction", () => {
        service.manual(
            { textNorm: "jane doe", kind: "performer", name: "Janet", replaceMatchId: "p2" },
            auth
        );

        expect(events).toEqual([
            "ensureTag (in transaction)",
            "ensureManual (in transaction)",
            "decide rejected p2 (in transaction)",
        ]);
        expect(recounts).toEqual([{ ids: ["p-manual"], inTransaction: false }]);
    });

    it("coining a name asks for one rematch, held back so a burst of names is one run", () => {
        service.manual({ textNorm: "jane doe", kind: "performer", name: "Janet" }, auth);

        // The OCR review's rematch, and which tags every item's text names (§5b).
        expect(enqueued).toEqual([
            { kind: "ocrMatch", priority: 150, delay: 15 },
            { kind: "mentionMatch", priority: 150, delay: 15 },
        ]);
    });
});
