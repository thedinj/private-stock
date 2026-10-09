import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

/**
 * The Next patch in `patches/` is installed (§20 "The web process's own memory").
 *
 * Next 15's router remembered every request path that was not a file as a null in an LRU sized
 * for a million entries, each keeping a slice of the request URL, and never read one back. On a
 * library of 13k items that is an entry per cover, preview, poster and stream ever asked for --
 * a heap that grows for as long as the process runs. `patchedDependencies` removes the write.
 *
 * pnpm refuses an install whose patch no longer applies, so a Next upgrade cannot drop it
 * silently; this catches the other way it could go missing -- a lockfile or workspace edit that
 * loses the `patchedDependencies` entry -- in the copy the web app actually resolves.
 */

const require = createRequire(import.meta.url);

const routerSources = (): string[] =>
    [
        "next/dist/server/lib/router-utils/filesystem.js",
        "next/dist/esm/server/lib/router-utils/filesystem.js",
    ].map((specifier) => readFileSync(require.resolve(specifier), "utf8"));

describe("Next's filesystem route cache", () => {
    it("does not remember request paths that are not files", () => {
        for (const source of routerSources()) {
            expect(source).toContain("getItemsLru");
            expect(source).not.toMatch(/getItemsLru\.set\(itemKey, null\)/);
            expect(source).toContain("private-stock patch");
        }
    });
});
