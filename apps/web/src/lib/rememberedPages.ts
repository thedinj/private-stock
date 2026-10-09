"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { parseView } from "./libraryQuery";
import { NO_SUMMARY_NAMES, summarizeSearch } from "./searchSummary";

/**
 * Where each list page was when you last left it (§14b).
 *
 * A page's view lives in its address (`urlView.ts`), which is what makes Back work. The
 * sidebar's links were fixed addresses, though, so stepping out to Tags and back through the
 * sidebar put every page back at its defaults -- the Duplicates tab, the Clips search, a
 * Manage table's page. So the address is remembered, and the sidebar points at what you last
 * had. A remembered address is an ordinary one: every other way in -- a link, a shelf, a
 * shared address -- still says exactly what it means.
 *
 * **On the device, not the account.** What you were last looking at is a property of where you
 * are sitting; the desktop and the phone are allowed to disagree, and restoring a sidebar link
 * is not worth a round trip.
 *
 * **Recorded in one place.** `useRememberPages` runs in the sidebar, which already reads the
 * address, so a page opts in by being listed below rather than by remembering itself.
 */

/**
 * The library, the first time anybody opens it.
 *
 * The grid, on the videos -- which an address without a `kind` now is everywhere, not only on
 * this first link (§14e "Videos unless you ask"). It used to say `kind=video` itself, and every
 * other way into the library opened on everything.
 */
export const FIRST_LIBRARY_QUERY = "view=grid";

interface RememberedPage {
    path: string;
    key: string;
    /** The query the link carries before anything has been remembered. */
    fallbackQuery: string;
    /** Whether this particular address is worth remembering. Absent means always. */
    remember?: (params: URLSearchParams) => boolean;
}

/**
 * `key` is given for a page that moved: the key it had at its old address, so a remembered tab
 * or search survives the move rather than being forgotten by it.
 */
const page = (path: string, key = `ps:page:${path}`): RememberedPage => ({
    path,
    key,
    fallbackQuery: "",
});

export const REMEMBERED_PAGES: RememberedPage[] = [
    {
        path: "/",
        // The key it has always had, so nobody's remembered library is lost to the move.
        key: "ps:libraryView",
        fallbackQuery: FIRST_LIBRARY_QUERY,
        // Only a search. The room shares the library's path and is the front door, not a view,
        // and the library as it opens -- or one library as its own row opens it -- is what the
        // sidebar already links to. Remembering either would replace the search you left with
        // the clean library you passed through on the way to a new one, so stepping into the
        // Library to look around would cost you "Last search" (§14b).
        remember: (params) => {
            const view = parseView(params);

            return view.mode !== "room" && summarizeSearch(view, NO_SUMMARY_NAMES) !== null;
        },
    },
    page("/captures"),
    page("/collections"),
    page("/clips"),
    page("/reels"),
    page("/review/duplicates", "ps:page:/duplicates"),
    page("/review/ocr", "ps:page:/ocr"),
    page("/review/faces"),
    page("/review/unreadable", "ps:page:/unreadable"),
    page("/review/trash"),
    page("/tags/performers"),
    page("/tags/sources"),
    page("/tags/keywords"),
    page("/tags/manage"),
];

const entryFor = (path: string): RememberedPage | undefined =>
    REMEMBERED_PAGES.find((entry) => entry.path === path);

/**
 * A sidebar entry that stands for several pages, and returns to whichever was used last.
 *
 * Review is one entry over five queues, and Studio one over Captures, Clips and Reels. Each points
 * at the page you were last on -- that page's own remembered address included -- rather than
 * always at the first. A page's own sub-pages count as it (a reel counts as Reels), and what is
 * recorded is the page, so the entry returns to the list rather than to one reel.
 */
interface RememberedSection {
    name: string;
    key: string;
    pages: string[];
}

const REMEMBERED_SECTIONS: RememberedSection[] = [
    {
        name: "review",
        key: "ps:section:/review",
        pages: [
            "/review/duplicates",
            "/review/ocr",
            "/review/faces",
            "/review/unreadable",
            "/review/trash",
        ],
    },
    { name: "studio", key: "ps:section:studio", pages: ["/captures", "/clips", "/reels"] },
];

export type RememberedSectionName = "review" | "studio";

/** The section a path is in, and which of its pages; null when it is in none. */
const sectionFor = (pathname: string): { section: RememberedSection; page: string } | null => {
    for (const section of REMEMBERED_SECTIONS) {
        const page = section.pages.find(
            (candidate) => pathname === candidate || pathname.startsWith(`${candidate}/`)
        );

        if (page) return { section, page };
    }

    return null;
};

/** Whoever is showing a remembered address, told when one changes. */
const listeners = new Set<() => void>();

/**
 * Records an address, if its page is one that is remembered.
 *
 * The whole query, page and shuffle seed included: coming back is a return to exactly the list
 * you left. A page the list no longer reaches is the page's to correct once it knows the count.
 */
export const rememberPage = (pathname: string, search: string): void => {
    const entry = entryFor(pathname);
    const section = sectionFor(pathname);

    if (!section && (!entry || (entry.remember && !entry.remember(new URLSearchParams(search))))) {
        return;
    }

    try {
        if (entry && (!entry.remember || entry.remember(new URLSearchParams(search)))) {
            localStorage.setItem(entry.key, search);
        }
        if (section) {
            localStorage.setItem(section.section.key, section.page);
        }
    } catch {
        // A private window, or site data turned off. The link falls back to the page's plain
        // address, which is a worse link and not a broken one.
    }

    for (const listener of listeners) {
        listener();
    }
};

/** Records the current address whenever it changes. Called once, by the sidebar. */
export const useRememberPages = (): void => {
    const pathname = usePathname();
    const search = useSearchParams().toString();

    useEffect(() => {
        rememberPage(pathname, search);
    }, [pathname, search]);
};

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
};

const hrefOf = (path: string, query: string): string => (query ? `${path}?${query}` : path);

/** The query a remembered page was last left at, or null when nothing has been remembered. */
const useRememberedQuery = (path: string): string | null => {
    const entry = entryFor(path);

    return useSyncExternalStore(
        subscribe,
        () => {
            if (!entry) return null;

            try {
                return localStorage.getItem(entry.key);
            } catch {
                return null;
            }
        },
        () => null
    );
};

/**
 * Where a link to a remembered page should point: the address it was last left at.
 *
 * **Subscribed, not read once.** The sidebar mounts once per page load, so a read on mount froze
 * its links at whatever was stored when the app opened. Every `rememberPage` notifies it.
 *
 * The server snapshot is the plain address, for the reason every preference here is: the server
 * has no `localStorage`, so the markup Next sent carries the default and hydration swaps in the
 * remembered address immediately after -- on a link, which nobody can click in that gap.
 */
export const useRememberedHref = (path: string): string => {
    const fallback = entryFor(path)?.fallbackQuery ?? "";

    return hrefOf(path, useRememberedQuery(path) ?? fallback);
};

/**
 * The search the library was last left at, or null when there is none to go back to (§14b).
 *
 * The sidebar's Library entry opens the library clean, and this is its "Last search" row: a
 * remembered search used to be the only way the entry went, and every visit paid for the old
 * filter and sort before a new one could be asked for.
 */
export const useLastLibrarySearch = (): string | null => useRememberedQuery("/");

/**
 * The names of the tags the library's searches have used, by id (§14b).
 *
 * The line under "Last search" says a search by its tags' names, and the sidebar cannot ask for
 * them: the one request that knows them is the facets for that search, which is the cost the
 * clean Library link exists to avoid. The library page has them on screen anyway, so it writes
 * them down as it goes. A name never written down is said as "a tag" -- an older search, or one
 * left before its facets came back.
 */
const TAG_NAMES_KEY = "ps:libraryTagNames";

/** Enough for the last several searches; the oldest go first. */
const TAG_NAMES_KEPT = 200;

export const rememberTagNames = (names: Record<string, string>): void => {
    try {
        const merged = { ...readTagNames(localStorage.getItem(TAG_NAMES_KEY)) };

        for (const [id, name] of Object.entries(names)) {
            // Re-inserted, so a name used again moves to the newest end.
            delete merged[id];
            merged[id] = name;
        }

        const kept = Object.entries(merged).slice(-TAG_NAMES_KEPT);

        localStorage.setItem(TAG_NAMES_KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch {
        // As for the addresses: the line falls back to "a tag", which is vaguer and not wrong.
        return;
    }

    for (const listener of listeners) {
        listener();
    }
};

const readTagNames = (raw: string | null): Record<string, string> => {
    if (!raw) return {};

    try {
        const parsed: unknown = JSON.parse(raw);

        return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
        return {};
    }
};

/** The remembered tag names. Subscribed, like the addresses, and parsed once per change. */
export const useRememberedTagNames = (): Record<string, string> => {
    const raw = useSyncExternalStore(
        subscribe,
        () => {
            try {
                return localStorage.getItem(TAG_NAMES_KEY);
            } catch {
                return null;
            }
        },
        () => null
    );

    return useMemo(() => readTagNames(raw), [raw]);
};

/**
 * Where a section's sidebar entry should point: its last-used page, at that page's own
 * remembered address. Subscribed for the same reason `useRememberedHref` is.
 */
export const useRememberedSectionHref = (name: RememberedSectionName): string => {
    const section = REMEMBERED_SECTIONS.find((candidate) => candidate.name === name);
    const fallback = section?.pages[0] ?? "/";

    const path = useSyncExternalStore(
        subscribe,
        () => {
            if (!section) return fallback;

            try {
                return localStorage.getItem(section.key) ?? fallback;
            } catch {
                return fallback;
            }
        },
        () => fallback
    );

    return useRememberedHref(path);
};
