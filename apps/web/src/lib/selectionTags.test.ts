import { describe, expect, it } from "vitest";

import type { SelectionTag } from "@private-stock/core";

import { describeCoverage, describePublicRemoval, groupByFacet } from "./selectionTags";

const tag = (name: string, scope: "public" | "private", kind = "tag"): SelectionTag => ({
    tagId: `t-${name}`,
    kind,
    name,
    colorKey: null,
    scope,
    count: 1,
});

describe("groupByFacet", () => {
    it("gives each facet a section, in the item editor's order", () => {
        const sections = groupByFacet([
            tag("Studio A", "public", "source"),
            tag("Ana", "public", "performer"),
            tag("Beach", "public"),
        ]);

        expect(sections.map((section) => section.kind)).toEqual(["performer", "source", "tag"]);
    });

    it("splits keywords by whose they are, shared first", () => {
        const [keywords] = groupByFacet([
            tag("To cut", "private"),
            tag("Beach", "public"),
            tag("Sunset", "public"),
        ]);

        expect(keywords.boxes.map((box) => box.scope)).toEqual(["public", "private"]);
        expect(keywords.boxes[0].tags.map((row) => row.name)).toEqual(["Beach", "Sunset"]);
        expect(keywords.boxes[1].tags.map((row) => row.name)).toEqual(["To cut"]);
    });

    it("leaves out facets and boxes the selection does not carry", () => {
        const sections = groupByFacet([tag("Ana", "public", "performer")]);

        expect(sections).toHaveLength(1);
        expect(sections[0].boxes).toHaveLength(1);
    });

    it("keeps a facet it has never heard of, after the known ones", () => {
        const sections = groupByFacet([tag("Noir", "public", "genre"), tag("Beach", "public")]);

        expect(sections.map((section) => section.kind)).toEqual(["tag", "genre"]);
    });

    it("keeps the order the server sent", () => {
        // Which is by how much of the selection carries each. Re-sorting here would put the
        // tag on two items above the one on thirty, and the list is read top-down.
        const [keywords] = groupByFacet([tag("Second", "public"), tag("First", "public")]);

        expect(keywords.boxes[0].tags.map((row) => row.name)).toEqual(["Second", "First"]);
    });
});

describe("describePublicRemoval", () => {
    it("says nothing when only private keywords are ticked", () => {
        expect(describePublicRemoval([tag("To cut", "private")])).toBeNull();
    });

    it("calls keywords shared, and performers and sources nothing", () => {
        expect(describePublicRemoval([tag("Beach", "public")])).toBe(
            "Shared keywords are removed for everyone."
        );
        expect(
            describePublicRemoval([
                tag("Ana", "public", "performer"),
                tag("Beach", "public"),
                tag("Studio A", "public", "source"),
                tag("To cut", "private"),
            ])
        ).toBe("Performers, sources and shared keywords are removed for everyone.");
    });
});

describe("describeCoverage", () => {
    it("says all rather than repeating the number", () => {
        expect(describeCoverage(30, 30)).toBe("on all 30");
    });

    it("says the fraction when it is one", () => {
        expect(describeCoverage(12, 30)).toBe("on 12 of 30");
    });
});
