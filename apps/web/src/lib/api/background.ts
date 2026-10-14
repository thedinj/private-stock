/**
 * Query meta for a fetch nobody is waiting on (§14, "Waiting").
 *
 * The header's activity rail shows while a query with nothing to show yet is fetching. A query
 * that only reads ahead -- the viewer's neighbouring pages, its "of 312", the up-next tiles --
 * has nothing to show yet either, but the person is looking at the item, not waiting for those,
 * so it carries this and the rail leaves it out. Polling needs no marking: a refetch of a query
 * that already has data never lights the rail.
 */
export const BACKGROUND = { background: true } as const;
