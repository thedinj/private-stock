import { describe, expect, it } from "vitest";

import { DEFAULT_DOMAIN, domainProfiles, domainSkipsStage, parseDomain } from "./libraryDomains.js";

describe("domains (§21)", () => {
    it("opens a forgetful browser in a room that is not guarded", () => {
        expect(domainProfiles[DEFAULT_DOMAIN].guarded).toBe(false);
        expect(domainProfiles.cellar.guarded).toBe(true);
    });

    it("skips faces in the game room and nowhere else", () => {
        expect(domainSkipsStage("games", "faces")).toBe(true);
        expect(domainSkipsStage("family", "faces")).toBe(false);
        expect(domainSkipsStage("cellar", "faces")).toBe(false);
        expect(domainSkipsStage("games", "ocr")).toBe(false);
    });

    it("runs a stage for a room it does not know, rather than silently skipping it", () => {
        expect(domainSkipsStage("attic", "faces")).toBe(false);
        expect(domainSkipsStage(undefined, "faces")).toBe(false);
    });

    it("reads only the rooms it knows", () => {
        expect(parseDomain("family")).toBe("family");
        expect(parseDomain("Family")).toBeNull();
        expect(parseDomain(null)).toBeNull();
    });
});
