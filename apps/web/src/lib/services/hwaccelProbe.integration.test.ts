import { describe, expect, it } from "vitest";

import { buildHwaccelProbeArgs, videoEncoder } from "@private-stock/core";

import { probeHwaccel } from "./hwaccelProbeService";

import type { AuthContext } from "../auth/withAuth";

/**
 * The hwaccel probe, against a real ffmpeg (§7).
 *
 * Integration rather than unit, and named so the runner routes it: it shells out. Only the
 * `none` case can be asserted to succeed — CI runners have no `/dev/dri`, and a test that
 * required one would fail on every machine except the NAS it was written for.
 *
 * What is worth testing everywhere is the shape of a *failure*, because that is the path the
 * button exists to light up and the path nobody exercises by accident.
 */

const admin = { userId: "u1", scopes: ["admin"] } as unknown as AuthContext;
const viewer = { userId: "u2", scopes: [] } as unknown as AuthContext;

describe("probeHwaccel", () => {
    it("confirms software encoding, which is always available", async () => {
        const result = await probeHwaccel(admin, "none");

        expect(result).toMatchObject({ hwaccel: "none", ok: true, encoder: "libx264" });
    });

    /**
     * A box without the hardware must get an answer, not an exception.
     *
     * Throwing would surface as a 500 and an error toast, which reads as "the button is
     * broken" rather than "the encoder is unavailable" — and those call for opposite actions.
     */
    it("reports a missing backend as a result rather than throwing", async () => {
        const result = await probeHwaccel(admin, "nvenc");

        // NVENC on a CI runner or a QNAP is absent, so this is the failure path. If a machine
        // running this does have an NVIDIA card, the probe is entitled to succeed.
        expect(result.hwaccel).toBe("nvenc");
        expect(result.encoder).toBe("h264_nvenc");
        expect(typeof result.detail).toBe("string");
        expect(result.detail.length).toBeGreaterThan(0);

        if (!result.ok) {
            // The point of `firstMeaningfulLine`: never the parse error that says nothing.
            expect(result.detail).not.toMatch(/^Error parsing global options/);
        }
    });

    it("refuses a caller without the admin scope", async () => {
        await expect(probeHwaccel(viewer, "none")).rejects.toThrow(/admin/);
    });
});

/**
 * The probe and the real jobs must use one set of arguments.
 *
 * This is the drift guard. A probe assembled separately from `buildTranscodeArgs` would keep
 * passing while the jobs it vouches for started failing — and a test that says the hardware
 * works while the hardware does not is worse than having no test.
 */
describe("buildHwaccelProbeArgs", () => {
    it("asks for the same encoder the real transcode would", () => {
        for (const mode of ["none", "vaapi", "qsv", "nvenc"] as const) {
            expect(buildHwaccelProbeArgs(mode)).toContain(videoEncoder(mode));
        }
    });

    it("uploads frames for VAAPI, which is the part that fails without a driver", () => {
        expect(buildHwaccelProbeArgs("vaapi").join(" ")).toContain("format=nv12,hwupload");
        expect(buildHwaccelProbeArgs("vaapi")).toContain("/dev/dri/renderD128");
    });

    it("needs no media file, so it cannot fail for reasons of its own", () => {
        const args = buildHwaccelProbeArgs("none").join(" ");

        expect(args).toContain("lavfi");
        expect(args).toContain("testsrc");
    });
});
