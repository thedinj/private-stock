import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `ocrMatch` job (§5d "Tagging performers and sources from what was read").
 *
 * It used to run in full once per name coined — somebody working down the review queue coins one
 * every minute or two — and each run rewrote every pair and recounted all of them while holding
 * the write lock. What is guarded here: a run with nothing new does nothing, a name coined while
 * a run is under way is caught by that run rather than lost (the web cannot queue a second job
 * while one is claimed), and every run ends by recounting every pair, which is what heals a
 * count the web could not store, and by applying what accepted pairs' rules are still owed.
 */

let vocabularies: { tagId: string; name: string }[][] = [];
let calls: string[] = [];

const STRINGS = [
    { textNorm: "a", text: "A" },
    { textNorm: "b", text: "B" },
];
const PAIRS = ["p1", "p2", "p3"];

vi.mock("@private-stock/db", () => ({
    ocrTagMatchRepo: {
        matchVocabulary: () => {
            calls.push("vocabulary");

            return vocabularies.length > 1 ? vocabularies.shift()! : vocabularies[0];
        },
        matchableStrings: (after: string | null) =>
            after === null ? STRINGS : STRINGS.filter((row) => row.textNorm > after),
        matchKnownStrings: (strings: { textNorm: string }[]) =>
            calls.push(`match ${strings.map((row) => row.textNorm).join(",")}`),
        pruneOrphans: () => {
            calls.push("prune");

            return 0;
        },
        pairIdsPage: (after: string | null) =>
            after === null ? PAIRS : PAIRS.filter((id) => id > after),
        recountPending: (ids: string[]) => {
            calls.push(`recount ${ids.join(",")}`);

            return 0;
        },
        acceptedPairIds: () => ["p2"],
        applyRules: (ids: string[]) => {
            calls.push(`rules ${ids.join(",")}`);

            return { mediaIds: ["m1"], tagIds: ["jane"] };
        },
        pairsTouching: () => ["p2"],
    },
}));

const { runOcrMatch } = await import("./ocrMatch.js");

const JANE = { tagId: "jane", name: "Jane Doe" };
const JILL = { tagId: "jill", name: "Jill Roe" };

beforeEach(() => {
    calls = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("runOcrMatch", () => {
    it("matches every string, recounts every pair, then applies what rules are owed", async () => {
        vocabularies = [[JANE]];

        await runOcrMatch();

        expect(calls).toEqual([
            "vocabulary",
            "match a,b",
            "prune",
            "recount p1,p2,p3",
            "rules p2",
            "recount p2",
            "vocabulary",
        ]);
    });

    it("does nothing when the vocabulary is the one it last matched", async () => {
        vocabularies = [[JANE]];

        await runOcrMatch();

        expect(calls).toEqual(["vocabulary"]);
    });

    it("runs again before finishing when a name was coined during the run", async () => {
        vocabularies = [
            [JANE, JILL],
            [JANE, JILL, { tagId: "kim", name: "Kim Poe" }],
        ];

        await runOcrMatch();

        expect(calls.filter((call) => call.startsWith("match"))).toHaveLength(2);
        expect(calls[calls.length - 1]).toBe("vocabulary");

        calls = [];
        await runOcrMatch();
        expect(calls).toEqual(["vocabulary"]);
    });
});
