import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { queryKeys } from "./queryKeys";

/**
 * The factory is only worth having if everything goes through it (§14).
 *
 * A hand-written key does not fail. `invalidateQueries` matches by prefix, so a key spelled
 * differently at one call site simply never matches, refreshes nothing, and shows up later
 * as data that is out of date — which nobody attributes to caching. Two bugs of exactly that
 * shape were already in this app before the factory existed.
 *
 * So this is a lint rather than a behaviour test, and it is the only kind of check that can
 * catch the next one: the compiler cannot object to an array literal.
 */

const SOURCE_ROOT = join(__dirname, "..", "..");

/** Walked rather than globbed, so this needs no dependency of its own. */
const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = join(directory, entry.name);

        if (entry.isDirectory()) return walk(full);

        return /\.tsx?$/.test(entry.name) ? [full] : [];
    });

const sources = walk(SOURCE_ROOT).filter(
    (file) => !file.endsWith("queryKeys.ts") && !file.endsWith("queryKeys.test.ts")
);

describe("the query key factory", () => {
    it("is the only place a key is written", () => {
        const offenders = sources.filter((file) =>
            /queryKey:\s*\[/.test(readFileSync(file, "utf8"))
        );

        expect(
            offenders.map((file) => file.slice(SOURCE_ROOT.length + 1).replace(/\\/g, "/"))
        ).toEqual([]);
    });

    /**
     * Prefix invalidation is the whole mechanism, so a builder that takes an argument has to
     * extend its own namespace rather than sit beside it. `["media", "list", filter, page]`
     * is reached by `["media", "list"]` and by `["media"]`; if `page()` returned
     * `["media-list", …]` instead, both of those broad strokes would silently stop working
     * and every one of the three keys would still look plausible on its own line.
     */
    it("nests every builder under the prefix that is meant to reach it", () => {
        const startsWith = (key: unknown[], prefix: unknown[]) =>
            prefix.every((part, index) => key[index] === part);

        expect(startsWith(queryKeys.media.page("f", 2), queryKeys.media.list())).toBe(true);
        expect(startsWith(queryKeys.media.list(), queryKeys.media.all())).toBe(true);
        expect(startsWith(queryKeys.media.count("f"), queryKeys.media.all())).toBe(true);
        // The viewer's walk (§14b): reached by every stroke that reaches the library's pages,
        // and kept out of `media.list()`, whose entries the live feed patches as pages of tiles.
        expect(startsWith(queryKeys.media.idsPage("f", 0), queryKeys.media.all())).toBe(true);
        expect(startsWith(queryKeys.media.idsPage("f", 0), queryKeys.media.list())).toBe(false);
        expect(startsWith(queryKeys.media.lookup("a,b"), queryKeys.media.lookups())).toBe(true);
        expect(startsWith(queryKeys.media.lookups(), queryKeys.media.all())).toBe(true);
        expect(startsWith(queryKeys.media.lookup("a,b"), queryKeys.media.list())).toBe(false);
        expect(startsWith(queryKeys.media.facetsFor("f"), queryKeys.media.facets())).toBe(true);
        expect(startsWith(queryKeys.media.detail("m1"), queryKeys.media.all())).toBe(true);
        // Trash, restore and purge reach the Captures page through `media.all()`. It must stay
        // out of `media.list()`, whose entries the live feed patches as pages of grid tiles.
        expect(startsWith(queryKeys.media.capturesPage("f", 0), queryKeys.media.captures())).toBe(
            true
        );
        expect(startsWith(queryKeys.media.captures(), queryKeys.media.all())).toBe(true);
        expect(startsWith(queryKeys.media.capturesPage("f", 0), queryKeys.media.list())).toBe(
            false
        );
        expect(startsWith(queryKeys.media.transcode("m1"), queryKeys.media.detail("m1"))).toBe(
            true
        );
        expect(
            startsWith(queryKeys.playlists.itemsPage("p1", 0, null), queryKeys.playlists.all())
        ).toBe(true);
        expect(
            startsWith(
                queryKeys.playlists.itemsPage("p1", 0, null),
                queryKeys.playlists.detail("p1")
            )
        ).toBe(true);
        expect(startsWith(queryKeys.dupes.page("x"), queryKeys.dupes.all())).toBe(true);
        // One review action can move findings between strings and items alike (§5d).
        expect(startsWith(queryKeys.ocr.queue(), queryKeys.ocr.all())).toBe(true);
        expect(startsWith(queryKeys.ocr.ruleTags(), queryKeys.ocr.all())).toBe(true);
        expect(startsWith(queryKeys.ocr.matches("x"), queryKeys.ocr.all())).toBe(true);
        expect(startsWith(queryKeys.ocr.counts(), queryKeys.ocr.all())).toBe(true);
        expect(startsWith(queryKeys.ocr.settings(), queryKeys.ocr.all())).toBe(true);
        expect(startsWith(queryKeys.ocr.bench(), queryKeys.ocr.all())).toBe(true);
        expect(startsWith(queryKeys.ocr.tune(), queryKeys.ocr.all())).toBe(true);
        expect(startsWith(queryKeys.ocr.tuneEstimate("done"), queryKeys.ocr.tuneEstimates())).toBe(
            true
        );
        expect(startsWith(queryKeys.ocr.tuneEstimates(), queryKeys.ocr.all())).toBe(true);
        // The vocabulary: one stroke has to reach the suggestion lists, the management table
        // and the batch history, because a rename moves all three (§6).
        expect(startsWith(queryKeys.tags.byKind("tag", "public"), queryKeys.tags.all())).toBe(true);
        expect(startsWith(queryKeys.tags.list("public", "p"), queryKeys.tags.all())).toBe(true);
        expect(startsWith(queryKeys.tags.batches(), queryKeys.tags.all())).toBe(true);
        expect(
            startsWith(queryKeys.tags.browse("performer", "public", "p"), queryKeys.tags.all())
        ).toBe(true);
        expect(startsWith(queryKeys.tags.profile("t", 1), queryKeys.tags.all())).toBe(true);
        // "Appears with" is fetched on its own: reached by the vocabulary stroke and by the
        // listable one, and kept out of `profileOf`, whose entries the favourite write-in
        // patches as profiles.
        expect(startsWith(queryKeys.tags.companions("t", 1), queryKeys.tags.all())).toBe(true);
        expect(startsWith(queryKeys.tags.companions("t", 1), queryKeys.tags.companionsAll())).toBe(
            true
        );
        expect(startsWith(queryKeys.tags.companions("t", 1), queryKeys.tags.profileOf("t"))).toBe(
            false
        );
    });

    /**
     * The one that had already gone wrong.
     *
     * The grid and the viewer's prefetch request the same page and must share a cache entry.
     * They used to build the key separately, kept in step by a comment in each file saying
     * they matched — which they did, and nothing made them.
     */
    it("gives the grid and the viewer the same key for the same page", () => {
        const filter = "sort=addedAt&direction=desc";

        expect(queryKeys.media.page(filter, 3)).toEqual(queryKeys.media.page(filter, 3));
        expect(queryKeys.media.page(filter, 3)).not.toEqual(queryKeys.media.page(filter, 4));
    });

    /**
     * A library's name orders the sidebar's list and the administration table shows it, so a
     * rename changes both. The cascade lives in `invalidateLibraries`; this pins the two keys
     * it has to reach, because "the sidebar did not update" is the symptom that started all
     * of this.
     */
    it("keeps the two library caches distinct, so both have to be named", () => {
        expect(queryKeys.admin.scan()).not.toEqual(queryKeys.library.roots());
    });
});
