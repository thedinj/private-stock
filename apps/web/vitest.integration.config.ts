import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * The web app's tests that shell out to ffmpeg.
 *
 * Split from the unit suite for the reason the worker's is (§ CLAUDE.md, Testing): a test that
 * needs a real ffmpeg must not sit in the suite everyone runs on every change. The include
 * pattern here and the exclude in the `test` script are two halves of one rule — a test is
 * routed by its filename, so neither has to be remembered.
 *
 * The alias is repeated rather than shared because Vitest reads one config per run and a
 * `@/` import that fails to resolve does not error loudly; it silently makes the file
 * untestable, which is how the unit config's comment came to be written.
 */
export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.integration.test.ts"],
        // Spawning an encoder is not a millisecond operation, and a failing hwaccel probe is
        // allowed to spend its whole timeout before it answers.
        testTimeout: 60_000,
        hookTimeout: 120_000,
    },
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
});
