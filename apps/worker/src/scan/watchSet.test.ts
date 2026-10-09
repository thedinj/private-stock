import { describe, expect, it } from "vitest";

import { watchSignature, type WatchableRoot } from "./watchSet.js";

/**
 * What counts as "the libraries changed" (§7).
 *
 * Both directions fail quietly and both have happened. Missing a change leaves a library
 * unwatched, so files dropped into it never appear — the bug this exists to prevent. Seeing a
 * change that is not there rebuilds every watcher on a timer, and each rebuild re-walks the
 * whole library to establish a baseline.
 */

const root = (overrides: Partial<WatchableRoot> = {}): WatchableRoot => ({
    id: "r1",
    path: "/media/videos",
    enabled: 1,
    ...overrides,
});

describe("watchSignature", () => {
    it("is stable for the same libraries in a different order", () => {
        const a = root({ id: "a", path: "/media/a" });
        const b = root({ id: "b", path: "/media/b" });

        // The query that produces these orders by something unrelated to watching, so an
        // order-sensitive comparison would rebuild every watcher on every poll.
        expect(watchSignature([a, b])).toBe(watchSignature([b, a]));
    });

    it("changes when a library is added or removed", () => {
        const one = [root({ id: "a" })];
        const two = [root({ id: "a" }), root({ id: "b", path: "/media/b" })];

        expect(watchSignature(one)).not.toBe(watchSignature(two));
    });

    it("changes when a library is repointed", () => {
        // Same id, different directory. Comparing ids alone would keep watching the old one
        // for ever, which is silent: events keep arriving, just about the wrong folder.
        expect(watchSignature([root({ path: "/media/old" })])).not.toBe(
            watchSignature([root({ path: "/media/new" })])
        );
    });

    it("changes when a library is disabled", () => {
        // The row stays exactly where it is, so nothing about id or path moves — and a
        // disabled library must stop being watched.
        expect(watchSignature([root({ enabled: 1 })])).not.toBe(
            watchSignature([root({ enabled: null })])
        );
    });

    it("distinguishes two libraries that share a directory", () => {
        const shared = "/media/videos";

        expect(watchSignature([root({ id: "a", path: shared })])).not.toBe(
            watchSignature([root({ id: "b", path: shared })])
        );
    });

    it("treats nothing configured as a set of its own", () => {
        expect(watchSignature([])).toBe("");
        expect(watchSignature([])).not.toBe(watchSignature([root()]));
    });
});
