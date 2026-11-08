import { describe, expect, it } from "vitest";

import { DEFAULT_DOMAIN, domainProfiles, domainSkipsStage, parseDomain } from "./libraryDomains.js";

describe("domains (§21)", () => {
    it("opens a forgetful browser in a room that is not guarded", () => {
        expect(domainProfiles[DEFAULT_DOMAIN].guarded).toBe(false);
        expect(domainProfiles.cellar.guarded).toBe(true);
    });

    it("runs every stage in the cellar", () => {
        for (const stage of ["faces", "embed", "ocr", "phash", "tileprint"]) {
            expect(domainSkipsStage("cellar", stage)).toBe(false);
        }
    });

    it("skips Look and OCR in the parlour, and keeps its faces", () => {
        expect(domainSkipsStage("family", "embed")).toBe(true);
        expect(domainSkipsStage("family", "ocr")).toBe(true);
        expect(domainSkipsStage("family", "faces")).toBe(false);
    });

    it("skips faces, Look and OCR in the game room, and keeps the duplicate fingerprints", () => {
        expect(domainSkipsStage("games", "faces")).toBe(true);
        expect(domainSkipsStage("games", "embed")).toBe(true);
        expect(domainSkipsStage("games", "ocr")).toBe(true);
        expect(domainSkipsStage("games", "phash")).toBe(false);
        expect(domainSkipsStage("games", "tileprint")).toBe(false);
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
