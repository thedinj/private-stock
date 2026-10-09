/**
 * Tests that shell out to ffmpeg.
 *
 * Split from the unit suite because they generate fixtures and decode video: seconds rather
 * than milliseconds, and they need a real ffmpeg on the machine. CI runs both; GitHub's
 * Ubuntu runners ship ffmpeg (§ CLAUDE.md, Testing).
 */
export default {
    test: {
        environment: "node",
        include: ["src/**/*.integration.test.ts"],
        // Generating fixtures and decoding them is not a millisecond operation.
        testTimeout: 60_000,
        hookTimeout: 120_000,
    },
};
