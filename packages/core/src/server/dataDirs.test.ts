import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
    DATA_DIR_KIND,
    countDerivedFiles,
    countFilesUnder,
    dataPaths,
    derivedDataDirs,
    resetDataDirs,
    type DataDirName,
} from "./index.js";

import type { Config } from "../config.js";

/**
 * Which directories under `dataDir` a reset may empty (§13d).
 *
 * This is the one classification in the app where being wrong in the generous direction
 * destroys files that exist nowhere else. The map is exhaustive at compile time; what these
 * assert is that the two entries which must never drift into "derived" have not, and that the
 * list of what a reset deletes is actually built from the map rather than duplicated beside
 * it.
 */

let dataDir: string;
const config = (): Config => ({ dataDir }) as Config;

beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ps-datadirs-"));
});

afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
});

describe("DATA_DIR_KIND", () => {
    it("classifies every directory dataPaths knows about", () => {
        // The Record type enforces this; the test states it, because the compile error is
        // easy to satisfy with a careless "derived" and this is the place to notice that.
        const named = Object.keys(dataPaths(config())) as DataDirName[];

        expect(new Set(Object.keys(DATA_DIR_KIND))).toEqual(new Set(named));
    });

    /**
     * Trashed bytes were removed from a media root and exist nowhere else, and the backups
     * are the only thing standing behind a migration that succeeded and was wrong. Neither
     * can be rebuilt from anything, so neither may ever appear in a list of things a reset
     * deletes.
     */
    it("never calls the irreplaceable directories derived", () => {
        expect(DATA_DIR_KIND.trash).toBe("irreplaceable");
        expect(DATA_DIR_KIND.backups).toBe("irreplaceable");
        expect(DATA_DIR_KIND.database).toBe("irreplaceable");
    });
});

describe("derivedDataDirs", () => {
    it("lists exactly the rebuildable directories", () => {
        const paths = dataPaths(config());

        expect(new Set(derivedDataDirs(config()))).toEqual(
            new Set([
                paths.art,
                paths.variants,
                paths.hls,
                paths.sidecars,
                paths.ocrTune,
                paths.embed,
                paths.faces,
                paths.tileprints,
                paths.segments,
            ])
        );
    });

    it("excludes the bin and the backups, whatever else changes", () => {
        const paths = dataPaths(config());
        const derived = derivedDataDirs(config());

        expect(derived).not.toContain(paths.trash);
        expect(derived).not.toContain(paths.backups);
        expect(derived).not.toContain(paths.database);
    });

    it("excludes the captures, which nothing can rebuild", () => {
        // This list decides what is excluded from backups and what the orphan sweep may
        // touch. A still somebody framed by hand belongs in neither category, whatever a
        // reset does with it.
        expect(derivedDataDirs(config())).not.toContain(dataPaths(config()).captures);
    });
});

/**
 * What a reset empties, which is a different question from what can be rebuilt.
 *
 * A reset destroys every `Media` row and the next scan writes fresh UUIDs, so nothing
 * written before it can ever be named again. Captures are not merely unreferenced
 * afterwards -- they are unreferenceable, and the orphan sweep will never reclaim them
 * because it only visits items that exist (§13d).
 */
describe("resetDataDirs", () => {
    it("empties the captures as well as everything derived", () => {
        const paths = dataPaths(config());

        expect(new Set(resetDataDirs(config()))).toEqual(
            new Set([
                paths.art,
                paths.variants,
                paths.hls,
                paths.sidecars,
                paths.ocrTune,
                paths.embed,
                paths.faces,
                paths.tileprints,
                paths.segments,
                paths.captures,
            ])
        );
    });

    it("still spares the bin, the backups and the database", () => {
        const paths = dataPaths(config());
        const emptied = resetDataDirs(config());

        // The bin is the line this command has always refused to cross without --force:
        // those bytes came out of a media root and exist nowhere else, so losing them loses
        // something the app did not create. Losing a capture loses work, which is worse
        // than housekeeping and better than that.
        expect(emptied).not.toContain(paths.trash);
        expect(emptied).not.toContain(paths.backups);
        expect(emptied).not.toContain(paths.database);
    });
});

describe("countFilesUnder", () => {
    const given = (relPath: string): void => {
        const absolute = path.join(dataDir, relPath);
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, "x");
    };

    it("is zero for a directory that does not exist", () => {
        // The usual state of `hls` and `sidecars` today, and not a problem to report.
        expect(countFilesUnder(path.join(dataDir, "nothing-here"))).toBe(0);
    });

    it("counts through the fan-out directories artifacts are stored in", () => {
        given("art/ab/abcd-1/cover.jpg");
        given("art/ab/abcd-1/preview.webm");
        given("art/cd/cdef-2/cover.jpg");

        expect(countFilesUnder(path.join(dataDir, "art"))).toBe(3);
    });

    it("counts directories as containers rather than as files", () => {
        mkdirSync(path.join(dataDir, "art", "ab", "empty"), { recursive: true });

        expect(countFilesUnder(path.join(dataDir, "art"))).toBe(0);
    });
});

describe("countDerivedFiles", () => {
    it("adds up every rebuildable directory and no others", () => {
        const paths = dataPaths(config());

        for (const dir of [paths.art, paths.variants, paths.trash, paths.backups]) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, "one"), "x");
        }

        // Two derived, and the two irreplaceable files are not counted — a reset reports
        // what it is about to delete, so counting the bin here would overstate it.
        expect(countDerivedFiles(config())).toBe(2);
    });
});
