import { describe, expect, it } from "vitest";

import { joinNetworkPath, networkPathSchema, windowsFileUrl } from "./networkPath.js";

describe("networkPathSchema", () => {
    it("accepts a UNC share and a drive, normalising slashes and the trailing separator", () => {
        expect(networkPathSchema.parse("\\\\NAS\\Multimedia\\")).toBe("\\\\NAS\\Multimedia");
        expect(networkPathSchema.parse("//NAS/Multimedia/Videos")).toBe(
            "\\\\NAS\\Multimedia\\Videos"
        );
        expect(networkPathSchema.parse(" Z:\\Videos ")).toBe("Z:\\Videos");
        expect(networkPathSchema.parse("Z:\\")).toBe("Z:");
    });

    it("refuses what Windows could not open", () => {
        expect(networkPathSchema.safeParse("/media/videos").success).toBe(false);
        expect(networkPathSchema.safeParse("\\\\NAS").success).toBe(false);
        expect(networkPathSchema.safeParse("Videos").success).toBe(false);
        expect(networkPathSchema.safeParse("\\\\NAS\\a\u0007b").success).toBe(false);
    });
});

describe("windowsFileUrl", () => {
    it("puts a UNC host in the authority and encodes each segment", () => {
        expect(
            windowsFileUrl(joinNetworkPath("\\\\NAS\\Multimedia", "Holiday 2024/a #1 (100%).mp4"))
        ).toBe("file://NAS/Multimedia/Holiday%202024/a%20%231%20(100%25).mp4");
    });

    it("gives a drive letter an empty authority", () => {
        expect(windowsFileUrl("Z:\\Videos\\clip.mp4")).toBe("file:///Z:/Videos/clip.mp4");
    });
});
