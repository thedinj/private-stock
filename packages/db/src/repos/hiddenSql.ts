/**
 * "Not hidden by this viewer", as a SQL fragment for browsers that list things *of* an item.
 *
 * Hiding is a standing instruction — "do not show me this" (§6) — and the grid and playlists
 * honour it. The Captures and Clips browsers did not: a person's own stills and clips of an item
 * they had put away kept appearing there, which is the item coming back through a side door.
 *
 * Probes `idx_UserMedia_hidden`, which holds only hidden rows, as the tag counts do — named,
 * because the planner otherwise takes the primary key and reads a page of somebody's ratings and
 * positions per row. `mediaIdExpr` is the column holding the item's id in the caller's query.
 */
export const notHiddenSql = (mediaIdExpr: string, userParam = ":userId"): string =>
    `NOT EXISTS (SELECT 1 FROM "UserMedia" um INDEXED BY "idx_UserMedia_hidden"
                  WHERE um."userId" = ${userParam} AND um."mediaId" = ${mediaIdExpr}
                    AND um."hidden" IS NOT NULL)`;
