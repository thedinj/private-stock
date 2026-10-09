import { describe, expect, it } from "vitest";

import {
    STAGES,
    findStage,
    needsWork,
    prerequisiteOf,
    prerequisiteSettled,
    requestedPriority,
    stageApplies,
    stageModeSchema,
    type StageDefinition,
    type StageState,
} from "./stages.js";

/**
 * `needsWork` is the single rule deciding what the library reprocesses, so it is where a
 * mistake is both cheapest to make and hardest to see. Getting it wrong in one direction
 * means work is never done; in the other, it means the same item is reprocessed every five
 * minutes forever — which is what the previous scheme did, and nobody noticed because
 * nothing about it looks like an error.
 */

const stage = (overrides: Partial<StageDefinition> = {}): StageDefinition => ({
    name: "test",
    version: 2,
    mode: "automatic",
    appliesTo: "all",
    priority: 100,
    maxAttempts: 3,
    needsProbe: false,
    describe: "test",
    ...overrides,
});

const recorded = (state: StageState, version = 2, attempts = 0) => ({ state, version, attempts });

describe("needsWork", () => {
    it("is true when the stage has never run", () => {
        expect(needsWork(stage(), null)).toBe(true);
    });

    it("is false once it has been done at the current version", () => {
        expect(needsWork(stage(), recorded("done"))).toBe(false);
    });

    describe("outcomes that are settled", () => {
        /**
         * The regression this whole table exists for.
         *
         * A blank image has no perceptual hash and a five-second clip has no preview. The
         * stage ran, correctly produced nothing, and must be left alone — under the old
         * "does an output row exist" test these were indistinguishable from never having
         * run, and the sweep re-queued them every five minutes for the life of the library.
         */
        it.each(["empty", "skipped"] as const)("leaves %s alone", (state) => {
            expect(needsWork(stage(), recorded(state))).toBe(false);
        });
    });

    describe("failures", () => {
        it("retries below the attempt limit", () => {
            expect(needsWork(stage({ maxAttempts: 3 }), recorded("failed", 2, 1))).toBe(true);
        });

        it("stops at the limit", () => {
            // Otherwise one corrupt file occupies the queue indefinitely, on hardware whose
            // whole problem is that it has no spare capacity.
            expect(needsWork(stage({ maxAttempts: 3 }), recorded("failed", 2, 3))).toBe(false);
        });

        it("retries forever when the stage says to", () => {
            expect(needsWork(stage({ maxAttempts: null }), recorded("failed", 2, 99))).toBe(true);
        });
    });

    describe("recipe versions", () => {
        it("re-runs anything below the current version", () => {
            expect(needsWork(stage({ version: 3 }), recorded("done", 2))).toBe(true);
        });

        it("re-runs an exhausted failure after a version bump", () => {
            // A better recipe deserves a fresh attempt at the files the old one choked on —
            // that is usually *why* the recipe changed.
            expect(needsWork(stage({ version: 3, maxAttempts: 3 }), recorded("failed", 2, 9))).toBe(
                true
            );
        });

        it("re-runs an empty result after a version bump", () => {
            // A stage that found nothing under the old recipe may find something under the
            // new one; "settled" is only ever settled at a particular version.
            expect(needsWork(stage({ version: 3 }), recorded("empty", 2))).toBe(true);
        });

        it("does not re-run a version ahead of the registry", () => {
            // Rolling the app back must not reprocess the library with an older recipe.
            expect(needsWork(stage({ version: 2 }), recorded("done", 5))).toBe(false);
        });
    });
});

describe("stageApplies", () => {
    it("matches the kind a stage is for", () => {
        expect(stageApplies(stage({ appliesTo: "video" }), "video")).toBe(true);
        expect(stageApplies(stage({ appliesTo: "video" }), "image")).toBe(false);
        expect(stageApplies(stage({ appliesTo: "all" }), "image")).toBe(true);
    });
});

describe("the registry", () => {
    it("has unique names", () => {
        // The name is the key of the stage row and the job kind; a duplicate would make two
        // capabilities silently overwrite each other's record.
        expect(new Set(STAGES.map((s) => s.name)).size).toBe(STAGES.length);
    });

    it("finds a stage by name and nothing by a name that is not one", () => {
        expect(findStage("cover")?.name).toBe("cover");
        // This used to name `ocr` as the example of something that is not a stage. It is
        // one now (§5d), which is the registry working as intended: a capability is an
        // entry here and a handler, and nothing else.
        expect(findStage("transcribe")).toBeUndefined();
        expect(findStage("")).toBeUndefined();
    });

    it("keeps the expensive capability off the sweep until it is asked for", () => {
        // OCR is by a wide margin the costliest thing the pipeline can do, so it must be
        // something an administrator turns on rather than something that starts working
        // through 200k items because the capability was added (§5d).
        expect(findStage("ocr")?.mode).toBe("optIn");
    });

    it("offers three answers to how a stage comes to run", () => {
        // The middle one is the whole point (§7b): with only `automatic` and "never swept",
        // an expensive capability could be offered per item or not at all, and asking for it
        // across a library was not something the vocabulary could say.
        expect(stageModeSchema.options).toEqual(["automatic", "optIn", "perItem"]);
    });

    it("hashes for duplicates after the cover and before the expensive artifacts", () => {
        // A duplicate has to be visible to be judged, so the cover and the index go first. After
        // that, finding it is worth more than a preview or a sprite that deleting it would waste.
        const priority = (name: string) => findStage(name)?.priority ?? 0;

        expect(priority("cover")).toBeLessThan(priority("index"));
        expect(priority("index")).toBeLessThan(priority("phash"));
        expect(priority("phash")).toBeLessThan(priority("preview"));
        expect(priority("phash")).toBeLessThan(priority("sprite"));
    });

    it("identifies a file before anything renders it", () => {
        // An identical copy borrows its twin's artifacts (§10f), which it can only do once its
        // content hash is known. Swept identity hashes must not queue behind swept covers.
        const priority = (name: string) => findStage(name)?.priority ?? 0;
        const others = STAGES.filter((s) => s.name !== "filehash").map((s) => s.priority);

        expect(priority("filehash")).toBeLessThan(Math.min(...others));
    });

    /**
     * The claim takes the lowest priority first, across kinds, so this is what "somebody asked
     * for it" means to the queue. The reported case: a requested OCR pass at 150 waited all
     * night behind 8,415 automatic sprites at 140.
     */
    it("puts every requested pass ahead of every automatic one", () => {
        const lowestAutomatic = Math.min(...STAGES.map((s) => s.priority));

        for (const s of STAGES) {
            expect(requestedPriority(s)).toBeLessThan(lowestAutomatic);
        }
    });

    it("keeps the registry's order among requests", () => {
        const requested = (name: string) => requestedPriority(findStage(name) as StageDefinition);

        expect(requested("cover")).toBeLessThan(requested("sprite"));
        expect(requested("sprite")).toBeLessThan(requested("ocr"));
        expect(requestedPriority(stage({ priority: 3 }))).toBe(1);
    });

    it("bounds every stage's retries", () => {
        // A stage that retries forever on a NAS is a stage that eventually owns the queue.
        expect(STAGES.every((s) => s.maxAttempts === null || s.maxAttempts > 0)).toBe(true);
    });
});

describe("prerequisites", () => {
    it("names only stages that exist, run earlier, and apply to the same kind", () => {
        for (const stage of STAGES) {
            for (const kind of ["image", "video"] as const) {
                const name = stage.requires?.[kind];

                if (!name) continue;

                const prerequisite = prerequisiteOf(stage, kind);

                expect(prerequisite, `${stage.name} requires ${name}`).not.toBeNull();
                expect(stageApplies(prerequisite!, kind)).toBe(true);
                expect(prerequisite!.priority).toBeLessThan(stage.priority);
            }
        }
    });

    it("waits for the sprite on a video and the cover on a photograph", () => {
        const embed = findStage("embed")!;
        const sprite = findStage("sprite")!;
        const at = (state: StageState, attempts = 1) => ({
            version: sprite.version,
            state,
            attempts,
        });

        expect(prerequisiteSettled(embed, "video", null)).toBe(false);
        expect(prerequisiteSettled(embed, "video", at("done"))).toBe(true);
        // Settled with nothing to read is still settled: the stage records empty itself.
        expect(prerequisiteSettled(embed, "video", at("empty"))).toBe(true);
        expect(prerequisiteSettled(embed, "video", at("failed", 1))).toBe(false);
        expect(prerequisiteSettled(embed, "video", at("failed", sprite.maxAttempts!))).toBe(true);
        expect(prerequisiteOf(embed, "image")?.name).toBe("cover");
    });

    it("is always ready for a stage without one", () => {
        expect(prerequisiteSettled(findStage("phash")!, "video", null)).toBe(true);
    });
});
