import { describe, expect, it } from "vitest";

import { defineView, directionField, enumField, flagField, pageField, textField } from "./urlView";

/**
 * A page's view is its address (§14b), so what a view reads back has to be what it wrote, a
 * hand-edited address has to fall back rather than break the page, and views sharing one
 * address must not touch each other's parameters.
 */

const view = defineView("/things", {
    sort: enumField("sort", ["name", "size"], "name"),
    direction: directionField("dir"),
    search: textField("q"),
    unusedOnly: flagField("unused"),
    page: pageField(),
});

const parse = (query: string) => view.parse(new URLSearchParams(query));

describe("a view in the address", () => {
    it("keeps defaults out, so the plain address is the default view", () => {
        expect(parse("")).toEqual(view.defaults);
        expect(view.href(view.defaults)).toBe("/things");
    });

    it("round-trips every field", () => {
        const set = {
            sort: "size" as const,
            direction: "desc" as const,
            search: "rain & sea",
            unusedOnly: true,
            page: 4,
        };
        const href = view.href(set);

        expect(parse(href.slice(href.indexOf("?")))).toEqual(set);
    });

    it("reads nonsense as the default rather than failing", () => {
        expect(parse("sort=nope&dir=sideways&page=-3&unused=yes")).toEqual(view.defaults);
        expect(parse("page=2.7").page).toBe(2);
        expect(parse("page=abc").page).toBe(0);
    });

    it("keeps parameters it does not own", () => {
        // A tag page's `seed` lives beside the browse view's search and sort.
        const href = view.href({ ...view.defaults, page: 2 }, new URLSearchParams("seed=9"));

        expect(new URLSearchParams(href.split("?")[1]).get("seed")).toBe("9");
    });

    it("drops its own parameters when they go back to the default", () => {
        expect(view.href(view.defaults, new URLSearchParams("q=old&page=3"))).toBe("/things");
    });
});

describe("views sharing an address", () => {
    const fields = { search: textField("q"), page: pageField() };
    const performers = defineView("/tags/manage", fields, { prefix: "performer.public." });
    const keywords = defineView("/tags/manage", fields, { prefix: "tag.private." });

    it("each writes under its own prefix and leaves the other alone", () => {
        const first = performers.href({ search: "ann", page: 2 });
        const both = keywords.href(
            { search: "beach", page: 0 },
            new URLSearchParams(first.split("?")[1])
        );
        const params = new URLSearchParams(both.split("?")[1]);

        expect(performers.parse(params)).toEqual({ search: "ann", page: 2 });
        expect(keywords.parse(params)).toEqual({ search: "beach", page: 0 });
    });
});
