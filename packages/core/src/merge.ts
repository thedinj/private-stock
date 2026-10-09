/**
 * Folding one copy's record into the copy that outlives it (§10c).
 *
 * When a duplicate is eliminated, everything a person recorded about it has to land on the
 * copy they kept. Losing a rating because an administrator tidied up the library is exactly
 * the failure §10 already refused for the file itself ("an undo that silently discards
 * everything a person recorded about an item is not an undo") -- and it is worse here,
 * because nothing was undone and nobody was asked.
 *
 * **Nobody is asked.** A conflict between two copies of the same thing is not a question
 * worth a dialogue: the person deleting a duplicate is thinking about disk space, not about
 * which of two view counts is the real one, and a prompt would only teach them to click
 * through it. So every rule below resolves itself, and each is chosen so that eliminating a
 * copy can never take something away.
 *
 * Pure, and separate from the SQL, because the rules are the part worth arguing about and
 * the part that has to be testable without a database. They are also **commutative and
 * idempotent** wherever the data allows: a merge may run again on a re-delete, and a chain of
 * deletions must not depend on the order somebody worked through the group.
 */

/** The longest note the column will hold. Also the cap a merged pair is trimmed to. */
export const NOTE_MAX_LENGTH = 2000;

/** One viewer's record of one item — the mergeable half of `UserMedia`. */
export interface UserOverlay {
    rating: number | null;
    favorite: boolean;
    hidden: boolean;
    viewCount: number;
    /** ISO-ish SQLite datetime, or null if never opened. */
    lastViewedAt: string | null;
    watchedAt: string | null;
    note: string | null;
}

export const EMPTY_OVERLAY: UserOverlay = {
    rating: null,
    favorite: false,
    hidden: false,
    viewCount: 0,
    lastViewedAt: null,
    watchedAt: null,
    note: null,
};

/** Later of two timestamps, treating null as "never". */
const latest = (a: string | null, b: string | null): string | null => {
    if (!a) return b;
    if (!b) return a;

    return a >= b ? a : b;
};

/** Earlier of two timestamps, treating null as "never" rather than as the beginning of time. */
const earliest = (a: string | null, b: string | null): string | null => {
    if (!a) return b;
    if (!b) return a;

    return a <= b ? a : b;
};

/**
 * Two notes, as one note.
 *
 * Neither is discarded, because a note is the one field here that cannot be reconstructed
 * from anything else — a rating can be given again in a second, a paragraph somebody wrote
 * about an item cannot. Order is heir first: it is the note attached to the copy that
 * survives, so it stays where its author left it and the arriving text reads as an addition.
 *
 * Deduplicated by containment rather than by equality, so a merge that runs twice — or a
 * third copy carrying the text a second already contributed — does not stack the same
 * paragraph up. That is what makes this idempotent, which matters more than it looks:
 * appending is the only rule here that would otherwise grow every time it ran.
 *
 * Trimmed to the column's limit when the pair is too long, deliberately rather than dropping
 * one side. Losing the tail of two very long notes is a smaller loss than losing one of them
 * whole, and the alternative — refusing to merge — is the silent data loss this exists to
 * prevent.
 */
export const mergeNotes = (heir: string | null, departing: string | null): string | null => {
    const kept = heir?.trim() ?? "";
    const arriving = departing?.trim() ?? "";

    if (!arriving) return kept || null;
    if (!kept) return arriving;
    if (kept.includes(arriving)) return kept;

    return `${kept}\n\n${arriving}`.slice(0, NOTE_MAX_LENGTH);
};

/**
 * One viewer's two records, reconciled.
 *
 * The rules, and why each one is the intuitive answer rather than merely an answer:
 *
 * - **Rating — the higher of the two.** A rating is an opinion about the content, and these
 *   are copies of the same content; taking the maximum means removing a copy can never lower
 *   what the library thinks of what is left. "Whichever was edited last" was the alternative
 *   and it cannot be implemented honestly: `updatedAt` is per row, so it cannot say whether
 *   the rating or the note was the thing edited.
 * - **Favourite — either.** Un-favouriting something as a side effect of a delete would be a
 *   loss, and there is no reading under which deleting a copy means you like it less.
 * - **Hidden — the heir's own, never inherited.** This is the one field that does not flow,
 *   and the asymmetry is the point: hiding is a statement about a row in your grid, not about
 *   the content, and the commonest reason to hide something is that it is a duplicate you did
 *   not want to look at. Inheriting it would make the copy you deliberately kept vanish from
 *   the library at the moment you tidied up — an elimination that looks like it deleted the
 *   wrong file.
 * - **View count — the higher of the two, not the sum.** Adding them is the more accurate
 *   number and it is the one rule here that cannot be made safe to repeat: a copy trashed,
 *   restored and trashed again would have its views counted twice, and telling that second
 *   merge from the first would mean recording every merge the app has ever done, for no other
 *   purpose. The higher count never overstates, never falls, and costs at most an undercount
 *   on an item somebody watched from both copies.
 * - **Last viewed — the later.**
 * - **Watched — the earlier.** The column records when you *first* finished with the item,
 *   which is what `markWatched` already promises by refusing to move it on a rewatch.
 * - **Note — kept, both of them.** See `mergeNotes`.
 */
export const mergeOverlay = (heir: UserOverlay, departing: UserOverlay): UserOverlay => {
    return {
        rating: Math.max(heir.rating ?? 0, departing.rating ?? 0) || null,
        favorite: heir.favorite || departing.favorite,
        hidden: heir.hidden,
        viewCount: Math.max(heir.viewCount, departing.viewCount),
        lastViewedAt: latest(heir.lastViewedAt, departing.lastViewedAt),
        watchedAt: earliest(heir.watchedAt, departing.watchedAt),
        note: mergeNotes(heir.note, departing.note),
    };
};

/** Whether merging would change anything, so an untouched copy costs no write. */
export const overlayEquals = (a: UserOverlay, b: UserOverlay): boolean =>
    a.rating === b.rating &&
    a.favorite === b.favorite &&
    a.hidden === b.hidden &&
    a.viewCount === b.viewCount &&
    a.lastViewedAt === b.lastViewedAt &&
    a.watchedAt === b.watchedAt &&
    a.note === b.note;
