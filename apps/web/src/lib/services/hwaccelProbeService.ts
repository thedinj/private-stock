import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
    HWACCEL_PROBE_TIMEOUT_MS,
    buildHwaccelProbeArgs,
    videoEncoder,
    type Hwaccel,
    type HwaccelProbeResult,
} from "@private-stock/core";
import { resolveFfmpeg } from "@private-stock/core/server";

import { requireScope, type AuthContext } from "../auth/withAuth";

/**
 * Does the hardware the settings claim actually exist and work (§7)?
 *
 * The setting alone cannot answer it. `/dev/dri` being mounted, readable, backed by a libva
 * driver, and matched by an ffmpeg build carrying the encoder are four separate facts, and a
 * deployment can have any three. When one is missing the transcode job fails rather than the
 * settings page, so the operator learns about it as "every conversion is broken" long after
 * the change that caused it -- which is the case ARCHITECTURE calls worse than no
 * configuration at all.
 *
 * **This is the second ffmpeg call in the web process, and like the first (`frameService`) the
 * exception is deliberate (§2).** The rule exists because transcodes saturate CPU for minutes
 * and must not share a process with request handling. This is one second of 640x480 synthetic
 * video with a hard timeout, and it has to run here rather than in the worker for the same
 * reason the frame capture does: the answer is only useful while the person is looking at the
 * settings page, and a queued job cannot promise that. Going through the queue would also
 * measure the wrong process -- `entrypoint.sh` grants `/dev/dri` to both, but "the worker can
 * reach it" is not the question a button beside the dropdown is asking.
 */

const execFileAsync = promisify(execFile);

/**
 * libva narrating its own driver search, which is not a diagnosis.
 *
 * libva tries each installed driver in turn and reports the ones that decline. The image
 * carries both Intel drivers, so on the Haswell this was first deployed to the search
 * *always* prints `iHD_drv_video.so init failed` before loading i965 and succeeding -- the
 * line appears on healthy runs. Taking the earliest diagnostic-looking line therefore
 * reported a real downstream failure as a driver problem that did not exist: the exact
 * misdirection this function was written to prevent, pointed the other way.
 *
 * Filtered rather than dropped outright, because when *every* driver declines these lines are
 * the whole story. They are used when nothing else survives.
 */
const LIBVA_SEARCH_NOISE = /^libva(\s|:|\s+(info|error):)/;

/** Always true, never the cause: the outer layer restating that something inside failed. */
const GENERIC_TRAILER = /^(Error parsing global options|Error opening (input|output) files)/;

/**
 * The lines worth showing out of everything ffmpeg said.
 *
 * ffmpeg reports one failure at several layers -- the driver, the device, the option that
 * wanted the device, the parse that wanted the option. The earliest real diagnosis names the
 * cause and the last is boilerplate, so this keeps the first few once the noise is gone.
 *
 * Several lines rather than one, because the layers disagree usefully: "Device creation
 * failed" alone does not separate a missing driver from a device this process may not open,
 * and the line above it does.
 */
export const meaningfulLines = (stderr: string, limit = 3): string => {
    const lines = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        // Bracketed prefixes are ffmpeg's component tags, e.g. "[AVHWDeviceContext @ 0x...]".
        .map((line) => line.replace(/^\[[^\]]+\]\s*/, ""))
        .filter((line) => !GENERIC_TRAILER.test(line));

    const substantive = lines.filter((line) => !LIBVA_SEARCH_NOISE.test(line));
    const chosen = substantive.length > 0 ? substantive : lines;

    return chosen.slice(0, limit).join("\n") || "ffmpeg failed without saying why";
};

export const probeHwaccel = async (
    auth: AuthContext,
    hwaccel: Hwaccel
): Promise<HwaccelProbeResult> => {
    // Spawning a process is not something a viewer gets to do, however cheap it is.
    requireScope(auth, "admin");

    const encoder = videoEncoder(hwaccel);

    try {
        const ffmpeg = await resolveFfmpeg();

        await execFileAsync(ffmpeg, buildHwaccelProbeArgs(hwaccel), {
            timeout: HWACCEL_PROBE_TIMEOUT_MS,
            // ffmpeg is chatty on stderr even when it succeeds; this is well clear of that and
            // still bounded, because a runaway is the thing being guarded against.
            maxBuffer: 1024 * 1024,
        });

        return {
            hwaccel,
            ok: true,
            encoder,
            detail:
                hwaccel === "none"
                    ? "Software encoding with libx264. Always available."
                    : `Encoded a test clip with ${encoder}.`,
        };
    } catch (error) {
        // A failed probe is a successful answer. Throwing here would render as a 500 and an
        // error toast, when what happened is the button doing its job.
        const stderr =
            error && typeof error === "object" && "stderr" in error
                ? String((error as { stderr: unknown }).stderr)
                : "";

        const killed =
            error && typeof error === "object" && "killed" in error
                ? Boolean((error as { killed: unknown }).killed)
                : false;

        return {
            hwaccel,
            ok: false,
            encoder,
            detail: killed
                ? `${encoder} did not finish within ${HWACCEL_PROBE_TIMEOUT_MS / 1000}s and was stopped.`
                : meaningfulLines(stderr || String(error)),
        };
    }
};
