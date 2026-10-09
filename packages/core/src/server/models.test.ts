import { describe, expect, it } from "vitest";

import { sessionOptions } from "./models.js";

/**
 * What a model session is told about threads and memory (§5e, §7c). A session sized from the
 * cores it can see takes the host's four inside a two-core quota, and one that keeps its arena
 * grows for as long as its process lives.
 */
describe("sessionOptions", () => {
    it("runs on exactly the threads it is given, one operator at a time", () => {
        expect(sessionOptions({ threads: 1 })).toMatchObject({
            intraOpNumThreads: 1,
            interOpNumThreads: 1,
            executionMode: "sequential",
        });
        expect(sessionOptions({ threads: 3 }).intraOpNumThreads).toBe(3);
    });

    it("never passes zero, which onnxruntime reads as every core", () => {
        expect(sessionOptions({ threads: 0 }).intraOpNumThreads).toBe(1);
        expect(sessionOptions({ threads: 0.5 }).intraOpNumThreads).toBe(1);
    });

    it("keeps the arena unless told otherwise", () => {
        expect(sessionOptions({ threads: 1 })).toMatchObject({
            enableCpuMemArena: true,
            enableMemPattern: true,
        });
    });

    it("optimises the graph fully unless told to keep it light", () => {
        expect(sessionOptions({ threads: 1 }).graphOptimizationLevel).toBe("all");
        expect(sessionOptions({ threads: 1, optimization: "basic" }).graphOptimizationLevel).toBe(
            "basic"
        );
    });

    it("logs errors only, so a per-tile warning cannot flood the worker's output", () => {
        expect(sessionOptions({ threads: 1 }).logSeverityLevel).toBe(3);
    });

    it("drops the arena and the planned buffers for a process that exits instead", () => {
        expect(sessionOptions({ threads: 1, arena: false })).toMatchObject({
            enableCpuMemArena: false,
            enableMemPattern: false,
        });
    });
});
