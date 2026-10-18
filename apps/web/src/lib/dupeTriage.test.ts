import { describe, expect, it } from "vitest";

import type { DupeGroup, DupeMember } from "@private-stock/core";

import {
    nextSet,
    oneApart,
    rowCautions,
    setsOf,
    startSorting,
    tickedByDefault,
    toResolveItem,
    toSortInput,
} from "./dupeTriage";

/**
 * Which rows of the triage sheet start ticked, and what a ticked row sends (§10c).
 *
 * A ticked row is trashed by one press of the bar, so every default here is a deletion that
 * happens unless somebody notices. The request side matters as much: it must name exactly the
 * copies the row showed going, never "everything but the keeper".
 */

const member = (id: string, overrides: Partial<DupeMember> = {}): DupeMember =>
    ({ id, deletable: true, clipCount: 0, ...overrides }) as DupeMember;

const group = (overrides: Partial<DupeGroup> = {}): DupeGroup =>
    ({
        id: "g",
        kind: "near",
        reviewed: false,
        maxDistance: 2,
        members: [member("best"), member("worse")],
        suggestedKeepId: "best",
        keepReason: null,
        cautions: [],
        ...overrides,
    }) as DupeGroup;

describe("which rows start ticked", () => {
    it("ticks an ordinary group with the recommendation", () => {
        expect(tickedByDefault(group(), "best")).toBe(true);
    });

    it("leaves a group with a server caution unticked", () => {
        expect(tickedByDefault(group({ cautions: ["Lengths differ"] }), "best")).toBe(false);
    });

    it("leaves a group unticked when clips would go with the doomed copy", () => {
        const withClips = group({ members: [member("best"), member("worse", { clipCount: 2 })] });

        expect(tickedByDefault(withClips, "best")).toBe(false);
        expect(rowCautions(withClips, "best")[0]).toMatch(/^2 clips are cut/);
    });

    it("draws the clip caution for the keeper as chosen, not as recommended", () => {
        // Keeping the copy that holds the clips puts none of them at risk.
        const withClips = group({ members: [member("best"), member("worse", { clipCount: 2 })] });

        expect(rowCautions(withClips, "worse")).toEqual([]);
    });

    it("leaves a reviewed group unticked", () => {
        expect(tickedByDefault(group({ reviewed: true }), "best")).toBe(false);
    });

    it("cannot tick a group where nothing could be removed", () => {
        const stuck = group({ members: [member("best"), member("ro", { deletable: false })] });

        expect(tickedByDefault(stuck, "best")).toBe(false);
        expect(toResolveItem(stuck, "best")).toBeNull();
    });
});

describe("what a ticked row sends", () => {
    it("names exactly the removable copies, never the keeper or a read-only one", () => {
        const mixed = group({
            members: [member("best"), member("worse"), member("ro", { deletable: false })],
        });

        expect(toResolveItem(mixed, "best")).toEqual({
            groupId: "g",
            keepId: "best",
            trashIds: ["worse"],
        });
    });

    it("follows the reviewer's keeper", () => {
        expect(toResolveItem(group(), "worse")?.trashIds).toEqual(["best"]);
    });
});

/** Sorting a row into sets of the same thing (§10i): five copies, A–B, C–D and E. */
describe("sorting a row", () => {
    const five = group({
        members: ["A", "B", "C", "D", "E"].map((id) => member(id)),
        suggestedKeepId: "A",
        suggestedSets: [["A", "B"], ["C", "D"], ["E"]],
    });

    it("starts from the app's suggestion", () => {
        expect(setsOf(five, startSorting(five)).map((set) => set.map((m) => m.id))).toEqual([
            ["A", "B"],
            ["C", "D"],
            ["E"],
        ]);
    });

    it("moves a copy to the next set, then a new one, then round to the first", () => {
        const sorting = startSorting(five);

        expect(nextSet(five, sorting, "A")).toBe(1);
        expect(nextSet(five, sorting, "C")).toBe(2);
        // E is alone in the newest set, so a new set would be the same as staying: round it goes.
        expect(nextSet(five, sorting, "E")).toBe(0);
        expect(nextSet(five, { ...sorting, assign: { ...sorting.assign, E: 1 } }, "E")).toBe(2);
    });

    it("trashes within each set, around its own keeper, and nothing alone", () => {
        const sorting = { ...startSorting(five), keepers: ["D"] };

        expect(toSortInput(five, sorting, true).sets).toEqual([
            { ids: ["A", "B"], alike: true, keepId: "A", trashIds: ["B"] },
            { ids: ["C", "D"], alike: true, keepId: "D", trashIds: ["C"] },
            { ids: ["E"], alike: true, keepId: null, trashIds: [] },
        ]);
    });

    it("only records when not resolving", () => {
        const sets = toSortInput(five, startSorting(five), false).sets;

        expect(sets.every((set) => set.keepId === null && set.trashIds.length === 0)).toBe(true);
    });

    it("says nothing about the rest when one copy is set apart", () => {
        expect(oneApart(five, "E").sets).toEqual([
            { ids: ["E"], alike: true, keepId: null, trashIds: [] },
            { ids: ["A", "B", "C", "D"], alike: false, keepId: null, trashIds: [] },
        ]);
    });
});
