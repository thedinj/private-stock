import type { Rect } from "@private-stock/core";

/**
 * What the worker and its model child say to each other (§5e, §5f).
 *
 * The child exists because a released model does not give its memory back under glibc (§5e
 * "Memory"): the only reliable way to return it is for the process holding it to end. So the
 * worker hands one item at a time to a child that loads the model, and kills it when the queue
 * goes quiet.
 *
 * One child serves both families of model — CLIP for `embed`, the face models for `faces` — but
 * never both at once: the worker retires it before asking it about the other family, so it only
 * ever holds one set of models (`embedder.ts`).
 */

/** One picture to read: a sprite sheet or a cover, and the regions of it that are moments. */
export interface EmbedSource {
    absolutePath: string;
    width: number;
    height: number;
    moments: { rect: Rect; atMs: number | null }[];
}

export interface EmbedRequest {
    model: string;
    stageVersion: number;
    /** The per-job thread cap at the moment the job started (§7c). */
    threads: number;
    sources: EmbedSource[];
    /** Where the vectors file goes; written to a temporary name and renamed into place. */
    outPath: string;
}

export interface EmbedResult {
    /** Moments read before thinning. */
    moments: number;
    /** Moments kept after thinning. */
    kept: number;
    /** Vectors written — a kept moment has one per square. Zero means nothing was written. */
    vectors: number;
}

/** One picture to look for faces in, and the regions of it to look at. */
export interface FacesSource {
    absolutePath: string;
    width: number;
    height: number;
    regions: { rect: Rect; atMs: number | null }[];
}

export interface FacesRequest {
    detector: string;
    recogniser: string;
    stageVersion: number;
    /** The per-job thread cap at the moment the job started (§7c). */
    threads: number;
    sources: FacesSource[];
    /** Where the faces file goes, when there are any; written by rename, as a vectors file is. */
    outPath: string;
}

/** A face kept: where, as fractions of its region, how large and how sure, and its vector's place. */
export interface KeptFace {
    vectorIndex: number;
    atMs: number | null;
    x: number;
    y: number;
    w: number;
    h: number;
    eyes: number;
    score: number;
}

export interface FacesResult {
    /** Regions looked at. */
    regions: number;
    /** Faces the detector found in them, before the size floor and the cap. */
    detected: number;
    /** The faces kept and recognised. Empty means nothing was written. */
    faces: KeptFace[];
}

/** Which family of models a request needs: the child holds one family at a time. */
export type ModelFamily = "embed" | "faces";

export type ModelRequest = ({ kind: "embed" } & EmbedRequest) | ({ kind: "faces" } & FacesRequest);

export type ParentMessage = { id: number; request: ModelRequest };

/**
 * Every answer carries the child's resident size when it gave it, in bytes: how the worker decides
 * the child has grown enough to be replaced (`embedder.ts`), on any platform. Linux also lets the
 * worker read it from `/proc` while a request runs, which is what enforces the ceiling.
 */
export type ChildMessage =
    | { id: number; ok: true; result: EmbedResult | FacesResult; rss: number }
    | { id: number; ok: false; error: string; rss: number };
