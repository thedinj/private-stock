/**
 * The library's ticked items, kept across a trip into the viewer and back (§14b).
 *
 * The grid unmounts when an item is opened, and its selection went with it -- so ticking three
 * items, opening one to check it, and pressing Back found nothing ticked. The ids cannot go in
 * the address, so they are kept in `sessionStorage` beside the address they were ticked on.
 *
 * **One slot, not a map.** It holds the selection of the last view the grid showed and nothing
 * else: changing the filter, the sort or the page overwrites it with that view's empty
 * selection, exactly as the grid clears its own. So the only way to get a selection back is to
 * come back to the very view it was made on, which is what keeps "a selection you can see is
 * a selection you can check" true -- nothing is restored onto a set it was not chosen from.
 *
 * Per tab, which is what `sessionStorage` gives, and matched on the signed-in user as well as
 * the address, so a tab signed in as someone else reads nothing.
 */

import { z } from "zod";

const KEY = "ps:librarySelection";

const slotSchema = z.object({
    owner: z.string(),
    ids: z.array(z.string()),
});

/** Who and where: a selection belongs to one user on one exact address. */
export const selectionOwner = (userId: string, address: string): string => `${userId} ${address}`;

/** The selection kept for `owner`, or none. */
export const readSelection = (owner: string): string[] => {
    try {
        const raw = sessionStorage.getItem(KEY);
        const parsed = raw ? slotSchema.safeParse(JSON.parse(raw)) : null;

        return parsed?.success && parsed.data.owner === owner ? parsed.data.ids : [];
    } catch {
        return [];
    }
};

/** Replaces the slot. An empty selection empties it rather than storing a list of nothing. */
export const writeSelection = (owner: string, ids: string[]): void => {
    try {
        if (ids.length === 0) {
            sessionStorage.removeItem(KEY);
        } else {
            sessionStorage.setItem(KEY, JSON.stringify({ owner, ids }));
        }
    } catch {
        // Private mode, or storage disabled. The selection still works; it just does not
        // survive leaving the page, which is how it always behaved.
    }
};
