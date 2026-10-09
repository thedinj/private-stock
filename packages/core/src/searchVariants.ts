/**
 * The other spellings of a document's words, for the index (§5c "Word boundaries").
 *
 * A messily named library writes one name many ways: `Aunt Margaret`, `AuntMargaret`,
 * `aunt.margaret`, `auntmargaret`. Punctuation is already a word boundary to the tokenizer, so
 * the dotted and spaced forms meet without help. What does not meet is the *glued* form — one
 * token on one side, two on the other — and that is a difference in where the word boundaries
 * fall, which no amount of case folding or stemming touches.
 *
 * So the index is given both: the words split where the text itself marks a boundary (case and
 * digit changes), and every adjacent pair run together. Whichever way somebody types the name,
 * one of the two spellings is in the document.
 */

import { normalizeName } from "./domain.js";

/** A run of letters and digits — what `unicode61` would make a token of. */
export const WORD = /[\p{L}\p{M}\p{N}]+/gu;

const words = (text: string): string[] => text.match(WORD) ?? [];

const ALL_DIGITS = /^\p{N}+$/u;

/**
 * One word split where its case or script changes: `AuntMargaret` → `Aunt`, `Margaret`;
 * `Holiday2019` → `Holiday`, `2019`; `HTMLParser` → `HTML`, `Parser`.
 *
 * Only boundaries the text itself marks. An all-lowercase `auntmargaret` carries no sign of
 * where its words meet; that one is left to `vocabularyInside`, which knows what names exist.
 */
export const splitCompound = (word: string): string[] =>
    word
        .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
        .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
        .replace(/(\p{L})(\p{N})/gu, "$1 $2")
        .replace(/(\p{N})(\p{L})/gu, "$1 $2")
        .split(" ");

/**
 * Text with each compound word followed by its parts: `AuntMargaret Beach` →
 * `AuntMargaret Aunt Margaret Beach`.
 *
 * The original stays, and stays in its own column at its own weight — searching the glued form
 * of a title must still rank as a title match. It goes *first* so the parts sit beside the word
 * that followed it, and a phrase search for "margaret beach" still finds them adjacent.
 *
 * Punctuation is dropped. This text is only ever tokenized, and the tokenizer splits on it
 * anyway.
 */
export const expandCompounds = (text: string): string =>
    words(text)
        .flatMap((word) => {
            const parts = splitCompound(word);

            return parts.length > 1 ? [word, ...parts] : [word];
        })
        .join(" ");

/**
 * Every adjacent pair of words, run together: `Aunt Margaret` → `auntmargaret`.
 *
 * Per phrase, never across them — a title, one tag's name, one folder. Pairing the last word of
 * one tag with the first of the next invents words nobody wrote.
 *
 * Two numbers are not joined. `2019 1080` → `20191080` is a token nobody types and every scene
 * name would produce one.
 */
const joinedPairs = (phrases: string[]): string[] =>
    phrases.flatMap((phrase) => {
        const parts = words(phrase)
            .flatMap(splitCompound)
            .map((part) => part.toLowerCase());
        const pairs: string[] = [];

        for (let i = 0; i + 1 < parts.length; i++) {
            if (!(ALL_DIGITS.test(parts[i]) && ALL_DIGITS.test(parts[i + 1]))) {
                pairs.push(parts[i] + parts[i + 1]);
            }
        }

        return pairs;
    });

/** A name with its spaces removed, the form it takes when somebody glues it: `auntmargaret`. */
export const squashName = (name: string): string => normalizeName(name).replace(/ /g, "");

/**
 * Below this a vocabulary name is too common a string to trust inside another word.
 *
 * Short names are only taken when they sit at the start or end of the glued word, and longer
 * ones anywhere: `anna` is inside `hannah` and `savannah`, while `margaret` inside
 * `auntmargaretbeach` is almost never a coincidence.
 */
const ANYWHERE_MIN = 6;
const EDGE_MIN = 4;

/** Past this a "word" is a hash or a run-on, and checking every substring is wasted work. */
const MAX_SCANNED = 64;

/** A known name found inside one word, by its position in that word. */
export interface GluedName<T> {
    start: number;
    end: number;
    value: T;
}

/**
 * The known names glued into one word: `auntmargaretbeach` → `aunt margaret`, `beach`.
 *
 * `vocabulary` maps a squashed name to whatever the caller wants back for it. It is the curated
 * tag vocabulary, which is the dictionary that matters — the names somebody has already decided
 * are worth filing things under — and the only one that knows a library's people. The index and
 * the OCR tag matcher (§5d) both read names out of glued words, and share this so that the two
 * cannot disagree about where a short name counts.
 *
 * Every substring is looked up rather than an automaton built, because a word is short and the
 * lookup is a hash probe: under two thousand probes for the longest word scanned.
 */
export const namesGluedInto = <T>(
    word: string,
    vocabulary: ReadonlyMap<string, T>
): GluedName<T>[] => {
    const lower = word.toLowerCase();
    const found: GluedName<T>[] = [];

    if (lower.length < EDGE_MIN || lower.length > MAX_SCANNED) {
        return found;
    }

    for (let start = 0; start < lower.length; start++) {
        for (let end = start + EDGE_MIN; end <= lower.length; end++) {
            const value = vocabulary.get(lower.slice(start, end));

            if (value === undefined) {
                continue;
            }

            const atEdge = start === 0 || end === lower.length;

            if (end - start < ANYWHERE_MIN && !atEdge) {
                continue;
            }

            found.push({ start, end, value });
        }
    }

    return found;
};

/** The library's known names found inside the glued words of `phrases`. */
const vocabularyInside = (phrases: string[], vocabulary: ReadonlyMap<string, string>): string[] =>
    phrases.flatMap(words).flatMap((word) =>
        namesGluedInto(word, vocabulary)
            // The whole word *is* a one-word name: it is already in the document as itself.
            .filter(
                ({ start, end, value }) => !(end - start === word.length && !value.includes(" "))
            )
            .map(({ value }) => value)
    );

export interface VariantSources {
    /** Text that is a name of something: a title, one folder or filename, one tag. */
    phrases: string[];
    /** The subset worth searching for known names: what nobody curated, so names are glued. */
    messy: string[];
}

/**
 * The `variants` column of a search document (§5c).
 *
 * Deduplicated and lowercased, because nothing reads it but the tokenizer and a repeated term
 * would only inflate the column's length for BM25.
 */
export const searchVariants = (
    sources: VariantSources,
    vocabulary: ReadonlyMap<string, string>
): string =>
    [
        ...new Set([
            ...joinedPairs(sources.phrases),
            ...vocabularyInside(sources.messy, vocabulary),
        ]),
    ].join(" ");
