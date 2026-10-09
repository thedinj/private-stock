"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useDebouncedValue } from "@mantine/hooks";

import type { SortDirection } from "@private-stock/core";

/**
 * A page's view state, kept in its address (§14b).
 *
 * A list page's tab, search, sort and page belong in the URL: that is what makes Back from an
 * item land where you were, what lets the sidebar return you there (`rememberedPages.ts`), and
 * what makes a view shareable. Held in component state instead, every drill-down reset it --
 * the Duplicates tab, the Clips search, the Manage tables' filters.
 *
 * The library, playlists and the item page keep their own parsers; they carry rules -- saved
 * filters, seeds, the room -- that a field list would obscure. Every other list page declares
 * its fields here instead of writing a parser, a serializer and a race guard of its own.
 */

/** One piece of view state: how it reads from and writes to a single URL parameter. */
export interface Field<T> {
    param: string;
    /** The value an absent parameter means. Never written: defaults stay out of the address. */
    fallback: T;
    parse: (raw: string | null) => T;
    /**
     * Method syntax on purpose: it lets a field of a narrower type -- a sort enum -- sit in a
     * map of fields of any type, which is all `Fields` needs to say.
     */
    format(value: T): string;
}

/** Free text, such as a search box. */
export const textField = (param: string): Field<string> => ({
    param,
    fallback: "",
    parse: (raw) => raw ?? "",
    format: (value) => value,
});

/** One of a fixed set. Anything else in the address -- a stale link, a hand edit -- reads as the default. */
export const enumField = <const V extends readonly string[]>(
    param: string,
    values: V,
    fallback: V[number]
): Field<V[number]> => ({
    param,
    fallback,
    parse: (raw) => (raw !== null && values.includes(raw) ? raw : fallback),
    format: (value) => value,
});

/** On or off, written as `1` when on. */
export const flagField = (param: string): Field<boolean> => ({
    param,
    fallback: false,
    parse: (raw) => raw === "1",
    format: () => "1",
});

const NO_IDS: string[] = [];

/**
 * A list of ids, comma-separated -- the spelling `tagIdListSchema` reads (§14).
 *
 * The empty list is one shared value, so an absent parameter compares equal to the fallback and
 * stays out of the address.
 */
export const idListField = (param: string): Field<string[]> => ({
    param,
    fallback: NO_IDS,
    parse: (raw) => (raw ? raw.split(",").filter(Boolean) : NO_IDS),
    format: (value) => value.join(","),
});

/** A zero-based page. Nonsense reads as the first page rather than an empty one. */
export const pageField = (param = "page"): Field<number> => ({
    param,
    fallback: 0,
    parse: (raw) => Math.max(0, Math.floor(Number(raw)) || 0),
    format: (value) => String(value),
});

/** A sort direction, or null for the sort's own natural one. */
export const directionField = (param: string): Field<SortDirection | null> => ({
    param,
    fallback: null,
    parse: (raw) => (raw === "asc" || raw === "desc" ? raw : null),
    format: (value) => value ?? "",
});

type Fields = Record<string, Field<unknown>>;

export type ViewOf<F extends Fields> = { [K in keyof F]: F[K] extends Field<infer T> ? T : never };

export interface ViewDefinition<F extends Fields> {
    path: string;
    defaults: ViewOf<F>;
    parse: (params: URLSearchParams) => ViewOf<F>;
    /**
     * The address of a view. Parameters the view does not own are kept from `current`, so
     * several views can share an address -- the Manage page's tables -- and live beside state
     * written by something else, such as a tag page's `seed`.
     */
    href: (view: ViewOf<F>, current?: URLSearchParams) => string;
}

/**
 * A view's fields, bound to a path.
 *
 * `prefix` puts every parameter under a namespace, for a page holding several independent
 * lists: `performer.shared.q` and `keyword.private.q` are two search boxes, not one.
 */
export const defineView = <F extends Fields>(
    path: string,
    fields: F,
    options: { prefix?: string } = {}
): ViewDefinition<F> => {
    const prefix = options.prefix ?? "";
    const entries = Object.entries(fields) as [keyof F & string, Field<unknown>][];
    const name = (field: Field<unknown>) => `${prefix}${field.param}`;

    const defaults = Object.fromEntries(
        entries.map(([key, field]) => [key, field.fallback])
    ) as ViewOf<F>;

    return {
        path,
        defaults,
        parse: (params) =>
            Object.fromEntries(
                entries.map(([key, field]) => [key, field.parse(params.get(name(field)))])
            ) as ViewOf<F>,
        href: (view, current) => {
            const params = new URLSearchParams(current);

            for (const [key, field] of entries) {
                params.delete(name(field));

                // Compared with the default rather than tested for truthiness: page 0 and an
                // empty search are defaults, but `false` is not always one. A value that writes
                // as nothing -- an emptied id list -- is left out like a default.
                const formatted = view[key] !== field.fallback ? field.format(view[key]) : "";

                if (formatted !== "") {
                    params.set(name(field), formatted);
                }
            }

            const query = params.toString();

            return query ? `${path}?${query}` : path;
        },
    };
};

/**
 * The address the last write asked for, until the router has caught up with it.
 *
 * `router.replace` commits in a transition, so two writes close together -- a debounced
 * search landing, then a click on a toggle -- would both start from the address as it was
 * before either, and the second would silently undo the first. Captures found it: typing a
 * search and toggling straight away left the list filtered and the address not.
 *
 * Module-level rather than per view, because views share an address: two Manage tables
 * written a moment apart race in exactly the same way.
 */
let pending: { from: string; to: string } | null = null;

const currentAddress = (): string => window.location.pathname + window.location.search;

/** The query a new write should build on: the pending one while the router is behind. */
const baseQuery = (): URLSearchParams => {
    const address = currentAddress();

    if (pending && pending.from === address) {
        return new URLSearchParams(pending.to.split("?")[1] ?? "");
    }

    pending = null;

    return new URLSearchParams(window.location.search);
};

/**
 * A view read from the address, and a way to change it.
 *
 * `apply` merges a patch into the view and replaces the address -- `replace`, not `push`, so a
 * search does not leave a history entry per keystroke and Back leaves the page rather than
 * stepping back through its filters.
 */
export const useUrlView = <F extends Fields>(
    definition: ViewDefinition<F>
): [ViewOf<F>, (patch: Partial<ViewOf<F>>) => void] => {
    const router = useRouter();
    const query = useSearchParams().toString();

    const view = useMemo(() => definition.parse(new URLSearchParams(query)), [definition, query]);

    const apply = useCallback(
        (patch: Partial<ViewOf<F>>) => {
            const base = baseQuery();
            const next = { ...definition.parse(base), ...patch };
            const href = definition.href(next, base);

            pending = { from: currentAddress(), to: href };
            router.replace(href, { scroll: false });
        },
        [definition, router]
    );

    return [view, apply];
};

/**
 * A search box whose settled value lives in the address.
 *
 * The box holds what is being typed; `onSettle` is called with it once typing pauses, which is
 * where the page writes it into its view. A search changed from outside -- Back, a link -- is
 * taken into the box, but the box's own write coming back is not, or it would throw away
 * whatever was typed while that write was in flight.
 */
export const useUrlSearch = (
    settled: string,
    onSettle: (search: string) => void,
    delay = 250
): [string, (search: string) => void] => {
    const [text, setText] = useState(settled);
    const [debounced] = useDebouncedValue(text, delay);
    const written = useRef(settled);
    const onSettleRef = useRef(onSettle);

    onSettleRef.current = onSettle;

    useEffect(() => {
        if (settled !== written.current) {
            written.current = settled;
            setText(settled);
        }
    }, [settled]);

    useEffect(() => {
        if (debounced !== written.current) {
            written.current = debounced;
            onSettleRef.current(debounced);
        }
    }, [debounced]);

    return [text, setText];
};
