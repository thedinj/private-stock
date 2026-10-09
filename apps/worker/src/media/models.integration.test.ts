import { describe, expect, it } from "vitest";

import type { InferenceSession, Tensor } from "onnxruntime-node";

import { openModel, readModelManifest } from "@private-stock/core/server";

/**
 * The built-in models load and behave like embedders (§5e).
 *
 * Integration rather than unit: it needs the model files, which `pnpm models:fetch` downloads
 * and CI caches, and loading them takes seconds. What it pins down is what the stages will rely
 * on — the same input always gives the same vector, different inputs give different ones, and
 * every model in the manifest answers with 512 finite numbers.
 */

const ort = await import("onnxruntime-node");

const SIDE = 224;

/** "a dog on a beach" and "a city at night", between CLIP's start and end tokens. */
const DOG = [49406, 320, 1929, 525, 320, 2117, 49407];
const CITY = [49406, 320, 1305, 536, 930, 49407, 49407];

const tokens = (ids: number[]): Record<string, Tensor> => ({
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
});

const flatImage = (value: number): Record<string, Tensor> => ({
    pixel_values: new ort.Tensor("float32", new Float32Array(3 * SIDE * SIDE).fill(value), [
        1,
        3,
        SIDE,
        SIDE,
    ]),
});

const embed = async (
    session: InferenceSession,
    feeds: Record<string, Tensor>
): Promise<number[]> => {
    const outputs = await session.run(feeds);

    return Array.from((outputs.image_embeds ?? outputs.text_embeds).data as Float32Array);
};

const cosine = (a: number[], b: number[]): number => {
    let dot = 0;
    let na = 0;
    let nb = 0;

    a.forEach((value, i) => {
        dot += value * b[i];
        na += value * value;
        nb += b[i] * b[i];
    });

    return dot / Math.sqrt(na * nb);
};

describe("built-in models", () => {
    // CLIP's towers here; the face models (§5f) are exercised by the faces stage's own test.
    for (const model of readModelManifest().filter(
        (entry) => entry.id.startsWith("clip-") && entry.file.endsWith(".onnx")
    )) {
        const text = model.id.includes("-text-");

        it(`${model.id} is deterministic and discriminates`, async () => {
            const session = await openModel(model.id, { threads: 1 });

            try {
                const first = await embed(session, text ? tokens(DOG) : flatImage(-0.5));
                const again = await embed(session, text ? tokens(DOG) : flatImage(-0.5));
                const other = await embed(session, text ? tokens(CITY) : flatImage(0.8));

                expect(first).toHaveLength(512);
                expect(first.every(Number.isFinite)).toBe(true);
                expect(again).toEqual(first);
                expect(cosine(first, other)).toBeLessThan(0.99);
            } finally {
                await session.release();
            }
        });
    }
});
