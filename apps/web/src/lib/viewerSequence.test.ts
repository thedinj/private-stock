import { describe, expect, it } from "vitest";

import { PAGE_SIZE } from "./libraryQuery";
import {
    adjacentPagesNeeded,
    neighbours,
    pageOfId,
    pickHeldPage,
    upcomingIds,
} from "./viewerSequence";

/** A full page of ids, so the page-boundary cases are exercised at the real size. */
const fullPage = (prefix: string): string[] =>
    Array.from({ length: PAGE_SIZE }, (_, index) => `${prefix}${index}`);

describe("neighbours", () => {
    it("steps within a page", () => {
        const result = neighbours({ pageIds: ["a", "b", "c"], page: 0, currentId: "b" });

        expect(result.previousId).toBe("a");
        expect(result.nextId).toBe("c");
    });

    it("counts position across the pages before it", () => {
        // Page 3 at sixty a page: the first item on it is the 181st of the set.
        expect(neighbours({ pageIds: ["a", "b"], page: 3, currentId: "a" }).position).toBe(
            3 * PAGE_SIZE + 1
        );
    });

    it("has no previous at the very start and no next at the very end", () => {
        const only = neighbours({ pageIds: ["a", "b"], page: 0, currentId: "a" });

        expect(only.previousId).toBeNull();
        expect(neighbours({ pageIds: ["a", "b"], page: 0, currentId: "b" }).nextId).toBeNull();
    });

    it("crosses into the next page rather than stopping every sixtieth item", () => {
        const page = fullPage("p1-");
        const result = neighbours({
            pageIds: page,
            page: 1,
            nextPageIds: ["p2-0", "p2-1"],
            currentId: page[page.length - 1]!,
        });

        expect(result.nextId).toBe("p2-0");
    });

    it("crosses back into the previous page, landing on its last item", () => {
        const previous = fullPage("p0-");
        const result = neighbours({
            pageIds: ["p1-0", "p1-1"],
            page: 1,
            previousPageIds: previous,
            currentId: "p1-0",
        });

        expect(result.previousId).toBe(previous[previous.length - 1]);
    });

    it("offers nothing rather than a guess while an adjacent page is unknown", () => {
        const page = fullPage("p1-");
        const result = neighbours({ pageIds: page, page: 1, currentId: page[page.length - 1]! });

        // A next button that does nothing is worse than one that is not there yet.
        expect(result.nextId).toBeNull();
    });

    it("reports nothing for an item that has left the set", () => {
        // Open the only unrated item from "Unrated only", rate it, and the set it came from no
        // longer contains it. There is no "next" in a set this item has left.
        const result = neighbours({ pageIds: ["a", "b"], page: 0, currentId: "gone" });

        expect(result).toEqual({ previousId: null, nextId: null, position: null });
    });
});

describe("adjacentPagesNeeded", () => {
    it("asks for nothing from the middle of a page", () => {
        expect(adjacentPagesNeeded(["a", "b", "c"], 1, "b", true)).toEqual({
            previous: false,
            next: false,
        });
    });

    it("asks for the previous page only when there is one", () => {
        expect(adjacentPagesNeeded(["a", "b"], 1, "a", true).previous).toBe(true);
        expect(adjacentPagesNeeded(["a", "b"], 0, "a", true).previous).toBe(false);
    });

    it("asks for the next page only when the server says there is one", () => {
        const page = fullPage("p-");

        expect(adjacentPagesNeeded(page, 0, page[page.length - 1]!, true).next).toBe(true);
        // A full last page is still the last page.
        expect(adjacentPagesNeeded(page, 0, page[page.length - 1]!, false).next).toBe(false);
    });

    /**
     * A shuffled playlist's pages can come back short in the middle of the set (§20). Judged
     * by its length, a short page looked like the end, and everything after it was
     * unreachable from the viewer.
     */
    it("walks on from a short page that is not the last", () => {
        expect(adjacentPagesNeeded(["a", "b"], 0, "b", true).next).toBe(true);
    });

    it("asks for nothing on behalf of an item that is not there", () => {
        expect(adjacentPagesNeeded(["a"], 2, "gone", true)).toEqual({
            previous: false,
            next: false,
        });
    });
});

describe("pageOfId", () => {
    const pages = {
        pageIds: ["b1", "b2"],
        page: 4,
        previousPageIds: ["a1", "a2"],
        nextPageIds: ["c1", "c2"],
    };

    it("finds an id on the page held, and on either side of it", () => {
        expect(pageOfId(pages, "b2")).toBe(4);
        expect(pageOfId(pages, "c1")).toBe(5);
        expect(pageOfId(pages, "a2")).toBe(3);
    });

    it("says nothing about an id on none of them", () => {
        expect(pageOfId(pages, "z")).toBeNull();
        expect(pageOfId({ pageIds: ["b1"], page: 0 }, "c1")).toBeNull();
    });
});

describe("neighbours in a set with its own page size", () => {
    it("counts position in that set's pages", () => {
        expect(
            neighbours({ pageIds: ["a", "b"], page: 2, currentId: "b", pageSize: 200 }).position
        ).toBe(402);
    });
});

describe("pickHeldPage", () => {
    const page = (...ids: string[]) => ({ ids });

    it("holds the cached answer at once when it has this item, without waiting on a refetch", () => {
        const cached = page("a", "b", "c");

        expect(pickHeldPage(cached, false, undefined, "b")).toBe(cached);
    });

    it("waits for the refetch while the cached answer has lost this item", () => {
        expect(pickHeldPage(page("a", "c"), false, undefined, "b")).toBeUndefined();
    });

    it("falls back to the page held a step ago for an item that has left the set", () => {
        // Tagged out of "Untagged", then stepped back onto: only the earlier page knows it.
        const before = page("a", "b", "c");

        expect(pickHeldPage(page("a", "c"), true, before, "b")).toBe(before);
        expect(pickHeldPage(page("a", "c"), false, before, "b")).toBe(before);
    });

    it("prefers the fresh answer whenever it has this item", () => {
        const fresh = page("b", "c", "d");

        expect(pickHeldPage(fresh, true, page("a", "b", "c"), "b")).toBe(fresh);
    });

    it("holds the settled answer when nothing knows the item, rather than waiting forever", () => {
        const fresh = page("a", "c");

        expect(pickHeldPage(fresh, true, page("x"), "b")).toBe(fresh);
    });
});

describe("upcomingIds", () => {
    it("continues into the next page", () => {
        expect(upcomingIds(["a", "b", "c"], ["d", "e"], "b", 3)).toEqual(["c", "d", "e"]);
    });

    it("is short at the end of the set", () => {
        expect(upcomingIds(["a", "b"], undefined, "b", 8)).toEqual([]);
    });

    it("is empty for an item that is not in the page, not the start of the page", () => {
        expect(upcomingIds(["a", "b"], ["c"], "z", 8)).toEqual([]);
    });
});
