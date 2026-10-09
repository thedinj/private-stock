import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadClipTokenizer } from "@private-stock/core/server";

/**
 * Our CLIP tokenizer against ids recorded from the reference implementation (§5e).
 *
 * Integration because it needs the pinned vocabulary and merges (`pnpm models:fetch`). The
 * fixture is generic phrases and the awkward cases — accents, contractions, emoji, special tokens,
 * digits, the 77-token cut — recorded with `@huggingface/transformers`' CLIP tokenizer for the same
 * pinned files. A mismatch means the text model is being fed what it was not trained on.
 */
const fixture = JSON.parse(
    readFileSync(new URL("./clipTokenizer.fixture.json", import.meta.url), "utf8")
) as [string, number[]][];

describe("CLIP tokenizer", () => {
    const tokenizer = loadClipTokenizer();

    for (const [text, ids] of fixture) {
        it(`matches the reference for ${JSON.stringify(text).slice(0, 40)}`, () => {
            expect(tokenizer.encode(text)).toEqual(ids);
        });
    }
});
