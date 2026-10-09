/**
 * CLIP's tokenizer: text in, the token ids its text model takes (§5e).
 *
 * Written out rather than taken from a library, because the library that has it
 * (`@huggingface/transformers`) brings its own onnxruntime, and two runtimes in one process is a
 * fight over a native binding — which one loads first wins and the other fails (§5e "Measured
 * how"). The algorithm is small and fixed: the model was trained against exactly this, and a test
 * holds it to ids recorded from the reference implementation.
 *
 * Pure: the vocabulary and merge rules are handed in (`models/` carries both, pinned like the
 * models), so this runs anywhere.
 *
 * - Text is NFC-normalised, its whitespace collapsed, and lowercased.
 * - It is split by CLIP's pattern: the special tokens, English contractions, runs of letters,
 *   single digits, runs of anything else that is not space.
 * - Each piece's UTF-8 bytes are mapped to printable characters, the last one marked as a word
 *   end (`</w>`), and pairs are merged by rank until no ranked pair is left.
 * - Wrapped in the start and end tokens and cut to the model's 77, end token kept.
 */

/** The text model's context: start token, up to 75 pieces, end token. */
export const CLIP_CONTEXT = 77;

const START = "<|startoftext|>";
const END = "<|endoftext|>";

const PATTERN =
    /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/giu;

/** GPT-2's byte-to-character table: every byte as a printable character, so BPE never sees one. */
const byteToChar = (() => {
    const bytes: number[] = [];

    for (let b = 33; b <= 126; b++) bytes.push(b);
    for (let b = 161; b <= 172; b++) bytes.push(b);
    for (let b = 174; b <= 255; b++) bytes.push(b);

    const chars = [...bytes];
    let extra = 0;

    for (let b = 0; b < 256; b++) {
        if (!bytes.includes(b)) {
            bytes.push(b);
            chars.push(256 + extra);
            extra += 1;
        }
    }

    const table: string[] = [];

    bytes.forEach((b, i) => {
        table[b] = String.fromCharCode(chars[i]);
    });

    return table;
})();

export interface ClipTokenizer {
    encode: (text: string) => number[];
}

/**
 * A tokenizer for this vocabulary (`vocab.json`, token → id) and these merges (`merges.txt`, one
 * "left right" pair per line, most frequent first, after a `#version` header).
 */
export const createClipTokenizer = (
    vocabulary: Record<string, number>,
    merges: string
): ClipTokenizer => {
    const ranks = new Map<string, number>();

    merges
        .split(/\r?\n/)
        .filter((line) => line !== "" && !line.startsWith("#version"))
        .forEach((line, rank) => ranks.set(line, rank));

    const startId = vocabulary[START];
    const endId = vocabulary[END];
    const cache = new Map<string, string[]>();
    const encoder = new TextEncoder();

    const bpe = (piece: string): string[] => {
        const cached = cache.get(piece);

        if (cached) return cached;

        let word = [...piece];

        word[word.length - 1] += "</w>";

        for (;;) {
            let best = -1;
            let bestRank = Infinity;

            for (let i = 0; i + 1 < word.length; i++) {
                const rank = ranks.get(`${word[i]} ${word[i + 1]}`);

                if (rank !== undefined && rank < bestRank) {
                    bestRank = rank;
                    best = i;
                }
            }

            if (best < 0) break;

            const [left, right] = [word[best], word[best + 1]];
            const merged: string[] = [];

            for (let i = 0; i < word.length; i++) {
                if (i + 1 < word.length && word[i] === left && word[i + 1] === right) {
                    merged.push(left + right);
                    i += 1;
                } else {
                    merged.push(word[i]);
                }
            }

            word = merged;
        }

        cache.set(piece, word);

        return word;
    };

    return {
        encode: (text) => {
            const clean = text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
            const ids: number[] = [];

            for (const [match] of clean.matchAll(PATTERN)) {
                if (match === START || match === END) {
                    ids.push(vocabulary[match]);
                    continue;
                }

                const piece = [...encoder.encode(match)].map((b) => byteToChar[b]).join("");

                for (const token of bpe(piece)) {
                    const id = vocabulary[token];

                    if (id !== undefined) ids.push(id);
                }
            }

            return [startId, ...ids.slice(0, CLIP_CONTEXT - 2), endId];
        },
    };
};
