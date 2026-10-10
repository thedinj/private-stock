import { describe, expect, it } from "vitest";

import { parseSearchType, searchHref } from "./headerSearch";
import { parseView } from "./libraryQuery";

const libraryView = (href: string) => parseView(new URLSearchParams(href.split("?")[1]));

describe("searchHref", () => {
    it("goes nowhere when nothing is typed", () => {
        expect(searchHref("library", "   ")).toBeNull();
        expect(searchHref("performer", "")).toBeNull();
    });

    it("searches a clean library grid, not the view that was open", () => {
        const href = searchHref("library", "  beach day ");
        const view = libraryView(href!);

        expect(href!.startsWith("/?")).toBe(true);
        expect(view.search).toBe("beach day");
        expect(view.mode).toBe("grid");
        expect(view.tags).toEqual([]);
        expect(view.lookText).toBe("");
    });

    it("asks a look of a clean library, with no search text", () => {
        const view = libraryView(searchHref("look", "neon at night")!);

        expect(view.lookText).toBe("neon at night");
        expect(view.search).toBe("");
        expect(view.mode).toBe("grid");
    });

    it("sends tag kinds to their browse page with the words in its address", () => {
        expect(searchHref("performer", "anna k")).toBe("/tags/performers?q=anna+k");
        expect(searchHref("source", "x&y")).toBe("/tags/sources?q=x%26y");
        expect(searchHref("keyword", "beach")).toBe("/tags/keywords?q=beach");
    });

    it("cuts a long paste to what the server accepts", () => {
        const view = libraryView(searchHref("library", "a".repeat(500))!);

        expect(view.search).toHaveLength(200);
    });
});

describe("parseSearchType", () => {
    it("reads back a stored kind", () => {
        expect(parseSearchType("look")).toBe("look");
    });

    it("falls back to the library for nothing or nonsense", () => {
        expect(parseSearchType(null)).toBe("library");
        expect(parseSearchType("people")).toBe("library");
    });
});
