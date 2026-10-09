import type { MediaSort } from "@private-stock/core";

/**
 * What each sort and each of its directions is called (§14e).
 *
 * Here rather than in the library page because the sidebar's "Last search" says them too, and
 * a sort that read one way in the toolbar and another in the sidebar would look like two.
 */

export const SORT_LABELS: Record<MediaSort, string> = {
    // "Date added" rather than "Recently added": the label names the field, because the
    // direction beside it names the order. "Recently added, oldest first" is a contradiction
    // somebody has to read twice, and it was on screen.
    addedAt: "Date added",
    capturedAt: "Date captured",
    title: "Title",
    duration: "Duration",
    size: "File size",
    resolution: "Resolution",
    // "Bit rate", two words, as the filter panel's row spells it.
    bitrate: "Bit rate",
    fps: "Frame rate",
    rating: "Rating",
    lastViewed: "Last viewed",
    random: "Shuffle",
    relevance: "Best match",
    look: "Best look match",
};

/**
 * What the two directions are called, per sort.
 *
 * Named rather than drawn as arrows because an arrow is ambiguous exactly where it matters:
 * "ascending" on a date could reasonably mean newest first or oldest first, and the person
 * reading it has to guess. "Newest" and "Oldest" cannot be misread.
 *
 * Keyed by sort so the words match what is being ordered. The ascending label comes first in
 * each pair.
 */
export const DIRECTION_LABELS: Record<MediaSort, [asc: string, desc: string]> = {
    addedAt: ["Oldest", "Newest"],
    capturedAt: ["Oldest", "Newest"],
    title: ["A–Z", "Z–A"],
    duration: ["Shortest", "Longest"],
    size: ["Smallest", "Largest"],
    resolution: ["Lowest", "Highest"],
    bitrate: ["Lowest", "Highest"],
    fps: ["Lowest", "Highest"],
    rating: ["Lowest", "Highest"],
    // Never-viewed items come last either way round (see mediaRepo's `nullsLast`), so
    // "Longest ago" is the oldest thing you did open, not everything you never have.
    lastViewed: ["Longest ago", "Most recent"],
    // Neither is offered: a permutation read backwards is just another permutation, and the
    // far end of relevance is "worst match", which nobody is looking for.
    random: ["", ""],
    relevance: ["", ""],
    look: ["", ""],
};
