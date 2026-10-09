/**
 * The SQL half of `tagNamePatterns` (§5b): one tag name or alias, matched the two ways.
 *
 * Shared by every box that finds a tag by typing and by the private-tag half of the library
 * search, so a name that one of them finds the other finds too.
 *
 * `alias` is the table alias holding a `nameNorm` column — a `Tag` or a `TagAlias`. The two
 * parameters are bound to `TagNamePatterns.words` and `.squashed`. No index serves either
 * pattern, and none needs to: this scans a vocabulary of thousands, not the library.
 */
export const tagNameMatchSql = (alias: string, wordsParam: string, squashedParam: string): string =>
    `((' ' || ${alias}."nameNorm") LIKE :${wordsParam} ESCAPE '\\'
      OR replace(${alias}."nameNorm", ' ', '') LIKE :${squashedParam} ESCAPE '\\')`;
