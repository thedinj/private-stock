/**
 * The text encoder child process (§5e "Search runs in two passes"): words in, one look vector
 * out.
 *
 * Started by `textEncoder.ts` on the first look asked for in words, and killed by it when
 * searches stop — the same reason the worker's embedder is a child: a released model does not
 * give its memory back under glibc, and only the end of the process holding it does (§5e
 * "Memory"). It serves one request at a time and keeps the model loaded between them.
 *
 * Compiled JavaScript always, never TypeScript under a loader: the web app that starts it is
 * bundled by Next, and has no loader to lend it.
 */
import type { InferenceSession } from "onnxruntime-node";

import { lookPhrasings, meanDirection, normaliseVector } from "../embedding.js";
import type { ClipTokenizer } from "../clipTokenizer.js";
import { loadClipTokenizer, openModel } from "./models.js";
import type { TextChildMessage, TextParentMessage } from "./textEncoder.js";

/** The 8-bit text model: matched the full one on 23 of 31 of the library's searches (§5e). */
const TEXT_MODEL = "clip-b32-text-uint8";

let loaded: { session: InferenceSession; tokenizer: ClipTokenizer } | null = null;

const load = async (): Promise<NonNullable<typeof loaded>> => {
    // One thread: a search is a person waiting, but the NAS has two cores and the worker may be
    // using both (§7c). One short sentence takes tens of milliseconds on one.
    // No arena: this process ends rather than releasing (`OpenModelOptions.arena`).
    loaded ??= {
        session: await openModel(TEXT_MODEL, { threads: 1, arena: false }),
        tokenizer: loadClipTokenizer(),
    };

    return loaded;
};

const encode = async (text: string): Promise<Float32Array> => {
    const { session, tokenizer } = await load();
    const ort = await import("onnxruntime-node");
    const vectors: Float32Array[] = [];

    for (const phrasing of lookPhrasings(text)) {
        const ids = tokenizer.encode(phrasing);
        const output = await session.run({
            input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
        });

        vectors.push(normaliseVector(output.text_embeds.data as Float32Array));
    }

    return meanDirection(vectors);
};

const reply = (message: TextChildMessage): void => {
    process.send?.(message);
};

// One request at a time, in arrival order: the model is not shared between two runs.
let queue = Promise.resolve();

process.on("message", (message: TextParentMessage) => {
    queue = queue.then(async () => {
        try {
            reply({ id: message.id, ok: true, vector: Array.from(await encode(message.text)) });
        } catch (error) {
            reply({
                id: message.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
});

// Orphaned — the web process died without killing it — means nobody will ever ask again.
process.on("disconnect", () => process.exit(0));
