import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Borrowing a byte-identical copy's work (§10f).
 *
 * The failure that matters is silent: an item showing pictures that are not its own, or a
 * borrowed file that vanishes when the twin is deleted. So these check what is borrowed, what
 * is refused, and that what is borrowed belongs to the borrower afterwards.
 */

interface StageRow {
    state: "done" | "empty" | "failed" | "skipped";
    version: number;
    attempts: number;
    recipe?: string | null;
}

interface Row {
    mediaId: string;
    kind: string;
    ordinal: number;
    relPath: string;
    source: "auto" | "user";
    generatorVersion: number;
    width: number | null;
    height: number | null;
    tileCount: number | null;
    intervalMs: number | null;
    bytes: number | null;
    atMs: number | null;
}

let dataDir: string;
let twins: string[] = [];
let stages: Record<string, StageRow> = {};
let artifacts: Row[] = [];
let upserted: Row[] = [];

vi.mock("@private-stock/core/server", () => ({
    loadConfig: () => ({ dataDir }),
}));

vi.mock("@private-stock/db", () => ({
    db: { transaction: <T>(fn: () => T) => fn },
    mediaFileRepo: { identicalMediaIds: () => twins },
    stageRepo: { find: (mediaId: string, stage: string) => stages[`${mediaId}:${stage}`] },
    artifactRepo: {
        listForMedia: (mediaId: string) => artifacts.filter((row) => row.mediaId === mediaId),
        upsert: (input: Row) => {
            upserted.push(input);
            return input;
        },
    },
}));

const { adoptArtifacts, placeDataFile, settledTwin } = await import("./twin.js");
const { artifactRelPath, findStage } = await import("@private-stock/core");

const COVER_VERSION = findStage("cover")!.version;

const artifact = (mediaId: string, kind: string, ordinal: number, over: Partial<Row> = {}): Row => {
    const relPath = artifactRelPath(mediaId, kind, ordinal);
    const absolute = path.join(dataDir, relPath);

    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${mediaId}/${kind}-${ordinal}`);

    return {
        mediaId,
        kind,
        ordinal,
        relPath,
        source: "auto",
        generatorVersion: 1,
        width: 640,
        height: 360,
        tileCount: null,
        intervalMs: null,
        bytes: 10,
        atMs: 1000 * ordinal,
        ...over,
    };
};

beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ps-twin-"));
    twins = [];
    stages = {};
    artifacts = [];
    upserted = [];
});

afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
});

describe("settledTwin", () => {
    it("finds a twin whose stage is done at the current version", () => {
        twins = ["twin"];
        stages["twin:cover"] = { state: "done", version: COVER_VERSION, attempts: 1 };

        expect(settledTwin("file", "cover")).toEqual({ mediaId: "twin", state: "done" });
    });

    it("carries an empty outcome over, since the bytes are the same", () => {
        twins = ["twin"];
        stages["twin:cover"] = { state: "empty", version: COVER_VERSION, attempts: 1 };

        expect(settledTwin("file", "cover")?.state).toBe("empty");
    });

    it("does not borrow a failure, an old recipe, or nothing at all", () => {
        twins = ["failed", "stale", "never"];
        stages["failed:cover"] = { state: "failed", version: COVER_VERSION, attempts: 9 };
        stages["stale:cover"] = { state: "done", version: COVER_VERSION - 1, attempts: 1 };

        expect(settledTwin("file", "cover")).toBeNull();
    });

    it("refuses a twin read under other settings, when the stage depends on them", () => {
        // OCR: borrowing text read under older settings would hide the change behind it.
        twins = ["old", "current"];
        stages["old:cover"] = {
            state: "done",
            version: COVER_VERSION,
            attempts: 1,
            recipe: "settings-1",
        };
        stages["current:cover"] = {
            state: "done",
            version: COVER_VERSION,
            attempts: 1,
            recipe: "settings-2",
        };

        expect(
            settledTwin("file", "cover", { current: "settings-2", unrecordedAs: "settings-0" })
                ?.mediaId
        ).toBe("current");
        expect(
            settledTwin("file", "cover", { current: "settings-3", unrecordedAs: "settings-0" })
        ).toBeNull();
        // An outcome from before recipes counts as the defaults' revision.
        stages["old:cover"] = { state: "done", version: COVER_VERSION, attempts: 1, recipe: null };
        expect(
            settledTwin("file", "cover", { current: "settings-0", unrecordedAs: "settings-0" })
                ?.mediaId
        ).toBe("old");
        // A stage that records no recipe ignores it.
        expect(settledTwin("file", "cover")?.mediaId).toBe("old");
    });

    it("skips an unsuitable twin for a suitable one", () => {
        twins = ["stale", "good"];
        stages["stale:cover"] = { state: "done", version: COVER_VERSION - 1, attempts: 1 };
        stages["good:cover"] = { state: "done", version: COVER_VERSION, attempts: 1 };

        expect(settledTwin("file", "cover")?.mediaId).toBe("good");
    });
});

describe("adoptArtifacts", () => {
    it("copies the generated files to this item's own paths, and records them as its own", async () => {
        artifacts = [
            artifact("twin", "cover", 0, { generatorVersion: 7 }),
            artifact("twin", "poster", 1),
        ];

        const rows = await adoptArtifacts("mine", "twin", () => true);

        expect(rows).toHaveLength(2);
        expect(upserted.map((row) => row.relPath)).toEqual([
            artifactRelPath("mine", "cover", 0),
            artifactRelPath("mine", "poster", 1),
        ]);
        // The recipe that made the file, not the borrower's current one.
        expect(upserted[0]).toMatchObject({ mediaId: "mine", generatorVersion: 7, atMs: 0 });
        expect(readFileSync(path.join(dataDir, artifactRelPath("mine", "cover", 0)), "utf8")).toBe(
            "twin/cover-0"
        );
    });

    it("never takes somebody's own work", async () => {
        artifacts = [
            artifact("twin", "cover", 0),
            artifact("twin", "capture", 1, { source: "user" }),
        ];

        await adoptArtifacts("mine", "twin", () => true);

        expect(upserted.map((row) => row.kind)).toEqual(["cover"]);
    });

    it("gives up, recording nothing, when a twin's file has gone", async () => {
        const gone = artifact("twin", "preview", 0);
        rmSync(path.join(dataDir, gone.relPath));
        artifacts = [gone];

        expect(await adoptArtifacts("mine", "twin", () => true)).toBeNull();
        expect(upserted).toEqual([]);
    });

    it("has nothing to borrow when the twin has no matching rows", async () => {
        artifacts = [artifact("twin", "cover", 0)];

        expect(await adoptArtifacts("mine", "twin", (row) => row.kind === "preview")).toBeNull();
    });
});

describe("placeDataFile", () => {
    it("links when asked, so a large rendition costs no disk", async () => {
        mkdirSync(path.join(dataDir, "variants/tw/twin"), { recursive: true });
        writeFileSync(path.join(dataDir, "variants/tw/twin/websafe.mp4"), "encoded");

        await placeDataFile("variants/tw/twin/websafe.mp4", "variants/mi/mine/websafe.mp4", {
            hardlink: true,
        });

        const placed = path.join(dataDir, "variants/mi/mine/websafe.mp4");

        expect(readFileSync(placed, "utf8")).toBe("encoded");
        expect(statSync(placed).nlink).toBe(2);

        // Deleting the twin's must leave this one's.
        rmSync(path.join(dataDir, "variants/tw/twin/websafe.mp4"));
        expect(existsSync(placed)).toBe(true);
    });

    it("copies otherwise, so rewriting one file in place cannot reach the other", async () => {
        mkdirSync(path.join(dataDir, "art/tw/twin"), { recursive: true });
        writeFileSync(path.join(dataDir, "art/tw/twin/preview.webm"), "clip");

        await placeDataFile("art/tw/twin/preview.webm", "art/mi/mine/preview.webm", {
            hardlink: false,
        });

        expect(statSync(path.join(dataDir, "art/mi/mine/preview.webm")).nlink).toBe(1);
    });

    it("refuses a path that escapes the data directory", async () => {
        await expect(
            placeDataFile("../outside.mp4", "art/mi/mine/x.webp", { hardlink: false })
        ).rejects.toThrow();
    });
});
