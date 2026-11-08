import { z } from "zod";

import type { tagKinds } from "./domain.js";

/** The facets the app offers (§5b), the ones a domain relabels. */
type OfferedTagKind = (typeof tagKinds)[number];

/**
 * Domains: what kind of collection a library holds (ARCHITECTURE.md §21).
 *
 * Every library belongs to exactly one, and the app is always *in* one. Being in a domain
 * narrows every read to that domain's libraries, so the family videos and the cellar never
 * share a grid, a search or a suggestion.
 *
 * The list is code, not a table. Each domain carries a look and a vocabulary, and a row would
 * need a theme editor to mean anything. Like `tagKinds`, there is no CHECK on the column, so
 * adding a domain is an edit and not a migration.
 *
 * The keys say what the content is. The labels are the house it lives in, and the labels can
 * change without touching a row.
 */
export const domainKinds = ["family", "cellar", "games"] as const;
export const domainKindSchema = z.enum(domainKinds);
export type DomainKind = z.infer<typeof domainKindSchema>;

/**
 * Where a browser with no memory of a domain starts.
 *
 * The family room, not the cellar. A browser that has forgotten where it was is the browser
 * most likely to be in front of somebody else, so it opens on the domain that is safe to show.
 */
export const DEFAULT_DOMAIN: DomainKind = "family";

/** The library every root created before domains existed belongs to. */
export const LEGACY_DOMAIN: DomainKind = "cellar";

/** The request header the browser's API client sends with every call. */
export const DOMAIN_HEADER = "x-ps-domain";

/** The query parameter for requests that cannot set a header (`EventSource`). */
export const DOMAIN_PARAM = "domain";

export interface FacetLabel {
    /** Singular, as a box is titled: "Performer", "Person", "Game". */
    one: string;
    /** Plural, as a list is titled. */
    many: string;
}

export interface DomainProfile {
    kind: DomainKind;
    label: string;
    /** Whether entering it asks for the screen-lock PIN (§21 "Getting into the cellar"). */
    guarded: boolean;
    /**
     * What the room switcher's hidden line says, for a guarded room (§21 "Getting into the
     * cellar"): the line is not listed until the menu is held, and this is all it says. Null
     * for a room that is listed like any other.
     */
    entrance: string | null;
    /** What each facet is called here. The stored kind never changes. */
    facets: Record<OfferedTagKind, FacetLabel>;
    /**
     * Pipeline stages that do not apply to this room's items (§21 "Stages a room does not
     * use"), recorded `skipped` without being run. A fact about the content, not a setting: a
     * face detector has nothing to find in a game's frames, OCR reads a HUD as noise, and the
     * CPU either would spend is the NAS's whole budget. Subtracted from the Processing page's
     * switches, never added to them.
     */
    skipsStages: readonly string[];
    /**
     * Where the part worth seeing sits in an item (§21 "Where a room looks first"). Null is the
     * whole of it. A number is "the last this-many milliseconds": a game recording is saved
     * after the moment it was saved for, so the moment is at its end -- the viewer opens there,
     * the tasting plays it and the hover preview is cut from it.
     */
    tailMs: number | null;
    /**
     * Whether the sidebar offers the backlog -- "To review", the library at "Not reviewed",
     * oldest first (§14d "Reviewing recordings for a reel"). The filter itself is in every room.
     */
    reviewPass: boolean;
}

/**
 * Each domain's vocabulary.
 *
 * **Relabelled, never renamed.** Internally a person in an item is a `performer` everywhere,
 * because that is what three hundred files and every stored row call it. A domain changes what
 * the box *says*, so the family room files people and the game room files players and games,
 * without a migration or a second code path.
 */
export const domainProfiles: Record<DomainKind, DomainProfile> = {
    family: {
        kind: "family",
        label: "Parlour",
        guarded: false,
        entrance: null,
        facets: {
            performer: { one: "Person", many: "People" },
            source: { one: "Source", many: "Sources" },
            tag: { one: "Keyword", many: "Keywords" },
        },
        // Look is for watching by look, which is the Cellar's idea; there is little text burned
        // into a family video to read.
        skipsStages: ["embed", "ocr"],
        tailMs: null,
        reviewPass: false,
    },
    cellar: {
        kind: "cellar",
        label: "Cellar",
        guarded: true,
        entrance: "The stair",
        facets: {
            performer: { one: "Performer", many: "Performers" },
            source: { one: "Source", many: "Sources" },
            tag: { one: "Keyword", many: "Keywords" },
        },
        skipsStages: [],
        tailMs: null,
        reviewPass: false,
    },
    games: {
        kind: "games",
        label: "Game Room",
        guarded: false,
        entrance: null,
        facets: {
            performer: { one: "Player", many: "Players" },
            source: { one: "Game", many: "Games" },
            tag: { one: "Keyword", many: "Keywords" },
        },
        // Players are filed by hand and from filenames. OCR would read the HUD -- ammo counts and
        // killfeeds -- into the search index and the review queue. The duplicate fingerprints
        // stay: a highlight saved raw, trimmed and re-encoded is the duplicate most worth finding.
        skipsStages: ["faces", "embed", "ocr"],
        // Saved after the fact, so the moment is in the last seconds (§14d "Reviewing
        // recordings for a reel").
        tailMs: 10_000,
        reviewPass: true,
    },
};

/** A stored or sent value, read leniently: anything unknown is not a domain. */
export const parseDomain = (raw: string | null | undefined): DomainKind | null => {
    const parsed = domainKindSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
};

/**
 * Whether an item in this room skips a stage. A domain the code does not know (a row written by
 * a newer build, read by an older one) skips nothing: running a stage is the safe mistake.
 */
export const domainSkipsStage = (domain: string | null | undefined, stage: string): boolean => {
    const known = parseDomain(domain);

    return known !== null && domainProfiles[known].skipsStages.includes(stage);
};

/** The room's tail, or null when it looks at the whole item. Unknown rooms look at the whole. */
export const domainTailMs = (domain: string | null | undefined): number | null => {
    const known = parseDomain(domain);

    return known === null ? null : domainProfiles[known].tailMs;
};

/**
 * Where an item opens in this room: the start of its tail, or null for "the beginning, as
 * usual". Null too when the length is not known yet, and never below zero for an item shorter
 * than the tail -- that one is all tail.
 */
export const tailStartMs = (
    domain: string | null | undefined,
    durationMs: number | null | undefined
): number | null => {
    const tail = domainTailMs(domain);

    if (tail === null || durationMs == null || !Number.isFinite(durationMs) || durationMs <= 0) {
        return null;
    }

    return Math.max(0, Math.round(durationMs - tail));
};
