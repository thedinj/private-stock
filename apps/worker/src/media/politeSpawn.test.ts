import { describe, expect, it } from "vitest";

import { isUnreadableSource } from "@private-stock/core";

import { ProcessFailedError, runPolitely } from "./politeSpawn.js";

/** Node itself as the child: every machine that runs these tests has it, unlike ffmpeg. */
const node = (script: string, timeoutMs = 10_000): Promise<void> =>
    runPolitely(process.execPath, ["-e", script], { timeoutMs });

const rejection = async (promise: Promise<void>): Promise<ProcessFailedError> => {
    const error = await promise.then(
        () => null,
        (caught: unknown) => caught
    );

    if (!(error instanceof ProcessFailedError)) {
        throw new Error(`expected a ProcessFailedError, got ${String(error)}`);
    }

    return error;
};

describe("runPolitely", () => {
    /**
     * ffmpeg decoding past damage logs several lines per bad packet; one production file wrote
     * 7 MB of them, and `execFile`'s 1 MB cap killed the run that had been told to tolerate it.
     */
    it("lets a child write far more stderr than execFile's buffer would hold", async () => {
        await expect(
            node(`process.stderr.write("Error while decoding\\n".repeat(400_000))`)
        ).resolves.toBeUndefined();
    });

    it("reports the exit code and the end of stderr, not all of it", async () => {
        const error = await rejection(
            node(
                `process.stderr.write("noise\\n".repeat(200_000));` +
                    `process.stderr.write("moov atom not found\\n", () => process.exit(3))`
            )
        );

        expect(error.code).toBe(3);
        expect(error.killed).toBe(false);
        expect(error.message).toMatch(/exited with code 3/);
        expect(error.message).toMatch(/moov atom not found$/);
        expect(error.message.length).toBeLessThan(70 * 1024);
        expect(isUnreadableSource(error)).toBe(true);
    });

    /** A timeout must stay retryable whatever its stderr says (`isUnreadableSource`). */
    it("says when it stopped a child at its time limit", async () => {
        const error = await rejection(
            node(`process.stderr.write("moov atom not found\\n"); setInterval(() => {}, 1000)`, 500)
        );

        expect(error.killed).toBe(true);
        expect(error.message).toMatch(/time limit/);
        expect(isUnreadableSource(error)).toBe(false);
    });
});
