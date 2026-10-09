/**
 * The model child process (§5e, §5f): reads pictures, runs a model, writes vectors files — CLIP's
 * vision model for `embed`, and the face models for `faces` (`faces.ts`), one family at a time.
 *
 * Started by `embedder.ts` with `fork`, one at a time, and killed by it when the queue goes
 * quiet — which is the point of its existing, because only the end of a process returns what a
 * model held (§5e "Memory"). It serves one request at a time and keeps the model loaded between
 * them, so a backlog pays the load once.
 *
 * It does no bookkeeping and touches no database: what it is given is paths and rectangles, and
 * what it returns is counts. The worker decides what an outcome means.
 */
import type { InferenceSession } from "onnxruntime-node";

import {
    EMBED_SIDE,
    encodeVectorFile,
    farthestPoints,
    normaliseVector,
    quantize,
    squaresIn,
    thinMoments,
    writeModelInput,
    type Moment,
    type StoredVector,
} from "@private-stock/core";
import { openModel } from "@private-stock/core/server";

import { facesRequest } from "./faces.js";
import { decodePicture, writeInPlace } from "./pictures.js";
import type { ChildMessage, EmbedRequest, EmbedResult, ParentMessage } from "./protocol.js";

/**
 * Squares per model run: one.
 *
 * Sixteen was chosen as no slower per frame than one, which it is — but every input shape the
 * runtime sees plans and keeps its own buffers, and an item's last batch is a different size
 * each time. Measured in the container against real sprite sheets, sixteen with the arena held
 * ~390 MB after forty items; one without it ~285 MB (the model alone ~210), about 4% slower (§5e
 * "Memory"). The difference is a fifth of the container's page cache.
 */
const BATCH = 1;

const PLANE = 3 * EMBED_SIDE * EMBED_SIDE;

let session: { model: string; threads: number; handle: InferenceSession } | null = null;

const sessionFor = async (model: string, threads: number): Promise<InferenceSession> => {
    if (session?.model === model && session.threads === threads) {
        return session.handle;
    }

    // A change of thread cap — the throttle window opening or closing — means a new session.
    // What the old one held stays with this process until it exits, which is soon.
    await session?.handle.release();
    // No arena: this process ends rather than releasing, so the arena's one advantage is moot
    // and its growth is not (`OpenModelOptions.arena`).
    session = { model, threads, handle: await openModel(model, { threads, arena: false }) };

    return session.handle;
};

const embedRequest = async (request: EmbedRequest): Promise<EmbedResult> => {
    const ort = await import("onnxruntime-node");
    const model = await sessionFor(request.model, request.threads);
    const moments: Moment[] = [];

    for (const source of request.sources) {
        const rgb = await decodePicture(source);
        // Every square of every moment in this picture, in order, then embedded in batches.
        const squares = source.moments.flatMap((moment, index) =>
            squaresIn(moment.rect).map((square) => ({ index, square }))
        );
        const vectors: Float32Array[] = [];

        for (let start = 0; start < squares.length; start += BATCH) {
            const batch = squares.slice(start, start + BATCH);
            const input = new Float32Array(batch.length * PLANE);

            batch.forEach(({ square }, i) =>
                writeModelInput(rgb, source.width, source.height, square, input, i * PLANE)
            );

            const outputs = await model.run({
                pixel_values: new ort.Tensor("float32", input, [
                    batch.length,
                    3,
                    EMBED_SIDE,
                    EMBED_SIDE,
                ]),
            });
            const data = outputs.image_embeds.data as Float32Array;
            const dims = outputs.image_embeds.dims[1];

            batch.forEach((_, i) =>
                vectors.push(normaliseVector(data.slice(i * dims, (i + 1) * dims)))
            );
        }

        source.moments.forEach((moment, index) => {
            moments.push({
                atMs: moment.atMs,
                vectors: squares.flatMap((entry, i) => (entry.index === index ? [vectors[i]] : [])),
            });
        });
    }

    const kept = thinMoments(moments.filter((moment) => moment.vectors.length > 0));
    const stored: StoredVector[] = kept.flatMap((index) =>
        moments[index].vectors.map((vector, square) => ({
            atMs: moments[index].atMs,
            square,
            vector: quantize(vector),
        }))
    );

    if (stored.length === 0) {
        return { moments: moments.length, kept: 0, vectors: 0 };
    }

    const flat = kept.flatMap((index) => moments[index].vectors);
    const bytes = encodeVectorFile({
        model: request.model,
        stageVersion: request.stageVersion,
        dims: flat[0].length,
        vectors: stored,
        representatives: farthestPoints(flat),
    });

    await writeInPlace(request.outPath, bytes);

    return { moments: moments.length, kept: kept.length, vectors: stored.length };
};

const reply = (message: ChildMessage): void => {
    process.send?.(message);
};

/**
 * One request at a time, in arrival order. The worker sends one per job and runs one embed job
 * at a time, so this is a guarantee rather than a bottleneck.
 */
let queue = Promise.resolve();

process.on("message", (message: ParentMessage) => {
    queue = queue.then(async () => {
        try {
            const { request } = message;
            const result =
                request.kind === "faces"
                    ? await facesRequest(request)
                    : await embedRequest(request);

            reply({ id: message.id, ok: true, result, rss: process.memoryUsage.rss() });
        } catch (error) {
            reply({
                id: message.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                rss: process.memoryUsage.rss(),
            });
        }
    });
});

// The worker going away takes this with it, rather than leaving a model resident with no one
// to send it work.
process.on("disconnect", () => process.exit(0));
