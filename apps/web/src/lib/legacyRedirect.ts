import { redirect } from "next/navigation";

/**
 * Where the admin area's old addresses went (§12c).
 *
 * The review queues moved under `/review` and the admin page split into hubs, but addresses
 * outlive layouts: they are in bookmarks, in a device's remembered sidebar links and in links
 * other pages still print. Each old page is now a redirect that keeps the query, so a remembered
 * tab or search arrives intact -- and the one old tab that moved to a different page entirely
 * (OCR's settings and bench) is mapped by name rather than dropped.
 *
 * Server pages rather than `redirects()` in the Next config, because two of them choose their
 * destination by a query parameter, and the config's query handling merges rather than replaces.
 */
export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const queryOf = (
    params: Record<string, string | string[] | undefined>,
    drop: string[] = []
): string => {
    const query = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
        if (drop.includes(key) || value === undefined) continue;

        for (const one of Array.isArray(value) ? value : [value]) {
            query.append(key, one);
        }
    }

    const text = query.toString();

    return text ? `?${text}` : "";
};

/** A moved page whose query means the same thing at its new address. */
export const movedTo =
    (path: string) =>
    async ({ searchParams }: { searchParams: SearchParams }): Promise<never> =>
        redirect(`${path}${queryOf(await searchParams)}`);
