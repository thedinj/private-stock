import { describe, expect, it } from "vitest";

import { meaningfulLines } from "./hwaccelProbeService";

/**
 * Choosing which of ffmpeg's lines to show (§7).
 *
 * Pure string handling, so it belongs in the fast suite even though the service around it
 * shells out. The fixtures are real output, not invented: the first is what a box with no VA
 * driver printed, the second is what the same box printed once the drivers were installed and
 * a later stage failed instead.
 *
 * The distinction is the whole point. The *same* `iHD_drv_video.so init failed` text appears
 * in both, meaning the cause in one and nothing at all in the other -- and a message that
 * cannot tell them apart sends someone to reinstall a driver that is already working.
 */

const NO_DRIVER_AT_ALL = `
libva info: VA-API version 1.17.0
libva info: Trying to open /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so
libva error: /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so init failed
libva info: va_openDriver() returns 1
[AVHWDeviceContext @ 0x5610308c55c0] Failed to initialise VAAPI connection: -1 (unknown libva error).
Device creation failed: -5.
Failed to set value '/dev/dri/renderD128' for option 'vaapi_device': Input/output error
Error parsing global options: Input/output error
`;

const DRIVER_LOADS_BUT_ENCODER_FAILS = `
libva info: VA-API version 1.17.0
libva info: Trying to open /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so
libva error: /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so init failed
libva info: Trying to open /usr/lib/x86_64-linux-gnu/dri/i965_drv_video.so
libva info: va_openDriver() returns 0
[h264_vaapi @ 0x55a1b2c3d4e0] No usable encoding entrypoint found for profile VAProfileH264High.
Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.
`;

const EVERY_DRIVER_DECLINES = `
libva info: Trying to open /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so
libva error: /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so init failed
libva info: va_openDriver() returns 1
`;

describe("meaningfulLines", () => {
    it("names the real cause when no driver could be loaded", () => {
        const detail = meaningfulLines(NO_DRIVER_AT_ALL);

        expect(detail).toContain("Failed to initialise VAAPI connection");
        expect(detail).not.toContain("Error parsing global options");
    });

    /**
     * The regression. This text was reported as the cause on a box whose driver was fine,
     * because it is simply the first diagnostic-looking line libva prints while searching.
     */
    it("ignores the driver search when a later stage is what failed", () => {
        const detail = meaningfulLines(DRIVER_LOADS_BUT_ENCODER_FAILS);

        expect(detail).toContain("No usable encoding entrypoint found");
        expect(detail).not.toContain("iHD_drv_video.so init failed");
    });

    /** When the search is all there is, it is the answer rather than noise. */
    it("falls back to the driver search when nothing else was said", () => {
        expect(meaningfulLines(EVERY_DRIVER_DECLINES)).toContain("init failed");
    });

    it("strips ffmpeg's component tags", () => {
        expect(meaningfulLines(DRIVER_LOADS_BUT_ENCODER_FAILS)).not.toContain("[h264_vaapi @");
    });

    it("keeps several layers, which disagree usefully", () => {
        const detail = meaningfulLines(NO_DRIVER_AT_ALL);

        expect(detail).toContain("Failed to initialise VAAPI connection");
        expect(detail).toContain("Device creation failed");
    });

    it("says something rather than nothing when ffmpeg said nothing", () => {
        expect(meaningfulLines("   \n  \n")).toBe("ffmpeg failed without saying why");
    });
});
