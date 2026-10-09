/**
 * Turning what someone typed into an FTS5 query (§5c).
 *
 * This exists because FTS5's `MATCH` argument is a *language*, not a string. `AND`, `OR`,
 * `NOT`, `NEAR`, `*`, `^`, `:`, `(`, `)` and `"` all mean something, and anything that does
 * not parse raises an error rather than returning no rows. Passing a search box straight
 * through means a lone quote, a stray colon, or the perfectly reasonable search `AND` turns
 * into a 500 — and on a library of scene files, punctuation in the box is the normal case,
 * not the edge case.
 *
 * So the search box is treated as plain words, and this module is the only thing that ever
 * writes FTS5 syntax. Two intentional conveniences survive translation, because both are
 * things people already expect from every other search box:
 *
 *   - "a phrase in quotes" matches as a phrase
 *   - -word excludes it
 *
 * Everything else is literal text.
 */

import { normalizeName } from "./domain.js";

/**
 * Every token is emitted inside double quotes.
 *
 * Quoting is what makes an arbitrary token safe: inside a string, FTS5 treats `AND`, `-`,
 * `(` and the rest as ordinary characters. It is the difference between escaping a list of
 * dangerous characters -- which is only ever as complete as the last person to think about
 * it -- and there being no way to escape the context at all.
 *
 * The one character that *can* escape is `"` itself, which FTS5 escapes by doubling.
 */
const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;

/**
 * Characters that cannot appear inside a quoted FTS5 string.
 *
 * Quoting handles the syntax characters; this handles the tokenizer. `unicode61` splits on
 * anything that is not a letter or digit anyway, so leaving punctuation in a phrase only
 * creates tokens that can never match. Stripping it means `Jane's` finds `janes`.
 */
const stripPunctuation = (value: string): string =>
    value
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

interface Term {
    text: string;
    negated: boolean;
    phrase: boolean;
}

/**
 * Splits input into quoted phrases and bare words.
 *
 * An unclosed quote is treated as running to the end of the input rather than as an error:
 * while someone is typing `"jane d`, the quote is always unclosed, and refusing to search
 * until it is balanced makes as-you-type search flicker between results and an error.
 */
const tokenize = (raw: string): Term[] => {
    const terms: Term[] = [];
    const pattern = /(-?)"([^"]*)"?|(\S+)/g;

    for (const match of raw.matchAll(pattern)) {
        const [, phraseNegation, phraseBody, bareWord] = match;

        if (phraseBody !== undefined) {
            const text = stripPunctuation(phraseBody);

            if (text) {
                terms.push({ text, negated: phraseNegation === "-", phrase: true });
            }

            continue;
        }

        if (bareWord === undefined) {
            continue;
        }

        const negated = bareWord.startsWith("-");
        const text = stripPunctuation(negated ? bareWord.slice(1) : bareWord);

        if (text) {
            // Stripping punctuation can split one bare word into several ("s01e02-final"),
            // and each part is its own term.
            for (const part of text.split(" ")) {
                terms.push({ text: part, negated, phrase: false });
            }
        }
    }

    return terms;
};

export interface BuildMatchOptions {
    /**
     * Whether the last word should match as a prefix.
     *
     * On by default, and the reason the schema declares `prefix='2 3'`: while someone types
     * "wom", they mean "wombat", and a search that returns nothing until the word is finished
     * reads as a search that does not work. Turn it off for a submitted query where the user
     * has finished typing and exact matching is less surprising.
     *
     * Only the last term gets it. Prefix-matching every word makes short queries match
     * enormous portions of the library and ranks them all alike.
     */
    prefixLastTerm?: boolean;
}

/**
 * Builds the `MATCH` expression, or null when there is nothing to search for.
 *
 * Null rather than an empty string, and callers must treat it as "apply no text filter":
 * `MATCH ''` is a syntax error, and `MATCH '""'` matches nothing at all, so a query that is
 * entirely punctuation would otherwise return an empty library instead of the full one.
 */
export const buildMatchExpression = (
    raw: string,
    options: BuildMatchOptions = {}
): string | null => {
    const terms = tokenize(raw ?? "");
    const positive = terms.filter((term) => !term.negated);
    const negative = terms.filter((term) => term.negated);

    // A query of nothing but exclusions has no result set to subtract from. FTS5 rejects a
    // leading NOT, and "everything except X" is not what a search box is for.
    if (positive.length === 0) {
        return null;
    }

    const prefixLast = options.prefixLastTerm ?? true;
    const lastPositive = positive[positive.length - 1];

    const render = (term: Term, allowPrefix: boolean): string => {
        const quoted = quote(term.text);

        // A `*` after a quoted string is FTS5's prefix operator. It applies to the last token
        // of a phrase, which is exactly right for "jane d" -> jane followed by d-something.
        return allowPrefix ? `${quoted} *` : quoted;
    };

    const prefixed = (term: Term): boolean => prefixLast && term === lastPositive && !term.phrase;
    const clauses = positive.map((term) => render(term, prefixed(term)));

    /**
     * The same words with one adjacent pair run together (§5c "Word boundaries").
     *
     * "aunt margaret" must find `auntmargaret.mp4`, whose filename is one token. The document
     * side covers the opposite direction — it carries `auntmargaret` for an item named with two
     * words — and between them the glued and spaced spellings meet whichever side has which.
     *
     * One pair at a time rather than every combination, and capped: each alternative is a
     * second walk of the index, and a name is rarely glued in more than one place.
     */
    const alternatives: string[][] = [];

    for (let i = 0; i + 1 < positive.length && alternatives.length < MAX_JOINED; i++) {
        const [left, right] = [positive[i], positive[i + 1]];

        if (left.phrase || right.phrase) {
            continue;
        }

        const joined: Term = { text: left.text + right.text, negated: false, phrase: false };

        alternatives.push([
            ...clauses.slice(0, i),
            // Prefixed when the pair ends the query, so "aunt marg" reaches `auntmargaret`.
            render(joined, prefixed(right)),
            ...clauses.slice(i + 2),
        ]);
    }

    let expression =
        alternatives.length === 0
            ? clauses.join(" AND ")
            : [clauses, ...alternatives].map((group) => `(${group.join(" AND ")})`).join(" OR ");

    if (negative.length > 0) {
        const excluded = negative.map((term) => render(term, false)).join(" OR ");

        expression =
            alternatives.length === 0
                ? `${expression} NOT (${excluded})`
                : `(${expression}) NOT (${excluded})`;
    }

    return expression;
};

/** How many glued spellings one query may try (see `buildMatchExpression`). */
const MAX_JOINED = 4;

/**
 * BM25 column weights for `MediaSearch`, positional and in schema column order.
 *
 * The ordering is the editorial judgement: a word in the title or filename identifies the
 * item, a performer name identifies it almost as strongly, and a word appearing in a scraped
 * description is weak evidence. Without weights every column counts the same, and an item
 * whose blurb mentions a common word outranks the one actually named for it.
 *
 * The second judgement, which is less obvious: **a weight compensates for how often a word
 * turns up somewhere by accident.** A performer's name is distinctive and will surface at
 * almost any weight. A tag like "funny" or "clown" is a common word that appears in
 * filenames and descriptions constantly, so the column recording that a person deliberately
 * filed the item under it has to outrank those, or the deliberate act is drowned by the
 * incidental ones.
 *
 * The `mediaId` column is UNINDEXED and contributes nothing, but bm25() still expects a
 * weight per column, so it takes a zero and must stay first.
 */
export const SEARCH_COLUMN_WEIGHTS = [
    0, // mediaId (UNINDEXED)
    8, // filename
    10, // title
    6, // performers
    /**
     * Every hand-applied tag that is not a performer (§5b).
     *
     * Above `performers`, which looks backwards and is not. Both are the same act — somebody
     * filed this item under this word — so neither is more trustworthy than the other, and
     * the difference is in what happens to the word elsewhere. "Jane Doe" appears where it
     * means Jane Doe. "Funny" appears in half the filenames in a library, so without the
     * boost a tag applied on purpose ranks below the same word occurring by chance.
     *
     * Below `filename` all the same: a filename usually carries the title words too, so it
     * is the denser evidence even though it is the less deliberate.
     */
    7, // tags
    1, // attributes
    2, // notes
    /**
     * Text read out of the picture (§5d).
     *
     * Level with a library note and above a scraped blurb, and both halves of that are
     * deliberate. Above `attributes` because a watermark is *about the item* — it is
     * frequently the only trustworthy metadata a file carries, since the filename is often
     * noise and there is no sidecar — while a blurb mentions many things in passing. Not
     * above a note, or anything curated, because this column is machine-read: recognition
     * elects a reading and can elect a wrong one, and a wrong term with a high weight does
     * not merely fail to help, it pushes good matches down.
     */
    2, // ocr
    /**
     * Other spellings of the curated text: adjacent words glued, known names found inside
     * glued words (§5c "Word boundaries").
     *
     * Below every column it was derived from, because a match here means the searcher typed the
     * name a different way than it was written, and the item written their way should come
     * first. Above `ocr` and `notes` all the same: it is derived from a title, a filename or a
     * tag, so it is still evidence about what the item *is*.
     */
    4, // variants
] as const;

/** LIKE's own wildcards, escaped; the backslash first, or it would escape the escapes. */
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (match) => `\\${match}`);

/**
 * How typed text is matched against a tag name or alias, as two LIKE patterns (§5b).
 *
 * - `words` is matched against `' ' || nameNorm`, so it is a prefix of *any word* in the name:
 *   "margaret" finds "Aunt Margaret", which a prefix of the whole name never did.
 * - `squashed` is matched against `nameNorm` with its spaces removed, so the glued and the
 *   punctuated spellings — "auntmargaret", "aunt.margaret", "aunt+margaret" — all find it.
 *   A substring once it is long enough to mean something; below that a prefix, because
 *   "mar" inside every name would bury the names that start with it.
 *
 * Both are built from `normalizeName`, the same function that wrote `nameNorm`.
 */
export interface TagNamePatterns {
    words: string;
    squashed: string;
}

/** Below this a glued spelling is matched as a prefix rather than anywhere in the name. */
const SQUASHED_SUBSTRING_MIN = 4;

export const tagNamePatterns = (text: string): TagNamePatterns | null => {
    const normalized = normalizeName(text);

    if (!normalized) {
        return null;
    }

    const squashed = escapeLike(normalized.replace(/ /g, ""));

    return {
        words: `% ${escapeLike(normalized)}%`,
        squashed: squashed.length >= SQUASHED_SUBSTRING_MIN ? `%${squashed}%` : `${squashed}%`,
    };
};

/**
 * Optimal string alignment distance, or `max + 1` as soon as it must exceed `max`.
 *
 * A transposition counts once — "margaert" is one slip, not two — and the early exit is what
 * keeps a pass over a whole vocabulary cheap: almost every name is rejected within a row or two.
 */
const editDistanceWithin = (a: string, b: string, max: number): number => {
    if (Math.abs(a.length - b.length) > max) {
        return max + 1;
    }

    let previous2: number[] = [];
    let previous = Array.from({ length: b.length + 1 }, (_, j) => j);

    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        let rowBest = i;

        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);

            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                value = Math.min(value, previous2[j - 2] + 1);
            }

            current.push(value);
            rowBest = Math.min(rowBest, value);
        }

        if (rowBest > max) {
            return max + 1;
        }

        previous2 = previous;
        previous = current;
    }

    return previous[b.length];
};

/**
 * How many slips a typed name may contain and still find a tag.
 *
 * None under four letters — at that length one edit reaches half the vocabulary — one up to
 * seven, two beyond.
 */
const typoAllowance = (length: number): number => (length < 4 ? 0 : length < 8 ? 1 : 2);

/**
 * Whether `typed` is a misspelling of `name`, of the whole of it or of one of its words:
 * "margret" finds "Aunt Margaret", "auntmargret" finds it too (§5b).
 *
 * The tag search's fallback when its patterns find nothing at all. It is not mixed into results
 * that did match: in a large vocabulary everything is one edit from something, and a close
 * spelling ranked beside an exact one is how fuzzy search buries what was actually typed.
 */
export const isTypoOf = (typed: string, name: string): boolean => {
    const squashedTyped = normalizeName(typed).replace(/ /g, "");
    const allowance = typoAllowance(squashedTyped.length);

    if (allowance === 0) {
        return false;
    }

    const normalized = normalizeName(name);

    return [normalized.replace(/ /g, ""), ...normalized.split(" ")].some(
        (candidate) => editDistanceWithin(squashedTyped, candidate, allowance) <= allowance
    );
};

/**
 * The viewer's own tag names, as LIKE patterns — one pair per word typed (§6).
 *
 * Private tags are searchable to their owner and to nobody else. They are deliberately absent
 * from the FTS document: one shared index cannot hold per-user text without leaking it into
 * other people's results, and that constraint is structural rather than a matter of care —
 * `MediaSearchDoc.mediaId` is UNIQUE, so there is exactly one document per item to put it in.
 *
 * A second, per-user FTS table was the obvious alternative and was rejected on measurement
 * rather than taste. bm25 is corpus-relative, so scores from a table of four hundred documents
 * are not comparable with scores from one of two hundred thousand, and ordering a union by
 * relevance has no honest answer. It also does not fit the stage machinery at all:
 * `MediaStage` is keyed `(mediaId, stage)` and `Job` has no user column.
 *
 * So private tags are matched on their names instead. That loses stemming — "performing" will
 * not find "performance" — and it is the right trade, because a tag is a short label rather
 * than prose, and prefix matching is what people expect of one.
 *
 * **Word by word, beside the document** (§5c "One search across what you can see"). Each word
 * typed must be found on the item — in the shared document or among the viewer's own tags, either
 * will do — so "beach funny" finds an item whose document says beach and which you tagged funny.
 * It used to be all of the words in the document or all of them in your tags, so a search mixing
 * the two found nothing. An excluded word (`-funny`) excludes an item whichever side it is on.
 *
 * Each term carries its own FTS expression, built as `buildMatchExpression` builds that word — the
 * last bare word as a prefix — and its `tagNamePatterns`, from one tokenisation so the two halves
 * cannot disagree about what the words were. LIKE's own wildcards are escaped in the patterns:
 * `normalizeName` already strips them, but the two functions are free to change independently, and
 * the failure if they ever diverge is a search for `%` quietly returning the whole library.
 */
export interface SearchTerm {
    fts: string;
    patterns: TagNamePatterns;
}

export const searchTerms = (raw: string): { included: SearchTerm[]; excluded: SearchTerm[] } => {
    const terms = tokenize(raw ?? "");
    const positive = terms.filter((term) => !term.negated);
    const last = positive[positive.length - 1];

    const toTerm = (term: Term, prefix: boolean): SearchTerm[] => {
        const patterns = tagNamePatterns(term.text);

        return patterns
            ? [{ fts: prefix ? `${quote(term.text)} *` : quote(term.text), patterns }]
            : [];
    };

    return {
        included: positive.flatMap((term) => toTerm(term, term === last && !term.phrase)),
        excluded: terms.filter((term) => term.negated).flatMap((term) => toTerm(term, false)),
    };
};
