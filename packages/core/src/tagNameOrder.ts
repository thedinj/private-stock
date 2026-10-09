import { normalizeName } from "./domain.js";
import { squashName } from "./searchVariants.js";

/**
 * The order a tag box lists the names that match what was typed (§5b).
 *
 * Which names match is the server's search (`tagNamePatterns`, with its typo fallback); this only
 * orders them, and it used to run in the browser over the 500 most-used names, by a rule of its
 * own. Both now fold the way `normalizeName` does (§5b "One rule for names"), so "zoe" finds Zoë
 * and "Mary-Kate" is "mary kate". How a name matches comes first, and the count only breaks ties:
 *
 * 1. **The whole name**, so typing a name in full always puts it at the top.
 * 2. **The start of the name.**
 * 3. **The start of a word in it** — `doe` finds `Jane Doe`, which is how people remember names
 *    more often than by their first letters.
 * 4. **Anywhere** — only a glued spelling of four letters or more reaches the server's results
 *    this way, as `auntmarg` inside a longer glued name.
 *
 * The **glued spelling** counts at each level too (§5c "Word boundaries"): `auntmargaret`,
 * `aunt.margaret` and `Aunt Margaret` are the same name typed three ways.
 *
 * **An alias ranks just below a name at the same level**, so typing a maiden name in full puts
 * the tag filed under the married one first, but a name that genuinely starts with what was typed
 * is not pushed down by a tag that only has an alias starting that way.
 */

/** Below this a glued spelling is matched only at the start, as the server does. */
const SQUASHED_ANYWHERE_MIN = 4;

/** 0 whole, 1 start, 2 start of a word, 3 anywhere; null for no match. `needle` is normalised. */
const matchLevel = (text: string, needle: string): number | null => {
    const haystack = normalizeName(text);

    if (haystack === needle) return 0;
    if (haystack.startsWith(needle)) return 1;
    if (` ${haystack}`.includes(` ${needle}`)) return 2;
    if (haystack.includes(needle)) return 3;

    const squashedHaystack = squashName(text);
    const squashedNeedle = needle.replace(/ /g, "");

    if (squashedNeedle === "") return null;
    if (squashedHaystack === squashedNeedle) return 0;
    if (squashedHaystack.startsWith(squashedNeedle)) return 1;
    if (
        squashedNeedle.length >= SQUASHED_ANYWHERE_MIN &&
        squashedHaystack.includes(squashedNeedle)
    ) {
        return 3;
    }

    return null;
};

/**
 * Names matching `typed`, best match first.
 *
 * `names` arrives most used first, and that order survives as the tie-break. An empty `typed`
 * matches nothing.
 */
export const orderTagMatches = (
    names: string[],
    aliases: ReadonlyMap<string, string[]>,
    typed: string
): string[] => {
    const needle = normalizeName(typed);

    if (needle === "") return [];

    const ranked: { name: string; score: number; index: number }[] = [];

    names.forEach((name, index) => {
        // Doubled, so an alias -- one above its level -- sorts after a name at the same level
        // and before any name at the next.
        const scores: number[] = [];
        const own = matchLevel(name, needle);

        if (own !== null) scores.push(own * 2);

        for (const alias of aliases.get(name) ?? []) {
            const level = matchLevel(alias, needle);

            if (level !== null) scores.push(level * 2 + 1);
        }

        if (scores.length > 0) ranked.push({ name, score: Math.min(...scores), index });
    });

    return ranked.sort((a, b) => a.score - b.score || a.index - b.index).map((row) => row.name);
};
