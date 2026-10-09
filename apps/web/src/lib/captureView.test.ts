import { describe, expect, it } from "vitest";

import { captureView } from "./captureView";

/**
 * The Captures page's address is its state (§20), so what it reads back has to be what it
 * wrote, and anything a hand-edited address says that makes no sense has to fall back rather
 * than break the page.
 */

const parse = (query: string) => captureView.parse(new URLSearchParams(query));

describe("capture view", () => {
    it("reads a bare address as the defaults, and writes the defaults as a bare address", () => {
        expect(parse("")).toEqual(captureView.defaults);
        expect(captureView.href(captureView.defaults)).toBe("/captures");
    });

    it("round-trips every setting", () => {
        const view = {
            sort: "title" as const,
            direction: "desc" as const,
            search: "sunset & sea",
            page: 3,
            flat: true,
        };
        const href = captureView.href(view);

        expect(parse(href.slice(href.indexOf("?")))).toEqual(view);
    });

    it("falls back on nonsense rather than failing", () => {
        expect(parse("sort=nope&dir=sideways&page=-4")).toEqual(captureView.defaults);
        expect(parse("page=abc").page).toBe(0);
        expect(parse("page=2.7").page).toBe(2);
    });
});
