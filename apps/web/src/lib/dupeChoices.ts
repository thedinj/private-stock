/**
 * The duplicate sheet's decisions, kept across a trip into an item and back (§10c).
 *
 * The sheet unmounts when an item is opened, and its decisions went with it: deciding ten
 * look-alikes, opening one to check it, and pressing Back found all ten undecided. Held in
 * `sessionStorage`, as the library's selection is (`librarySelection.ts`), per tab and matched on
 * the signed-in user and the sheet.
 *
 * **A decision belongs to the copies it was made about.** Each row's choices carry the group's
 * members as they were. If the group has changed since -- regrouped by a clustering pass, or
 * grown a copy -- the choices are dropped rather than applied to copies nobody looked at. A tick
 * restored onto a group with a new member would trash that member unseen.
 *
 * Kept per sheet rather than in one slot: there are only a handful of sheets (the tabs, under
 * the media control), and looking at the Identical tab should not cost the look-alikes decided
 * a minute ago.
 */

import { z } from "zod";

import type { DupeGroup } from "@private-stock/core";

const KEY = "ps:dupeChoices";

const rowChoiceSchema = z.object({
    /** The group's members when the choice was made, as `membersOf` writes them. */
    members: z.string(),
    keep: z.string().optional(),
    tick: z.boolean().optional(),
    sorting: z
        .object({ assign: z.record(z.string(), z.number()), keepers: z.array(z.string()) })
        .optional(),
});

const sheetSchema = z.object({
    rows: z.record(z.string(), rowChoiceSchema),
    /** The row the keyboard was on, so coming back puts it there again. */
    focusedId: z.string().nullable(),
});

const storeSchema = z.record(z.string(), sheetSchema);

export type RowChoice = z.infer<typeof rowChoiceSchema>;
export type SheetChoices = z.infer<typeof sheetSchema>;

export const noChoices = (): SheetChoices => ({ rows: {}, focusedId: null });

/** Who and which sheet: choices belong to one user on one sheet, whatever its page. */
export const choicesOwner = (userId: string, sheet: string): string => `${userId} ${sheet}`;

/** A group's members, order aside: what a choice has to still match to apply. */
const membersOf = (group: DupeGroup): string =>
    group.members
        .map((member) => member.id)
        .sort()
        .join(",");

/** The choices made on this group, if it is still the group they were made on. */
export const choiceFor = (choices: SheetChoices, group: DupeGroup): RowChoice | undefined => {
    const choice = choices.rows[group.id];

    return choice && choice.members === membersOf(group) ? choice : undefined;
};

/** The choices with this group's changed; a choice made on an older version of it is replaced. */
export const withChoice = (
    choices: SheetChoices,
    group: DupeGroup,
    change: Partial<Omit<RowChoice, "members">>
): SheetChoices => ({
    ...choices,
    rows: {
        ...choices.rows,
        [group.id]: { ...choiceFor(choices, group), ...change, members: membersOf(group) },
    },
});

/** The choices without these groups, once they are settled. */
export const withoutChoices = (choices: SheetChoices, groupIds: Iterable<string>): SheetChoices => {
    const rows = { ...choices.rows };

    for (const id of groupIds) delete rows[id];

    return { ...choices, rows };
};

const readStore = (): z.infer<typeof storeSchema> => {
    try {
        const raw = sessionStorage.getItem(KEY);
        const parsed = raw ? storeSchema.safeParse(JSON.parse(raw)) : null;

        return parsed?.success ? parsed.data : {};
    } catch {
        return {};
    }
};

/** The choices kept for `owner`, or none. */
export const readChoices = (owner: string): SheetChoices => readStore()[owner] ?? noChoices();

/** Replaces `owner`'s choices. Nothing to keep empties its entry rather than storing nothing. */
export const writeChoices = (owner: string, choices: SheetChoices): void => {
    try {
        const store = readStore();

        if (Object.keys(choices.rows).length === 0 && choices.focusedId === null) {
            delete store[owner];
        } else {
            store[owner] = choices;
        }

        sessionStorage.setItem(KEY, JSON.stringify(store));
    } catch {
        // Private mode, or storage disabled. The sheet still works; its decisions just do not
        // survive leaving it, which is how it always behaved.
    }
};
