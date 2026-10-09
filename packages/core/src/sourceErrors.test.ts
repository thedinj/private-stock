import { describe, expect, it } from "vitest";

import { describesUnreadableSource, failureReason, isUnreadableSource } from "./sourceErrors.js";

/** What `execFile` rejects with: the command line, then the child's stderr. */
const commandFailed = (stderr: string): Error =>
    new Error(`Command failed: /usr/bin/ffmpeg -v error -y -i /media/a.mp4 out.webp\n${stderr}`);

describe("isUnreadableSource", () => {
    it("recognises a truncated MP4, as ffmpeg reported it on the NAS", () => {
        const error = commandFailed(
            "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55dd5a388640] moov atom not found\n" +
                "/media/a.mp4: Invalid data found when processing input\n"
        );

        expect(isUnreadableSource(error)).toBe(true);
    });

    it("recognises a Matroska file with no header", () => {
        expect(isUnreadableSource(commandFailed("EBML header parsing failed\n"))).toBe(true);
    });

    /** The case the retries exist for, and the one a broad pattern would swallow. */
    it("leaves an I/O error to be retried", () => {
        expect(isUnreadableSource(commandFailed("/media/a.mp4: Input/output error\n"))).toBe(false);
    });

    /** A timeout carries the stderr so far, and a damaged file's stderr names the markers. */
    it("leaves a killed process to be retried, whatever its stderr says", () => {
        const error = Object.assign(
            commandFailed(
                "[h264 @ 0x558bfb700a00] Invalid NAL unit size (-1834426337 > 76269).\n" +
                    "Error while decoding stream #0:0: Invalid data found when processing input\n"
            ),
            { killed: true, signal: "SIGTERM" }
        );

        expect(isUnreadableSource(error)).toBe(false);
    });

    /** The same AVERROR_INVALIDDATA text, about one packet of a file that did open. */
    it("leaves a decode error in a file that opened to be retried", () => {
        const error = commandFailed(
            "[h264 @ 0x558bfb700a00] Invalid NAL unit size (-1834426337 > 76269).\n" +
                "Error while decoding stream #0:0: Invalid data found when processing input\n"
        );

        expect(isUnreadableSource(error)).toBe(false);
    });

    it("still recognises a file that cannot be opened beside decode errors", () => {
        const error = commandFailed(
            "Error while decoding stream #0:0: Invalid data found when processing input\n" +
                "/media/b.mp4: Invalid data found when processing input\n"
        );

        expect(isUnreadableSource(error)).toBe(true);
    });

    it("leaves failures that are not about the source to be retried", () => {
        expect(isUnreadableSource(new Error("spawn /usr/bin/ffmpeg ENOENT"))).toBe(false);
        expect(isUnreadableSource(commandFailed("Conversion failed!\n"))).toBe(false);
        expect(isUnreadableSource("something else")).toBe(false);
    });
});

describe("describesUnreadableSource", () => {
    /** Stored text, read back long after the error object is gone. */
    it("reads the same markers out of a stage row's text", () => {
        expect(describesUnreadableSource("ffprobe exited with code 1\nmoov atom not found")).toBe(
            true
        );
        expect(describesUnreadableSource("ffprobe was stopped at its time limit")).toBe(false);
        expect(
            describesUnreadableSource(
                "Error while decoding stream #0:0: Invalid data found when processing input"
            )
        ).toBe(false);
    });
});

/** What a one-line row of failed work shows, out of everything that was recorded. */
describe("failureReason", () => {
    it("names the damage rather than the command line or the summary after it", () => {
        expect(
            failureReason(
                "Command failed: /usr/bin/ffprobe -v error /media/a.mp4\n" +
                    "[mov,mp4 @ 0x1] moov atom not found\n" +
                    "/media/a.mp4: Invalid data found when processing input\n"
            )
        ).toBe("[mov,mp4 @ 0x1] moov atom not found");
    });

    it("takes ffmpeg's last word past the exit line when nothing names damage", () => {
        expect(
            failureReason(
                "ffmpeg exited with code 1\n[concat @ 0x1] Impossible to open 'a.ts'\nEnd of file"
            )
        ).toBe("End of file");
    });

    it("keeps the preamble when it is all there is", () => {
        expect(failureReason("ffmpeg was killed (SIGTERM)")).toBe("ffmpeg was killed (SIGTERM)");
        expect(failureReason(null)).toBeNull();
    });
});
