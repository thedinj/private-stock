/**
 * SQL fragments for "does this item carry these tags", shared by the library and the clip browser.
 *
 * Both ask the same question of `MediaTag` -- the clip browser's "Video has" field is the library's
 * tag filter pointed at a clip's video -- so the visibility rule lives once. `mediaIdExpr` names
 * the column holding the item's id in the caller's query: `m."id"` in the library, `c."mediaId"`
 * for a clip.
 */

/** Assignments the viewer can see: the library's, and their own private ones (§6). */
const VISIBLE_ASSIGNMENT = `("userId" IS NULL OR "userId" = :userId)`;

/** Whether the item carries any of these tags, in a system the viewer can see. */
export const anyTagSql = (placeholders: string[], mediaIdExpr = `m."id"`): string =>
    `EXISTS (SELECT 1 FROM "MediaTag"
              WHERE "mediaId" = ${mediaIdExpr} AND "tagId" IN (${placeholders.join(", ")})
                AND ${VISIBLE_ASSIGNMENT})`;

/** Whether the item carries every one of these tags. The flat `tags` filter's shape. */
export const allTagsSql = (
    placeholders: string[],
    countParam: string,
    mediaIdExpr = `m."id"`
): string =>
    `${mediaIdExpr} IN (SELECT "mediaId" FROM "MediaTag"
                 WHERE "tagId" IN (${placeholders.join(", ")}) AND ${VISIBLE_ASSIGNMENT}
                 GROUP BY "mediaId"
                HAVING count(DISTINCT "tagId") = :${countParam})`;
