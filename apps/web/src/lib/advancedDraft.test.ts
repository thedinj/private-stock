import { describe, expect, it } from "vitest";

import type { FilterGroup } from "@private-stock/core";

import {
    blankGroup,
    draftToGroups,
    exampleGroups,
    groupsToDraft,
    rowFor,
    subjectFromKey,
    subjectKey,
    subjectOptions,
} from "./advancedDraft";

/**
 * The Advanced editor's rows against the rules they stand for (§14e).
 *
 * The editor folds a facet's tags, its ♥ and its "has none" into one row, and unfolds them on
 * Apply. A rule lost in that round trip is a filter that changes by being opened and applied
 * unchanged, which nobody would notice until the grid was wrong.
 */

const KINDS: Record<string, string> = { son: "performer", daughter: "performer", beach: "tag" };
const kindOf = (id: string) => KINDS[id];

describe("rows and rules", () => {
    it("round-trips every kind of rule, folding a facet into one row", () => {
        const groups: FilterGroup[] = [
            {
                match: "any",
                rules: [
                    { t: "tag", id: "son" },
                    { t: "favTags", kind: "performer" },
                    { t: "tag", id: "daughter" },
                    { t: "tag", id: "beach" },
                ],
            },
            {
                match: "none",
                rules: [
                    { t: "untagged", kind: "source" },
                    { t: "rating", min: 4 },
                    { t: "measure", measure: "durationSec", min: 60, max: 300 },
                    { t: "orientation", value: "portrait" },
                    { t: "kind", value: "image" },
                ],
            },
        ];

        const draft = groupsToDraft(groups, kindOf);

        // Performer's three rules are one row; the keyword is another.
        expect(draft[0]?.rows).toHaveLength(2);
        expect(draft[0]?.rows[0]?.facet).toEqual({
            none: false,
            favorites: true,
            tagIds: ["son", "daughter"],
        });

        const back = draftToGroups(draft);

        expect(back[1]).toEqual(groups[1]);
        // The ♥ leads its row's rules; the set is what matters.
        expect(new Set(back[0]?.rules.map((rule) => JSON.stringify(rule)))).toEqual(
            new Set(groups[0]?.rules.map((rule) => JSON.stringify(rule)))
        );
    });

    it("leaves out unfinished rows and the groups they leave empty", () => {
        const half = blankGroup();
        const measure = { ...blankGroup(), rows: [rowFor({ type: "measure", measure: "fps" }, 1)] };

        expect(draftToGroups([half, measure])).toEqual([]);
    });

    it("builds valid examples", () => {
        const [, unrated, big] = exampleGroups();

        expect(draftToGroups([unrated!.group, big!.group])).toEqual([
            { match: "any", rules: [{ t: "unrated" }, { t: "rating", max: 2 }] },
            {
                match: "any",
                rules: [
                    { t: "measure", measure: "resolution", min: 2160 },
                    { t: "measure", measure: "durationSec", min: 1200 },
                ],
            },
        ]);
    });
});

describe("the subject picker", () => {
    it("round-trips its option values", () => {
        for (const section of subjectOptions("all")) {
            for (const item of section.items) {
                expect(subjectKey(subjectFromKey(item.value))).toBe(item.value);
            }
        }
    });

    it("offers only what the kind can answer, and never videos-or-photos", () => {
        const labels = (kind: "all" | "video" | "image") =>
            subjectOptions(kind).flatMap((section) => section.items.map((item) => item.label));

        expect(labels("video")).toContain("Length");
        expect(labels("video")).not.toContain("Movement");
        expect(labels("image")).toContain("Movement");
        expect(labels("image")).not.toContain("Length");
        expect(labels("all")).not.toContain("Videos or photos");
        // The panel's words, not a second vocabulary.
        expect(labels("all")).toContain("File size");
    });
});
