import { describe, expect, it } from "vitest";

import { applyTagsSchema, createTagSchema, scopeFitsFacet } from "./tags.js";
import { bulkTagApplySchema } from "./bulkTags.js";
import { SELECTION_TAG_LIMIT, bulkActionSchema } from "./bulkActions.js";

/**
 * Only `tag` can be private, on every input that can ask otherwise (§6).
 *
 * The rule is enforced in `tagRepo.ensureTag`, which is the guarantee; these are the *message*.
 * A refusal arriving as a readable 400 naming the facet is the difference between a form that
 * explains itself and one that reports whatever the database layer threw.
 *
 * Four schemas carry a facet and a scope together, and it is the fourth that makes this a test
 * file rather than a comment: they were written at different times, two of them are wrapped in
 * `.refine` and one is a discriminated union that cannot be, so "all of them" is a claim worth
 * checking rather than asserting.
 */

const base = { kind: "performer", scope: "private" as const };

describe("the predicate", () => {
    it("passes anything public", () => {
        expect(scopeFitsFacet({ kind: "performer", scope: "public" })).toBe(true);
        expect(scopeFitsFacet({ kind: "source", scope: "public" })).toBe(true);
    });

    it("passes a private tag and nothing else private", () => {
        expect(scopeFitsFacet({ kind: "tag", scope: "private" })).toBe(true);
        expect(scopeFitsFacet({ kind: "performer", scope: "private" })).toBe(false);
        expect(scopeFitsFacet({ kind: "source", scope: "private" })).toBe(false);
    });

    /** `kind` is an open string (§5b), so a facet nobody has heard of is not privatable. */
    it("refuses a private tag in a facet nothing declared", () => {
        expect(scopeFitsFacet({ kind: "director", scope: "private" })).toBe(false);
    });
});

describe("applying tags to an item", () => {
    it("refuses a private performer", () => {
        const result = applyTagsSchema.safeParse({ ...base, names: ["Jane Doe"] });

        expect(result.success).toBe(false);
        expect(result.error?.issues[0].message).toMatch(/Only tags can be private/);
        // Reported against the field somebody can actually change here.
        expect(result.error?.issues[0].path).toEqual(["scope"]);
    });

    it("accepts a private tag and a public performer", () => {
        expect(
            applyTagsSchema.safeParse({ kind: "tag", scope: "private", names: ["to cut"] }).success
        ).toBe(true);
        expect(
            applyTagsSchema.safeParse({ kind: "performer", scope: "public", names: ["Jane Doe"] })
                .success
        ).toBe(true);
    });

    /**
     * The refinement must not eat the defaults.
     *
     * A first attempt wrapped each schema in a generic helper typed `z.ZodType<T>`, which
     * collapses zod's input and output into one — every wrapped schema started inferring its
     * *input*, with defaults unapplied. It typechecked everywhere except one call site.
     */
    it("still applies its defaults", () => {
        const parsed = applyTagsSchema.parse({ kind: "tag", scope: "public", names: ["beach"] });

        expect(parsed.mode).toBe("replace");
    });
});

describe("coining a tag", () => {
    it("refuses a private source", () => {
        expect(
            createTagSchema.safeParse({ kind: "source", scope: "private", name: "x" }).success
        ).toBe(false);
    });

    it("accepts a private tag", () => {
        expect(
            createTagSchema.safeParse({ kind: "tag", scope: "private", name: "x" }).success
        ).toBe(true);
    });
});

describe("bulk applying from a filter", () => {
    const query = { sort: "addedAt", limit: 60 };

    it("refuses a private performer", () => {
        const result = bulkTagApplySchema.safeParse({
            query,
            kind: "performer",
            scope: "private",
            names: ["Jane Doe"],
            expectedCount: 4,
        });

        expect(result.success).toBe(false);
    });

    it("accepts a private tag, and keeps the query's defaults", () => {
        const result = bulkTagApplySchema.safeParse({
            query,
            kind: "tag",
            scope: "private",
            names: ["to cut"],
            expectedCount: 4,
        });

        expect(result.success).toBe(true);
        expect(result.data?.excludeIds).toEqual([]);
    });
});

describe("bulk acting on a selection", () => {
    /**
     * A discriminated union takes objects, so a refined arm is no longer one — the check sits
     * on the union instead. Which means the other arms pass through it, and that is the thing
     * worth checking.
     */
    it("refuses a private performer", () => {
        const result = bulkActionSchema.safeParse({
            action: "tag",
            mediaIds: ["m1"],
            kind: "performer",
            scope: "private",
            names: ["Jane Doe"],
        });

        expect(result.success).toBe(false);
    });

    it("leaves the other actions alone", () => {
        expect(
            bulkActionSchema.safeParse({ action: "rate", mediaIds: ["m1"], rating: 4 }).success
        ).toBe(true);
        expect(bulkActionSchema.safeParse({ action: "trash", mediaIds: ["m1"] }).success).toBe(
            true
        );
    });

    /**
     * The refinement reads `value.kind`, which an untag does not have.
     *
     * Worth pinning precisely because it looks like it should fail: a check written for the
     * tag arm must not reject the arm that carries neither a facet nor a scope, or removing a
     * tag becomes impossible for the reason that nothing on the request says which system it
     * is in -- which is the whole point of taking ids.
     */
    it("lets an untag past the private-facet check", () => {
        expect(
            bulkActionSchema.safeParse({ action: "untag", mediaIds: ["m1"], tagIds: ["t1"] })
                .success
        ).toBe(true);
    });

    it("refuses an untag that names no tag, and one that names too many", () => {
        expect(
            bulkActionSchema.safeParse({ action: "untag", mediaIds: ["m1"], tagIds: [] }).success
        ).toBe(false);
        expect(
            bulkActionSchema.safeParse({
                action: "untag",
                mediaIds: ["m1"],
                tagIds: Array.from({ length: SELECTION_TAG_LIMIT + 1 }, (_, i) => `t${i}`),
            }).success
        ).toBe(false);
    });
});
