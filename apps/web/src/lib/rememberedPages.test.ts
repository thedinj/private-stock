import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseView } from "./libraryQuery";
import { FIRST_LIBRARY_QUERY, rememberPage } from "./rememberedPages";

/**
 * The sidebar returns you to where each list page was left (§14b). What is recorded decides
 * where it goes, so: only pages that opt in, the library but never the room, and the address
 * whole.
 */

const store = new Map<string, string>();

beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
    });
});

describe("remembering a page", () => {
    it("records a listed page's whole address", () => {
        rememberPage("/clips", "q=intro&page=2");

        expect(store.get("ps:page:/clips")).toBe("q=intro&page=2");
    });

    it("keeps a moved page's old key, and remembers the review queue last used", () => {
        rememberPage("/review/duplicates", "tab=near&page=2");

        expect(store.get("ps:page:/duplicates")).toBe("tab=near&page=2");
        expect(store.get("ps:section:/review")).toBe("/review/duplicates");
    });

    it("remembers the Studio page last used, as the list rather than one reel", () => {
        rememberPage("/clips", "");
        rememberPage("/reels/r1", "");

        expect(store.get("ps:section:studio")).toBe("/reels");
        expect(store.has("ps:page:/reels")).toBe(false);
    });

    it("ignores pages that are not listed", () => {
        rememberPage("/admin", "anything=1");
        rememberPage("/media/m1", "at=12");

        expect(store.size).toBe(0);
    });

    it("keeps the library under the key it has always had, and never records the room", () => {
        rememberPage("/", "view=grid&kind=image&page=3");
        rememberPage("/", "");

        expect(store.get("ps:libraryView")).toBe("view=grid&kind=image&page=3");
    });

    it("remembers only a search, so passing through the clean library keeps the last one", () => {
        rememberPage("/", "view=grid&tags=t1");
        rememberPage("/", "view=grid");
        rememberPage("/", "view=grid&page=2");
        rememberPage("/", "root=r1");

        expect(store.get("ps:libraryView")).toBe("view=grid&tags=t1");
    });

    it("starts the library on videos before anything is remembered", () => {
        expect(parseView(new URLSearchParams(FIRST_LIBRARY_QUERY)).kind).toBe("video");
    });
});
