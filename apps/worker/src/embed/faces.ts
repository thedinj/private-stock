import type { InferenceSession } from "onnxruntime-node";

import {
    FACE_SIDE,
    chooseFaces,
    decodeDetections,
    detectorLayout,
    encodeVectorFile,
    eyeDistance,
    normaliseVector,
    quantize,
    writeDetectorInput,
    writeFaceInput,
    type Detection,
} from "@private-stock/core";
import { openModel } from "@private-stock/core/server";

import { decodePicture, writeInPlace } from "./pictures.js";
import type { FacesRequest, FacesResult, KeptFace } from "./protocol.js";

/**
 * The faces half of the model child (§5f): find faces in an item's regions, keep the best, and
 * write a vector for each.
 *
 * Two passes over the pictures. The first detects in every region — a hundred-odd sprite tiles
 * of a video, or a photograph's cover — and keeps where each face is; then the faces worth
 * recognising are chosen across the whole item (`chooseFaces`), and the second pass reads again
 * only the pictures those are in. Holding every decoded sheet of a long video between the two
 * would be a few hundred MB; reading one twice is a few tens of milliseconds.
 */

let sessions: {
    detector: string;
    recogniser: string;
    threads: number;
    detect: InferenceSession;
    recognise: InferenceSession;
} | null = null;

const sessionsFor = async (request: FacesRequest): Promise<NonNullable<typeof sessions>> => {
    if (
        sessions?.detector === request.detector &&
        sessions.recogniser === request.recogniser &&
        sessions.threads === request.threads
    ) {
        return sessions;
    }

    // A changed thread cap means new sessions; what the old ones held stays with this process
    // until it exits, which is soon. No arena: this process ends rather than releasing.
    await sessions?.detect.release();
    await sessions?.recognise.release();

    // `basic`: the same answers in ~130 MB less (`OpenModelOptions.optimization`).
    const options = { threads: request.threads, arena: false, optimization: "basic" as const };

    sessions = {
        detector: request.detector,
        recogniser: request.recogniser,
        threads: request.threads,
        detect: await openModel(request.detector, options),
        recognise: await openModel(request.recogniser, options),
    };

    return sessions;
};

interface Found extends Detection {
    source: number;
    region: number;
}

export const facesRequest = async (request: FacesRequest): Promise<FacesResult> => {
    const ort = await import("onnxruntime-node");
    const { detect, recognise } = await sessionsFor(request);
    const found: Found[] = [];
    let regions = 0;

    for (const [s, source] of request.sources.entries()) {
        const rgb = await decodePicture(source);

        for (const [r, { rect }] of source.regions.entries()) {
            const layout = detectorLayout(rect.width, rect.height);
            const input = new Float32Array(3 * layout.width * layout.height);

            writeDetectorInput(rgb, source.width, rect, layout, input);

            const outputs = await detect.run({
                [detect.inputNames[0]]: new ort.Tensor("float32", input, [
                    1,
                    3,
                    layout.height,
                    layout.width,
                ]),
            });

            regions += 1;
            found.push(
                ...decodeDetections(
                    detect.outputNames.map((name) => outputs[name].data as Float32Array),
                    layout
                ).map((detection) => ({ ...detection, source: s, region: r }))
            );
        }
    }

    const chosen = chooseFaces(found);

    if (chosen.length === 0) {
        return { regions, detected: found.length, faces: [] };
    }

    const vectors: Float32Array[] = [];
    const faces: KeptFace[] = [];
    const input = new Float32Array(3 * FACE_SIDE * FACE_SIDE);

    // In the order chosen, which is the order a person would trust them in, read source by source.
    const order = chosen.map((face, index) => ({ face, index }));

    for (const s of new Set(chosen.map((face) => face.source))) {
        const source = request.sources[s];
        const rgb = await decodePicture(source);

        for (const { face, index } of order.filter((entry) => entry.face.source === s)) {
            const { rect, atMs } = source.regions[face.region];

            writeFaceInput(rgb, source.width, rect, face.landmarks, input);

            const outputs = await recognise.run({
                [recognise.inputNames[0]]: new ort.Tensor("float32", input, [
                    1,
                    3,
                    FACE_SIDE,
                    FACE_SIDE,
                ]),
            });

            vectors[index] = normaliseVector(
                Float32Array.from(outputs[recognise.outputNames[0]].data as Float32Array)
            );
            faces[index] = {
                vectorIndex: index,
                atMs,
                x: face.box.x / rect.width,
                y: face.box.y / rect.height,
                w: face.box.width / rect.width,
                h: face.box.height / rect.height,
                eyes: Math.round(eyeDistance(face) * 10) / 10,
                score: Math.round(face.score * 1000) / 1000,
            };
        }
    }

    await writeInPlace(
        request.outPath,
        encodeVectorFile({
            model: request.recogniser,
            stageVersion: request.stageVersion,
            dims: vectors[0].length,
            vectors: faces.map((face, index) => ({
                atMs: face.atMs,
                square: 0,
                vector: quantize(vectors[index]),
            })),
            representatives: [],
        })
    );

    return { regions, detected: found.length, faces };
};
