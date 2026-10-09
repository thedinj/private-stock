import { describe, expect, it } from "vitest";

import { resolvePin, type CollectionPinInputs } from "./collections.js";

/**
 * Where a collection sits for one viewer (§14b).
 *
 * The rule this pins down is the one the app had two different answers to: a shared view's
 * owner-pin reached every sidebar, and a shared playlist's reached none. These are the same
 * object with different mechanics, so the answer has to be one answer.
 */

const inputs = (over: Partial<CollectionPinInputs> = {}): CollectionPinInputs => ({
    mine: false,
    shared: false,
    ownerPinned: false,
    ownerPosition: 3,
    viewer: null,
    ...over,
});

const decided = (pinned: boolean, position: number | null = null) => ({
    decided: true,
    pinned,
    position,
});

describe("a collection of your own", () => {
    it("is in your sidebar when you pinned it", () => {
        expect(resolvePin(inputs({ mine: true, ownerPinned: true })).pinned).toBe(true);
    });

    it("is not when you did not", () => {
        expect(resolvePin(inputs({ mine: true, ownerPinned: false })).pinned).toBe(false);
    });

    it("is never described as curated — you put it there", () => {
        expect(resolvePin(inputs({ mine: true, shared: true, ownerPinned: true })).curated).toBe(
            false
        );
    });
});

describe("somebody else's private collection", () => {
    /** It is not visible at all, but the resolution must not claim otherwise if asked. */
    it("is never in your sidebar", () => {
        expect(resolvePin(inputs({ mine: false, shared: false, ownerPinned: true })).pinned).toBe(
            false
        );
    });
});

describe("a shared collection, as somebody else sees it", () => {
    /**
     * The curated baseline. An administrator pinning something they have shared is saying "this
     * belongs in the household's sidebar", and that is what a new account arrives to.
     */
    it("arrives pinned when the administrator pinned it", () => {
        const resolved = resolvePin(inputs({ shared: true, ownerPinned: true }));

        expect(resolved.pinned).toBe(true);
        expect(resolved.curated).toBe(true);
    });

    /** Shared but not promoted: visible on the collections page, absent from the sidebar. */
    it("stays out of the sidebar when it was not pinned", () => {
        const resolved = resolvePin(inputs({ shared: true, ownerPinned: false }));

        expect(resolved.pinned).toBe(false);
        expect(resolved.curated).toBe(false);
    });

    it("takes the owner's ordering with it", () => {
        expect(
            resolvePin(inputs({ shared: true, ownerPinned: true, ownerPosition: 7 })).position
        ).toBe(7);
    });
});

describe("what the viewer decided", () => {
    /**
     * The reason this table exists. Without it the household default is permanent and one
     * person owns everybody's sidebar.
     */
    it("takes a curated collection out of their sidebar", () => {
        const resolved = resolvePin(
            inputs({ shared: true, ownerPinned: true, viewer: decided(false) })
        );

        expect(resolved.pinned).toBe(false);
        expect(resolved.curated).toBe(false);
    });

    it("keeps it out even though the house still offers it", () => {
        // The administrator repinning it must not undo somebody's decision.
        expect(
            resolvePin(inputs({ shared: true, ownerPinned: true, viewer: decided(false) })).pinned
        ).toBe(false);
    });

    it("puts a shared collection the house did not promote into their sidebar", () => {
        expect(
            resolvePin(inputs({ shared: true, ownerPinned: false, viewer: decided(true) })).pinned
        ).toBe(true);
    });

    it("is never reported as curated, because they chose it", () => {
        expect(
            resolvePin(inputs({ shared: true, ownerPinned: true, viewer: decided(true) })).curated
        ).toBe(false);
    });

    it("uses their own ordering when they have one", () => {
        expect(resolvePin(inputs({ viewer: decided(true, 11) })).position).toBe(11);
    });

    it("falls back to the owner's ordering when they have not reordered it", () => {
        expect(resolvePin(inputs({ ownerPosition: 4, viewer: decided(true, null) })).position).toBe(
            4
        );
    });

    /**
     * No row is a third state, not a synonym for unpinned: "show me whatever the house shows"
     * has to be reachable again after somebody has opted out.
     */
    it("follows the house again once the decision is cleared", () => {
        expect(resolvePin(inputs({ shared: true, ownerPinned: true, viewer: null })).pinned).toBe(
            true
        );
    });
});
