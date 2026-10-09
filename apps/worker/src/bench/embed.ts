/**
 * What the §5e models cost on this machine, measured rather than estimated.
 *
 *     pnpm bench:embed                                   # development
 *     node apps/worker/dist/bench/embed.js               # in the container, from /app
 *     node apps/worker/dist/bench/embed.js --smoke       # load each model once and check it answers
 *     ... --frames 462000                                # the library size to project a first pass for
 *
 * §5e's NAS figures were scaled from a desktop at ×2 and are good to ±30%. This replaces them:
 * milliseconds per frame at one and two threads, and what loading a model does to resident
 * memory and — inside a container — to the cgroup's total, which is the number that matters
 * there because the cap includes the page cache (§20).
 *
 * The inputs are synthetic. Inference time does not depend on what is in the picture, and a
 * benchmark that needs a library to run is one nobody runs.
 */
import { readFileSync } from "node:fs";
import { cpus } from "node:os";

import type { InferenceSession, Tensor } from "onnxruntime-node";

import { findModelsDir, openModel, readModelManifest } from "@private-stock/core/server";

const args = process.argv.slice(2);
const smoke = args.includes("--smoke");
const framesArg = args.indexOf("--frames");
const libraryFrames = framesArg >= 0 ? Number(args[framesArg + 1]) : 462_000;

const SIDE = 224;
const EMBEDDING_DIMS = 512;

/** CLIP's start and end tokens, around "a dog on a beach" — enough to exercise the text tower. */
const TOKENS = [49406, 320, 1929, 525, 320, 2117, 49407];

const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(0)} MB`;
const rss = (): number => process.memoryUsage().rss;

/** The container's charged memory, page cache included; null outside a container. */
const cgroupBytes = (): number | null => {
    // v2 first, then v1 — QNAP's Container Station is v1, which the first NAS run found by
    // printing nothing here.
    for (const file of [
        "/sys/fs/cgroup/memory.current",
        "/sys/fs/cgroup/memory/memory.usage_in_bytes",
    ]) {
        try {
            return Number(readFileSync(file, "utf8"));
        } catch {
            // Not this version; try the next.
        }
    }

    return null;
};

const memoryLine = (): string => {
    const cgroup = cgroupBytes();

    return `rss ${mb(rss())}${cgroup === null ? "" : `, cgroup ${mb(cgroup)}`}`;
};

const ort = await import("onnxruntime-node");

const isText = (id: string): boolean => id.includes("-text-");

const feedsFor = (id: string, batch: number): Record<string, Tensor> =>
    isText(id)
        ? {
              input_ids: new ort.Tensor(
                  "int64",
                  BigInt64Array.from(Array.from({ length: batch }, () => TOKENS).flat(), BigInt),
                  [batch, TOKENS.length]
              ),
          }
        : {
              pixel_values: new ort.Tensor(
                  "float32",
                  Float32Array.from(
                      { length: batch * 3 * SIDE * SIDE },
                      () => Math.random() * 2 - 1
                  ),
                  [batch, 3, SIDE, SIDE]
              ),
          };

/** The embedding out of a CLIP export, whichever tower it is. */
const embeddingOf = async (
    session: InferenceSession,
    feeds: Record<string, Tensor>
): Promise<Tensor> => {
    const outputs = await session.run(feeds);
    const tensor = outputs.image_embeds ?? outputs.text_embeds;

    if (!tensor) {
        throw new Error(`no embedding among outputs: ${Object.keys(outputs).join(", ")}`);
    }

    return tensor;
};

const timeRuns = async (
    session: InferenceSession,
    id: string,
    batch: number,
    runs: number
): Promise<number> => {
    const feeds = feedsFor(id, batch);

    await embeddingOf(session, feeds);

    const start = process.hrtime.bigint();

    for (let i = 0; i < runs; i += 1) {
        await embeddingOf(session, feeds);
    }

    return Number(process.hrtime.bigint() - start) / 1e6 / runs / batch;
};

// The tokenizer's tables are in the manifest too; only the .onnx entries are models. The face
// models (§5f) are timed by their own stage's figures; here they are only smoke-tested.
const allModels = readModelManifest().filter((model) => model.file.endsWith(".onnx"));
const manifest = allModels.filter((model) => model.id.startsWith("clip-"));

/**
 * Whether a face model answers as the faces stage expects (§5f): the detector with its nine
 * tensors — scores, boxes and landmarks at three strides — and the recogniser with 512 numbers.
 */
const faceModelAnswers = async (session: InferenceSession, id: string): Promise<string> => {
    const detector = id.startsWith("face-det-");
    const [height, width] = detector ? [384, 640] : [112, 112];
    const input = new ort.Tensor(
        "float32",
        Float32Array.from({ length: 3 * height * width }, () => Math.random() * 2 - 1),
        [1, 3, height, width]
    );
    const outputs = await session.run({ [session.inputNames[0]]: input });
    const tensors = Object.values(outputs);

    if (detector) {
        if (tensors.length !== 9) throw new Error(`${tensors.length} outputs, expected 9`);

        return `${tensors.length} outputs`;
    }

    const values = Array.from(tensors[0].data as Float32Array);

    if (values.length !== EMBEDDING_DIMS || !values.every(Number.isFinite)) {
        throw new Error(`answered with ${values.length} values`);
    }

    return tensors[0].dims.join("×");
};

console.log(`models  ${findModelsDir()}`);
console.log(`cpu     ${cpus()[0]?.model ?? "unknown"} × ${cpus().length}`);
console.log(`start   ${memoryLine()}\n`);

if (smoke) {
    let failed = false;

    for (const model of allModels.filter((entry) => entry.id.startsWith("face-"))) {
        try {
            const session = await openModel(model.id, { threads: 1 });
            const answer = await faceModelAnswers(session, model.id);

            await session.release();
            console.log(`  ok    ${model.id} answers with ${answer}`);
        } catch (error) {
            console.log(`  FAIL  ${model.id}: ${(error as Error).message}`);
            failed = true;
        }
    }

    for (const model of manifest) {
        try {
            const session = await openModel(model.id, { threads: 1 });
            const tensor = await embeddingOf(session, feedsFor(model.id, 1));
            const values = Array.from(tensor.data as Float32Array);
            const ok =
                tensor.dims.at(-1) === EMBEDDING_DIMS &&
                values.every(Number.isFinite) &&
                values.some((value) => value !== 0);

            await session.release();
            console.log(
                `  ${ok ? "ok  " : "FAIL"}  ${model.id} answers with ${tensor.dims.join("×")}`
            );
            failed ||= !ok;
        } catch (error) {
            console.log(`  FAIL  ${model.id}: ${(error as Error).message}`);
            failed = true;
        }
    }

    process.exit(failed ? 1 : 0);
}

for (const model of manifest) {
    const text = isText(model.id);

    console.log(`${model.id}  (${mb(model.bytes)} on disk)`);

    for (const threads of [1, 2]) {
        const before = rss();
        const loadStart = Date.now();
        const session = await openModel(model.id, { threads });
        const loadMs = Date.now() - loadStart;
        const single = await timeRuns(session, model.id, 1, text ? 30 : 10);
        const batched = text ? null : await timeRuns(session, model.id, 16, 2);
        const resident = rss() - before;

        console.log(
            `  ${threads} thread${threads > 1 ? "s" : " "}  load ${String(loadMs).padStart(5)} ms   ` +
                `${single.toFixed(1).padStart(6)} ms/${text ? "query" : "frame"}` +
                (batched === null ? "" : `   ${batched.toFixed(1).padStart(6)} ms/frame in 16s`) +
                `   +${mb(resident)} resident   (${memoryLine()})`
        );

        if (!text && threads === 1) {
            const best = Math.min(single, batched ?? single);
            const hours = (libraryFrames * best) / 3.6e6;

            console.log(
                `            first pass of ${libraryFrames.toLocaleString()} frames at one thread: ~${hours.toFixed(1)} h`
            );
        }

        await session.release();
        console.log(`            released   (${memoryLine()})`);
    }

    console.log("");
}
