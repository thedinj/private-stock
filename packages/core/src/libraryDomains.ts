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
    /** What each facet is called here. The stored kind never changes. */
    facets: Record<OfferedTagKind, FacetLabel>;
    /**
     * Pipeline stages that do not apply to this room's items (§21 "Stages a room does not
     * use"), recorded `skipped` without being run. A fact about the content, not a setting: a
     * face detector has nothing to find in a game's frames, and the CPU it would spend is the
     * NAS's whole budget.
     */
    skipsStages: readonly string[];
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
        facets: {
            performer: { one: "Person", many: "People" },
            source: { one: "Source", many: "Sources" },
            tag: { one: "Keyword", many: "Keywords" },
        },
        skipsStages: [],
    },
    cellar: {
        kind: "cellar",
        label: "Cellar",
        guarded: true,
        facets: {
            performer: { one: "Performer", many: "Performers" },
            source: { one: "Source", many: "Sources" },
            tag: { one: "Keyword", many: "Keywords" },
        },
        skipsStages: [],
    },
    games: {
        kind: "games",
        label: "Game Room",
        guarded: false,
        facets: {
            performer: { one: "Player", many: "Players" },
            source: { one: "Game", many: "Games" },
            tag: { one: "Keyword", many: "Keywords" },
        },
        // Players are still filed, by hand, from filenames and from what is read on screen.
        skipsStages: ["faces"],
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
