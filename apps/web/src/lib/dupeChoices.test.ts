import { describe, expect, it } from "vitest";

import type { DupeGroup, DupeMember } from "@private-stock/core";

import { choiceFor, noChoices, withChoice, withoutChoices } from "./dupeChoices";

/**
 * The sheet's decisions, kept across a trip into an item (§10c). What matters is the one way a
 * kept decision could do harm: applied to a group that has changed since it was made.
 */

const group = (ids: string[], id = "g"): DupeGroup =>
    ({ id, kind: "near", members: ids.map((m) => ({ id: m }) as DupeMember) }) as DupeGroup;

describe("kept decisions", () => {
    it("comes back for the same group, whatever order its copies arrive in", () => {
        const choices = withChoice(noChoices(), group(["a", "b"]), { keep: "b", tick: true });

        expect(choiceFor(choices, group(["b", "a"]))).toMatchObject({ keep: "b", tick: true });
    });

    it("is dropped for a group that gained a copy, rather than trashing one nobody saw", () => {
        const choices = withChoice(noChoices(), group(["a", "b"]), { tick: true });

        expect(choiceFor(choices, group(["a", "b", "c"]))).toBeUndefined();
    });

    it("starts afresh when a changed group is decided again", () => {
        const before = withChoice(noChoices(), group(["a", "b"]), { keep: "b", tick: true });
        const after = withChoice(before, group(["a", "b", "c"]), { keep: "c" });

        expect(choiceFor(after, group(["a", "b", "c"]))).toEqual({
            keep: "c",
            members: "a,b,c",
        });
    });

    it("adds to a group's choices, and forgets the groups that were settled", () => {
        const both = withChoice(
            withChoice(noChoices(), group(["a", "b"]), { keep: "b" }),
            group(["a", "b"]),
            { tick: true }
        );

        expect(choiceFor(both, group(["a", "b"]))).toMatchObject({ keep: "b", tick: true });
        expect(choiceFor(withoutChoices(both, ["g"]), group(["a", "b"]))).toBeUndefined();
    });
});
