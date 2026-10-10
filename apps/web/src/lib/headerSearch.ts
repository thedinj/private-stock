"use client";

import { useCallback, useEffect, useState } from "react";

import type { TagScope } from "@private-stock/core";

import { DEFAULT_VIEW, viewToParams, withLook } from "@/lib/libraryQuery";

/**
 * The header search (§14 "The header search"): one box on every page, asking one of five kinds of
 * question. Each kind already had a page that takes the words in its address, so the box mostly
 * chooses where to send them.
 */
export const SEARCH_TYPES = ["library", "performer", "source", "keyword", "look"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchTypeInfo {
    label: string;
    /** Says the kind inside the box, so a remembered kind is never a surprise. */
    placeholder: string;
    /**
     * The facet whose names are suggested while typing, and the systems searched for them, or null
     * for a kind with nothing discrete to suggest -- text and looks are not names.
     */
    suggest: { kind: string; scopes: TagScope[] } | null;
}

export const SEARCH_TYPE_INFO: Record<SearchType, SearchTypeInfo> = {
    library: { label: "Library", placeholder: "Search the library", suggest: null },
    performer: {
        label: "Performer",
        placeholder: "Find a performer",
        suggest: { kind: "performer", scopes: ["public"] },
    },
    source: {
        label: "Source",
        placeholder: "Find a source",
        suggest: { kind: "source", scopes: ["public"] },
    },
    keyword: {
        label: "Keyword",
        placeholder: "Find a keyword",
        // Yours first, as the keywords page lists them.
        suggest: { kind: "tag", scopes: ["private", "public"] },
    },
    look: { label: "Look", placeholder: "Looks like…", suggest: null },
};

/** The server's cap on a search, here so a long paste lands as a search rather than a 400. */
const MAX_TEXT = 200;

/**
 * Where pressing Enter goes, or null when nothing is typed.
 *
 * The library and a look land on a **clean** library: a new question, not a refinement of
 * whatever was open. Refining is what the library's own box is for. Tag kinds land on their browse
 * page, filtered, because "jan" may well be three people.
 */
export const searchHref = (type: SearchType, typed: string): string | null => {
    const text = typed.trim().slice(0, MAX_TEXT);

    if (text === "") return null;

    const clean = { ...DEFAULT_VIEW, mode: "grid" as const };
    const q = new URLSearchParams({ q: text }).toString();

    switch (type) {
        case "library":
            return `/?${viewToParams({ ...clean, search: text })}`;
        case "look":
            return `/?${viewToParams(withLook(clean, { lookText: text }))}`;
        case "performer":
            return `/tags/performers?${q}`;
        case "source":
            return `/tags/sources?${q}`;
        case "keyword":
            return `/tags/keywords?${q}`;
    }
};

/** A stored kind read back, or the library for anything unrecognised. */
export const parseSearchType = (stored: string | null): SearchType =>
    SEARCH_TYPES.find((type) => type === stored) ?? "library";

const KEY = "ps:headerSearchType";

/**
 * The kind last asked, remembered on the device rather than the account -- like the playback
 * preferences, it is a habit of where you are sitting. Read after mount so the server and the
 * client agree about the first markup.
 */
export const useSearchType = (): [SearchType, (type: SearchType) => void] => {
    const [type, setType] = useState<SearchType>("library");

    useEffect(() => {
        try {
            setType(parseSearchType(localStorage.getItem(KEY)));
        } catch {
            // Private window or storage off: the library, which it already holds.
        }
    }, []);

    const remember = useCallback((next: SearchType) => {
        setType(next);

        try {
            localStorage.setItem(KEY, next);
        } catch {
            // Not remembered; the choice still holds for this page.
        }
    }, []);

    return [type, remember];
};
