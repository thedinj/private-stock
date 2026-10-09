/**
 * Which performers and sources a piece of burned-in text names (§5d "Tagging performers and
 * sources from what was read").
 *
 * A name card reads `JANE DOE`, a watermark `JaneDoe · examplesite.com`, a bad frame `JANE D0E`.
 * All three name Jane Doe, and the watermark names a source as well, so the answer is every tag
 * found rather than the best one.
 *
 * Pure: the caller hands in the vocabulary (names *and* aliases, each pointing at its tag) and
 * stores what comes back. The worker runs it after reading an item and across the library when
 * the vocabulary changes; the web runs it after a string is corrected.
 */

import { normalizeName } from "./domain.js";
import { foldForComparison, similarity } from "./ocr.js";
import { namesGluedInto, splitCompound, squashName, WORD } from "./searchVariants.js";

/** One name a tag answers to: its own, or one of its aliases. */
export interface TagNameEntry {
    tagId: string;
    name: string;
}

/**
 * How a string names a tag, strongest first.
 *
 * - `exact`: the whole string is the name.
 * - `contains`: the name is in it, as a phrase or glued into a word.
 * - `near`: only after folding the glyphs recognition confuses, or one edit away from it — a
 *   misreading, which is corrected before anything is tagged.
 */
export const tagMatchKinds = ["exact", "contains", "near"] as const;
export type TagMatchKind = (typeof tagMatchKinds)[number];

export interface TagNameMatch {
    tagId: string;
    kind: TagMatchKind;
    /** The part of the string that named it, as it was read. */
    matchedText: string;
    start: number;
    end: number;
    /** 1 for an exact reading, lower the further a misreading is from the name. */
    score: number;
}

/**
 * Below this many letters (folded, spaces removed) a name is never matched one edit away.
 *
 * At five letters one edit is a fifth of the name, and `Nina` is one edit from `Nine`, `Gina` and
 * `Ninja`. Folded *equality* is still allowed down to the four the reconciler stores at all,
 * because that claims only what the reconciler already believes: `N1NA` is `NINA` misread.
 */
export const OCR_TAG_NEAR_MIN_LENGTH = 6;

/** Past this many words a name is a sentence, and nothing in the vocabulary is one. */
const MAX_NAME_WORDS = 6;

const KIND_RANK: Record<TagMatchKind, number> = { exact: 3, contains: 2, near: 1 };

/** A reading that names the tag only once its confusable glyphs are folded. */
const FOLDED_SCORE = 0.9;

export interface TagMatcher {
    /** Normalised name, words separated by single spaces → who answers to it. */
    phrases: Map<string, string[]>;
    /** The name with its spaces removed: how it reads glued into a word. */
    squashed: Map<string, string[]>;
    /** Folded and squashed: how it reads once recognition's confusions are discounted. */
    folded: Map<string, string[]>;
    /** Each long folded name, and each with one letter deleted → the folded names it came from. */
    deletions: Map<string, Set<string>>;
    maxWords: number;
}

const fold = (text: string): string => foldForComparison(text).replace(/ /g, "");

const add = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
    const list = map.get(key);

    if (list === undefined) {
        map.set(key, [value]);
    } else if (!list.includes(value)) {
        list.push(value);
    }
};

const oneDeleted = (text: string): string[] => {
    const out: string[] = [];

    for (let i = 0; i < text.length; i++) {
        out.push(text.slice(0, i) + text.slice(i + 1));
    }

    return out;
};

/**
 * The lookup tables for a vocabulary, built once per run rather than per string.
 *
 * One-edit matching uses the deletion neighbourhood: two strings are within one edit when one of
 * them, or one of them with a letter deleted, equals the other with at most one letter deleted.
 * That turns "compare against every name" into a handful of hash probes, which is what keeps a
 * full rematch of the library to seconds.
 */
export const buildTagMatcher = (entries: TagNameEntry[]): TagMatcher => {
    const matcher: TagMatcher = {
        phrases: new Map(),
        squashed: new Map(),
        folded: new Map(),
        deletions: new Map(),
        maxWords: 1,
    };

    for (const { tagId, name } of entries) {
        const phrase = normalizeName(name);

        if (phrase === "") {
            continue;
        }

        const wordCount = phrase.split(" ").length;

        if (wordCount > MAX_NAME_WORDS) {
            continue;
        }

        matcher.maxWords = Math.max(matcher.maxWords, wordCount);
        add(matcher.phrases, phrase, tagId);
        add(matcher.squashed, squashName(name), tagId);

        const folded = fold(phrase);

        if (folded.length < 4) {
            continue;
        }

        add(matcher.folded, folded, tagId);

        if (folded.length >= OCR_TAG_NEAR_MIN_LENGTH) {
            for (const key of [folded, ...oneDeleted(folded)]) {
                const from = matcher.deletions.get(key) ?? new Set<string>();

                from.add(folded);
                matcher.deletions.set(key, from);
            }
        }
    }

    return matcher;
};

interface Token {
    text: string;
    start: number;
    end: number;
}

interface Word extends Token {
    parts: Token[];
}

/** Words as the index sees them, each with the parts its case and digit changes mark. */
const wordsOf = (text: string): Word[] =>
    [...text.matchAll(WORD)].map((match) => {
        const start = match.index ?? 0;
        const word = match[0];
        let at = start;
        const parts = splitCompound(word)
            .filter((part) => part !== "")
            .map((part) => {
                const token = { text: part.toLowerCase(), start: at, end: at + part.length };

                at += part.length;

                return token;
            });

        return { text: word.toLowerCase(), start, end: start + word.length, parts };
    });

const editsApart = (a: string, b: string): number =>
    Math.round((1 - similarity(a, b)) * Math.max(a.length, b.length));

type Push = (
    tagIds: string[] | undefined,
    kind: TagMatchKind,
    start: number,
    end: number,
    score: number
) => void;

/** Every run of up to `maxWords` tokens, looked up as a name and, with `near`, a misreading. */
const matchWindows = (tokens: Token[], matcher: TagMatcher, push: Push, near: boolean): void => {
    for (let first = 0; first < tokens.length; first++) {
        for (let count = 1; count <= matcher.maxWords && first + count <= tokens.length; count++) {
            const window = tokens.slice(first, first + count);
            const start = window[0].start;
            const end = window[window.length - 1].end;
            const phrase = window.map((token) => token.text).join(" ");
            const whole = first === 0 && count === tokens.length;

            push(matcher.phrases.get(phrase), whole ? "exact" : "contains", start, end, 1);

            if (!near) {
                continue;
            }

            const folded = fold(phrase);

            if (folded.length < 4) {
                continue;
            }

            // A phrase match for the same tag outranks this one, so it never shows when the
            // reading was right.
            push(matcher.folded.get(folded), "near", start, end, FOLDED_SCORE);

            if (folded.length < OCR_TAG_NEAR_MIN_LENGTH - 1) {
                continue;
            }

            const candidates = new Set<string>();

            for (const key of [folded, ...oneDeleted(folded)]) {
                for (const name of matcher.deletions.get(key) ?? []) {
                    candidates.add(name);
                }
            }

            for (const name of candidates) {
                if (name !== folded && editsApart(folded, name) <= 1) {
                    push(
                        matcher.folded.get(name),
                        "near",
                        start,
                        end,
                        FOLDED_SCORE * similarity(folded, name)
                    );
                }
            }
        }
    }
};

/** Characters that join a word rather than split it, as `normalizeName` treats them. */
const JOINER = /['’ʼ`]/;

/**
 * Text folded the way `normalizeName` folds a name — accents off, apostrophes out — with, for
 * every UTF-16 unit kept, the span of the original it came from.
 *
 * Case is kept: the camel-case split (`JaneDoe`) needs it, and the words are lowercased after.
 * The spans are what let a match be reported against the text as it was read, which is what the
 * OCR review highlights and corrects (§5d).
 */
const foldText = (text: string): { text: string; from: number[]; to: number[] } => {
    let folded = "";
    const from: number[] = [];
    const to: number[] = [];

    for (let i = 0; i < text.length;) {
        const character = String.fromCodePoint(text.codePointAt(i) ?? 0);
        const next = i + character.length;

        if (!JOINER.test(character)) {
            const plain = character.normalize("NFKD").replace(/\p{M}/gu, "");

            for (let unit = 0; unit < plain.length; unit++) {
                from.push(i);
                to.push(next);
            }

            folded += plain;
        }

        i = next;
    }

    return { text: folded, from, to };
};

export interface MatchTagNamesOptions {
    /**
     * Whether a misreading counts (`near`). On for text read out of a picture, where glyphs are
     * confused; off for a filename or a title, which say exactly what somebody typed.
     */
    near?: boolean;
}

/** Every tag `text` names, at most once each, in the order they appear. */
export const matchTagNames = (
    text: string,
    matcher: TagMatcher,
    options: MatchTagNamesOptions = {}
): TagNameMatch[] => {
    const near = options.near ?? true;
    const folded = foldText(text);
    const words = wordsOf(folded.text);
    const found: TagNameMatch[] = [];

    // Positions arrive in the folded text; report them in the text as it was.
    const push: Push = (tagIds, kind, foldedStart, foldedEnd, score) => {
        if (foldedEnd <= foldedStart) {
            return;
        }

        const start = folded.from[foldedStart];
        const end = folded.to[foldedEnd - 1];

        for (const tagId of tagIds ?? []) {
            found.push({ tagId, kind, matchedText: text.slice(start, end), start, end, score });
        }
    };

    // Runs of whole words: the name as a phrase, or misread as one. Over the words as read and
    // over their camel-case parts, because each misses what the other sees: `JaneDoe` is two
    // words only once split, and `D0E` or `VALENTlNA` is one misread word that splitting at its
    // digit or its stray lowercase letter would break apart.
    for (const tokens of [words, words.flatMap((word) => word.parts)]) {
        matchWindows(tokens, matcher, push, near);
    }

    // Names glued into one word: `janedoe`, `examplesite` in `examplesite.com`.
    for (const word of words) {
        const named = new Set<string>();

        for (const hit of namesGluedInto(word.text, matcher.squashed)) {
            push(hit.value, "contains", word.start + hit.start, word.start + hit.end, 1);
            hit.value.forEach((tagId) => named.add(tagId));
        }

        if (!near) {
            continue;
        }

        // And misread inside one: `janed0e`. Folding can change a word's length (`rn` → `m`), and
        // then a position inside it no longer points at the same letters, so the whole word is
        // what was read.
        const folded = fold(word.text);

        const aligned = folded.length === word.text.length;

        for (const hit of namesGluedInto(folded, matcher.folded)) {
            push(
                hit.value.filter((tagId) => !named.has(tagId)),
                "near",
                aligned ? word.start + hit.start : word.start,
                aligned ? word.start + hit.end : word.end,
                FOLDED_SCORE
            );
        }
    }

    // A name inside a longer name is not a second finding: "Jane" in "Jane Doe".
    const standing = found.filter(
        (match) =>
            !found.some(
                (other) =>
                    other.start <= match.start &&
                    other.end >= match.end &&
                    other.end - other.start > match.end - match.start
            )
    );

    const best = new Map<string, TagNameMatch>();

    for (const match of standing) {
        const held = best.get(match.tagId);

        if (
            held === undefined ||
            KIND_RANK[match.kind] > KIND_RANK[held.kind] ||
            (KIND_RANK[match.kind] === KIND_RANK[held.kind] &&
                (match.end - match.start > held.end - held.start ||
                    (match.end - match.start === held.end - held.start &&
                        match.score > held.score)))
        ) {
            best.set(match.tagId, match);
        }
    }

    return [...best.values()].sort((a, b) => a.start - b.start);
};

/**
 * The string with the misread span replaced by the name it was taken for: what accepting a near
 * match corrects the string to.
 */
export const correctedText = (
    text: string,
    match: Pick<TagNameMatch, "matchedText">,
    name: string
): string => {
    const at = text.indexOf(match.matchedText);

    return at < 0 ? text : text.slice(0, at) + name + text.slice(at + match.matchedText.length);
};

/** Where on an item a tag's name was found (§5b "One rule for names"). */
export const mentionFields = ["filename", "title", "screen"] as const;
export type MentionField = (typeof mentionFields)[number];

/** One tag an item's text names, and where. */
export interface Mention {
    tagId: string;
    field: MentionField;
}

/**
 * The tags an item's own text names, field by field — what `MediaMention` stores.
 *
 * The same matcher the OCR review uses, so "does this text name this tag" has one answer: accents,
 * separators and glued spellings alike, and a name inside a longer known name ("Anna" in "Anna
 * Smith") not counted twice. Without misreadings, even on screen: a mention is evidence somebody
 * acts on in bulk, and the OCR review is where a misreading is judged.
 */
export const mentionsIn = (texts: Record<MentionField, string>, matcher: TagMatcher): Mention[] =>
    mentionFields.flatMap((field) =>
        [...new Set(matchTagNames(texts[field], matcher, { near: false }).map((m) => m.tagId))].map(
            (tagId) => ({ tagId, field })
        )
    );
