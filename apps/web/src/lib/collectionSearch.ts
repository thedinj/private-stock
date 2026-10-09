/**
 * Whether a view or playlist matches what is typed into the Views & playlists search (§14c).
 *
 * Every word has to appear somewhere in the name or the description, in any order and any
 * case: "beach sun" finds "Sunny beach days". Words rather than one phrase because people
 * remember a collection by a couple of its words, not by their order.
 *
 * On the client, over lists the page already holds. A person keeps hundreds of these at most,
 * so a scan per keystroke costs nothing, and a server search would add a request to answer a
 * question the page already has the data for.
 */
export const matchesCollectionSearch = (
    row: { name: string; description: string | null },
    search: string
): boolean => {
    const words = search.toLocaleLowerCase().split(/\s+/).filter(Boolean);

    if (words.length === 0) {
        return true;
    }

    const haystack = `${row.name} ${row.description ?? ""}`.toLocaleLowerCase();

    return words.every((word) => haystack.includes(word));
};
